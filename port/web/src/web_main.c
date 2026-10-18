/*
WEB_MAIN.C

The browser build's start: the game data, then the game's own main
(source/shell/shell_xbox.c, renamed halo_main by tools/web_build.py).

main runs on a worker (PROXY_TO_PTHREAD), where the file system's fetch
backend can wait for its downloads. The maps folder is mounted from the web
server: each file is read from maps/<name> next to the page, in chunks, as
the game reads it (HTTP range requests; port/web/worker/worker.js serves them).

The saves (the Xbox's z:, u: and t: drives under /save: xbox_files.c
platform_save_root) are in memory, but for the parts kept in the browser's
Origin Private File System (OPFS, mounted at /persist), which are there from
one visit to the next: each is a symbolic link into /persist (mount_saves).
Where the browser has no OPFS (some private windows), all of it is in memory,
for the visit only.

The game's map cache (z:\cacheNNN.map, about 770 MB: cache_files_windows.c)
is NOT kept, on purpose: it is rebuilt from the maps at each visit rather
than taking that much of the browser's storage, and it cannot go stale when
the maps the server has change. To keep it as well, mount OPFS as /save
itself and drop the links: the first version of this file did.
*/

#include <emscripten/wasmfs.h>
#include <emscripten/emscripten.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#include "web_shared.h"

int halo_main(void);
/* web_crash.c's */
void web_crash_exited(int code);
int web_crash_memory_missing(void);
/* (sys/stat.h's: the game's include paths hide it) */
int mkdir(const char *path, unsigned int mode);

/* the maps of the Xbox game (every version has these) */
static const char *const map_names[] =
{
	"ui.map",
	"a10.map", "a30.map", "a50.map", "b30.map", "b40.map",
	"c10.map", "c20.map", "c40.map", "d20.map", "d40.map",
	"beavercreek.map", "bloodgulch.map", "boardingaction.map", "carousel.map",
	"chillout.map", "damnation.map", "hangemhigh.map", "longest.map",
	"prisoner.map", "putput.map", "ratrace.map", "sidewinder.map", "wizard.map",
};

#define WEB_DATA_ROOT "/game"
#define WEB_SAVE_ROOT "/save"
#define WEB_PERSIST_ROOT "/persist"
/* a map is read from the server in chunks of this size, each one request of
the Worker (port/web/worker/worker.js): the first campaign level, about 130
MB, is 5 of them. (4 MB chunks made 55,000 requests on the launch day.)

No map may be larger than this and at most twice it: Emscripten's fetch
backend (libwasmfs_fetch.js) reads such a file whole, as one chunk of its own
size, but a later read that crosses this size replaces that chunk with this
size's first chunk, and the rest of the file reads as nothing ("There's a
problem with the disc you're using"). With 16 MB, every multiplayer map (19
to 24 MB) was one. With 32 MB they are a chunk each, and ui.map too; the
campaign's (73 MB and more) are read in chunks. */
#define FETCH_CHUNK_SIZE (32 << 20)

static int mount_maps(void)
{
	backend_t fetch = wasmfs_create_fetch_backend("maps", FETCH_CHUNK_SIZE);
	unsigned int index;

	if (!fetch)
		return 0;
	if (wasmfs_create_directory(WEB_DATA_ROOT, 0777, wasmfs_get_backend_by_path("/")) != 0 ||
		wasmfs_create_directory(WEB_DATA_ROOT "/maps", 0555, fetch) != 0)
		return 0;
	for (index = 0; index < sizeof(map_names) / sizeof(*map_names); index++)
	{
		char path[256];

		snprintf(path, sizeof(path), WEB_DATA_ROOT "/maps/%s", map_names[index]);
		if (wasmfs_create_file(path, 0444, fetch) < 0)
			printf("web: cannot create %s\n", path);
	}
	return 1;
}

/* 0 before the saves are mounted, 1 kept in the browser, 2 in memory */
static volatile int saves_persist = 0;

/* the page's: where the saves are (game.js) */
EMSCRIPTEN_KEEPALIVE int web_saves_persist(void)
{
	return saves_persist;
}

/* (OPFS needs a secure context, and its file handles a worker: main's) */
static int opfs_available(void)
{
	return EM_ASM_INT({
		return typeof navigator !== "undefined" && !!navigator.storage &&
			typeof navigator.storage.getDirectory === "function" &&
			typeof FileSystemSyncAccessHandle !== "undefined";
	});
}

/* what the browser keeps, below the save root: the folders, whole (u: holds
the player profiles, z:\saved the playlists and the default profiles), and
the files of z: itself (every one the game names); the rest of z: (the map
cache) is in memory */
static const char *const kept_folders[] = { "u", "t", "z/saved" };
static const char *const kept_files[] =
{
	"z/lastprof.txt", "z/last_solo.txt", "z/lastmpmp.txt", "z/lastmpvr.txt",
	"z/savegame.bin", "z/last_language.dat",
};

static void mount_saves(void)
{
	backend_t memory = wasmfs_get_backend_by_path("/");
	backend_t opfs = opfs_available() ? wasmfs_create_opfs_backend() : NULL;
	unsigned int index;

	wasmfs_create_directory(WEB_SAVE_ROOT, 0777, memory);
	wasmfs_create_directory(WEB_SAVE_ROOT "/z", 0777, memory);
	/* (port_config.c's paths.saves) */
	setenv("HALO_SAVE_ROOT", WEB_SAVE_ROOT, 1);
	if (!opfs || wasmfs_create_directory(WEB_PERSIST_ROOT, 0777, opfs) != 0)
	{
		saves_persist = 2;
		printf("web: the browser cannot keep the saves; they last for this visit only\n");
		return;
	}
	mkdir(WEB_PERSIST_ROOT "/z", 0777);
	for (index = 0; index < sizeof(kept_folders) / sizeof(*kept_folders); index++)
	{
		char target[256], link[256];

		snprintf(target, sizeof(target), WEB_PERSIST_ROOT "/%s", kept_folders[index]);
		snprintf(link, sizeof(link), WEB_SAVE_ROOT "/%s", kept_folders[index]);
		mkdir(target, 0777);
		if (symlink(target, link) != 0)
			printf("web: cannot link %s\n", link);
	}
	/* (a link to a missing file is not followed to create it: the file is
	made first, empty, which the game takes as none) */
	for (index = 0; index < sizeof(kept_files) / sizeof(*kept_files); index++)
	{
		char target[256], link[256];
		FILE *file;

		snprintf(target, sizeof(target), WEB_PERSIST_ROOT "/%s", kept_files[index]);
		snprintf(link, sizeof(link), WEB_SAVE_ROOT "/%s", kept_files[index]);
		if ((file = fopen(target, "ab")) != NULL)
			fclose(file);
		if (symlink(target, link) != 0)
			printf("web: cannot link %s\n", link);
	}
	/* the settings too (port_config.c reads and writes config.toml in the
	data root, HALO_DATA_ROOT under HALO_WEB: main): what the game's
	Settings change, the keys among them, lasts */
	{
		FILE *file;

		if ((file = fopen(WEB_PERSIST_ROOT "/config.toml", "ab")) != NULL)
			fclose(file);
		if (symlink(WEB_PERSIST_ROOT "/config.toml", WEB_DATA_ROOT "/config.toml") != 0)
			printf("web: cannot link " WEB_DATA_ROOT "/config.toml\n");
	}
	saves_persist = 1;
	printf("web: the saves and settings are kept in the browser (OPFS), but for the map cache\n");
}

/* ---------- the page and the shared code (HALO_WEB)

What upstream's browser code in the shared sources asks of its page (its
port/web/src/web_main.c and web_library.js), this page's way. */

/* the words of the game's memory the page reads and writes itself
(web_shared.h): the touch controls (web_touch.c, app/src/touch.js), the
frames shown, whether the game wants the mouse */
volatile int32_t web_shared[WEB_SHARED_WORDS];

EMSCRIPTEN_KEEPALIVE volatile int32_t *web_state(void)
{
	return web_shared;
}

/* sdl_platform.c's, at each frame shown */
void web_frame_shown(void)
{
	__atomic_add_fetch(&web_shared[_web_frames_shown], 1, __ATOMIC_RELAXED);
}

/* The page's, as the game's canvas is clicked: whether the game wants the
mouse (platform_mouse_capture's _web_mouse_wanted). SDL asks the browser for
the pointer lock again at a click once it is lost (Esc, another window), but
from the game's thread, after the click's gesture has gone, and the browser
refuses it: the page asks in the click itself (App.jsx). */
EMSCRIPTEN_KEEPALIVE int web_mouse_wants_capture(void)
{
	return __atomic_load_n(&web_shared[_web_mouse_wanted], __ATOMIC_RELAXED);
}

/* a line for the page (kind 0 a status, 1 a notice, 2 an invite link to
offer, 3 a fatal error, 4 the game quits as the player asked): its log
(game.js print), where the crash reports find it. The game's exits go
through web_crash.c's web_exit already (tools/web_build.py), and the page's
own invites are the rooms' (web_p2p.c). */
void web_js_post(int kind, const char *text)
{
	printf("web: %s%s\n", kind == 3 ? "error: " : kind == 1 ? "notice: " : "", text);
}

/* a question for the player (sdl_platform.c's platform_ask: mods that cannot
be played together, port_mods.c): the page's Module.haloAsk(title, text,
labels, answer) where it has one, which writes the button chosen into
web_shared's _web_answer; else the first button. (The page has no mods
folder yet, so none asks.) */
void web_js_ask(const char *title, const char *text, const char *labels)
{
	MAIN_THREAD_EM_ASM({
		var answer = (index) => Atomics.store(HEAP32, ($3 >> 2) + $4, index);
		if (Module.haloAsk) {
			Module.haloAsk(UTF8ToString($0), UTF8ToString($1), UTF8ToString($2).split("\n"), answer);
		} else {
			answer(0);
		}
	}, title, text, labels, web_shared, _web_answer);
}

/* main.c's main loop under HALO_WEB, which hands each frame to the browser
(emscripten_set_main_loop, renamed to these by tools/web_build.py): here the
frames are run one after another, each suspended until the browser's next
in platform_video_swap (JSPI), as the desktop's loop does */
static volatile int main_loop_cancelled;

void web_main_loop_run(em_callback_func frame, int fps, bool simulate_infinite_loop)
{
	(void)fps;
	(void)simulate_infinite_loop;
	main_loop_cancelled = 0;
	while (!main_loop_cancelled)
		frame();
}

void web_main_loop_cancel(void)
{
	main_loop_cancelled = 1;
}

/* ---------- start */

int main(int argc, char **argv)
{
	(void)argc;
	(void)argv;
	/* (the browser would not give the memory the game needs: the page says
	so, web_crash.c, and nothing is started or downloaded) */
	if (web_crash_memory_missing())
	{
		printf("web: not enough memory for the game\n");
		return 1;
	}
	if (!mount_maps())
	{
		printf("web: cannot mount the game data\n");
		return 1;
	}
	/* the data root (xbox_files.c platform_data_root), which holds the
	maps, and where port_config.c keeps config.toml and finds brokers.txt
	under HALO_WEB (tools/web_build.py embeds it at /) */
	setenv("HALO_DATA_ROOT", WEB_DATA_ROOT, 1);
	if (symlink("/brokers.txt", WEB_DATA_ROOT "/brokers.txt") != 0)
		printf("web: cannot link " WEB_DATA_ROOT "/brokers.txt\n");
	mount_saves();
	chdir(WEB_DATA_ROOT);
	printf("web: the maps are read from the server as the game needs them\n");
	{
		/* (the page is told that the game ended, its Quit: web_crash.c) */
		int code = halo_main();

		web_crash_exited(code);
		return code;
	}
}
