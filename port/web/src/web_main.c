/*
WEB_MAIN.C

The browser build's start: the game data, then the game's own main
(source/shell/shell_xbox.c, renamed halo_main by tools/web_build.py).

main runs on a worker (PROXY_TO_PTHREAD), where the file system's fetch
backend can wait for its downloads. The maps folder is mounted from the web
server: each file is read from maps/<name> next to the page, in chunks, as
the game reads it (HTTP range requests; port/web/worker/worker.js serves them).
*/

#include <emscripten/wasmfs.h>
#include <stdio.h>
#include <unistd.h>

int halo_main(void);

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
#define FETCH_CHUNK_SIZE (4 << 20)

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

int main(int argc, char **argv)
{
	(void)argc;
	(void)argv;
	if (!mount_maps())
	{
		printf("web: cannot mount the game data\n");
		return 1;
	}
	/* the data root is the current directory when it holds maps
	(xbox_files.c) */
	chdir(WEB_DATA_ROOT);
	printf("web: the maps are read from the server as the game needs them\n");
	return halo_main();
}
