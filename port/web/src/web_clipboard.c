/*
WEB_CLIPBOARD.C

The game's clipboard in the browser (platform.h's platform_clipboard_get and
platform_clipboard_set, in place of sdl_platform.c's, which
tools/web_build.py renames out of the way): the PC menus' Copy Invite and
Direct Link's PASTE LINK, and their text fields' Ctrl+V. The game runs on a
worker, which has no navigator.clipboard: both go to the page's main thread.

Reading asks the browser, which may ask the player once whether the page
may see the clipboard; a player who says no pastes nothing (the menus say
so). The game reads it only when asked to (the page sets
network.join_from_clipboard off: app/src/game.js), not each time it comes
to the front.
*/

#include "platform.h"

#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <stdio.h>
#include <string.h>

enum
{
	CLIPBOARD_SIZE = 1024,
	/* milliseconds to wait for the browser (and the player, if it asks) */
	READ_WAIT = 10000,
};

/* what the page read: done is raised, and notified, once text is there */
static char read_text[CLIPBOARD_SIZE];
static int read_done;

void platform_clipboard_set(const char *text)
{
	MAIN_THREAD_EM_ASM({
		const text = UTF8ToString($0);
		navigator.clipboard?.writeText(text).catch((error) => console.warn(`clipboard: ${error.message}`));
	}, text ? text : "");
}

int platform_clipboard_get(char *text, int size)
{
	double deadline = emscripten_get_now() + READ_WAIT;

	__atomic_store_n(&read_done, 0, __ATOMIC_RELEASE);
	read_text[0] = 0;
	MAIN_THREAD_EM_ASM({
		const finish = (text) => {
			stringToUTF8(text, $0, $1);
			Atomics.store(HEAP32, $2 >> 2, 1);
			Atomics.notify(HEAP32, $2 >> 2);
		};
		if (!navigator.clipboard?.readText) {
			finish("");
			return;
		}
		navigator.clipboard.readText().then(finish, (error) => {
			console.warn(`clipboard: ${error.message}`);
			finish("");
		});
	}, read_text, (int)sizeof(read_text), &read_done);
	while (!__atomic_load_n(&read_done, __ATOMIC_ACQUIRE))
	{
		double left = deadline - emscripten_get_now();

		if (left <= 0)
			break;
		emscripten_futex_wait(&read_done, 0, left);
	}
	if (!__atomic_load_n(&read_done, __ATOMIC_ACQUIRE))
		read_text[0] = 0;
	snprintf(text, (size_t)size, "%s", read_text);
	return text[0] != 0;
}
