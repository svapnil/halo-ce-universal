/*
WEB_STUBS.C

What the platform layer and the game call that the browser build's C
library and SDL do not have.
*/

#include <errno.h>
#include <sys/types.h>
#include <unistd.h>

#include <SDL3/SDL.h>

/* posix_net.c's random bytes (it reads /dev/urandom where this fails) */
ssize_t getrandom(void *buffer, size_t size, unsigned int flags)
{
	(void)flags;
	if (size > 256)
		size = 256;
	return getentropy(buffer, size) == 0 ? (ssize_t)size : -1;
}

/* posix_net.c runs programs (UPnP helpers); a page cannot */
int posix_spawnp(pid_t *process, const char *file, const void *actions, const void *attributes,
	char *const arguments[], char *const environment[])
{
	(void)process;
	(void)file;
	(void)actions;
	(void)attributes;
	(void)arguments;
	(void)environment;
	return ENOSYS;
}

/* sdl_platform.c offers to copy the maps out of a disc image; Emscripten's
SDL has no file dialog, so the choice is always cancelled (the browser build
reads the maps from its server: web_main.c) */
void SDL_ShowOpenFileDialog(SDL_DialogFileCallback callback, void *userdata, SDL_Window *window,
	const SDL_DialogFileFilter *filters, int filter_count, const char *default_location, bool allow_many)
{
	(void)window;
	(void)filters;
	(void)filter_count;
	(void)default_location;
	(void)allow_many;
	callback(userdata, NULL, -1);
}

/* scenario.c declares MSVC's compiler barrier, an intrinsic only on x86 */
void _ReadWriteBarrier(void)
{
	__atomic_signal_fence(__ATOMIC_SEQ_CST);
}
