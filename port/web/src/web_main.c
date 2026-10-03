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
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int halo_main(void);
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
	saves_persist = 1;
	printf("web: the saves are kept in the browser (OPFS), but for the map cache\n");
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
	mount_saves();
	/* the data root is the current directory when it holds maps
	(xbox_files.c) */
	chdir(WEB_DATA_ROOT);
	printf("web: the maps are read from the server as the game needs them\n");
	return halo_main();
}
