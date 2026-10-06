/* The player's name, for the lobby's chat (Chat.jsx): their Halo profile's,
read from what the browser keeps of the saves (web_main.c's mount_saves:
OPFS, whose root is the game's /persist). A profile is a folder of
u:\UDATA, named by a hash of its name (xbox_xapi.c's XCreateSaveGame), with
a blam.sav (a game variant's has a blam.lst instead), whose first 24 bytes
are its player_profile's player_name: UTF-16LE, 11 characters and a NUL
(source/saved games/player_profile.h).

Which profile: the one the game last played as (z:\lastprof.txt, its
folder's path), else the first there is (by folder name: OPFS keeps no
order); none, and the chat's "New001", the game's first untitled name.
The game may have a file open as this reads (its worker's sync access
handles): what cannot be read now is read at the next look. */

export const DEFAULT_NAME = "New001";

/* a folder's entry by name, whatever its case (the game's paths ignore it,
xbox_files.c), or null */
async function entry(directory, name, kind) {
	for await (const [key, handle] of directory.entries()) {
		if (handle.kind === kind && key.toLowerCase() === name.toLowerCase()) {
			return handle;
		}
	}
	return null;
}

async function profileName(folder) {
	const save = await entry(folder, "blam.sav", "file");
	if (!save) {
		return null;
	}
	const bytes = new Uint8Array(await (await save.getFile()).slice(0, 24).arrayBuffer());
	const name = new TextDecoder("utf-16le").decode(bytes).split("\0")[0].trim();
	return name || null;
}

/* the player's profile's name, or null where there is none (or no OPFS) */
export async function readProfileName() {
	try {
		const root = await navigator.storage.getDirectory();
		const profiles = await entry(root, "u", "directory").then((u) => u && entry(u, "UDATA", "directory"));
		if (!profiles) {
			return null;
		}
		let last = null;
		try {
			const file = await entry(await entry(root, "z", "directory"), "lastprof.txt", "file");
			last = /([0-9A-F]{12})/i.exec(await (await file.getFile()).text())?.[1]?.toLowerCase() ?? null;
		} catch {
			// (none yet)
		}
		const folders = [];
		for await (const [key, handle] of profiles.entries()) {
			if (handle.kind === "directory") {
				folders.push([key, handle]);
			}
		}
		folders.sort(([a], [b]) => (a.toLowerCase() === last ? -1 : b.toLowerCase() === last ? 1 : a.localeCompare(b)));
		for (const [, folder] of folders) {
			const name = await profileName(folder);
			if (name) {
				return name;
			}
		}
		return null;
	} catch {
		return null;
	}
}

/* Calls onName(name) with the player's name, now and as it changes (a
profile made, renamed or chosen in the game's menus): it looks again every
15 seconds while the page is shown. Returns a function that stops it. */
export function watchProfileName(onName) {
	let known = null;
	let stopped = false;

	async function look() {
		if (stopped || document.hidden) {
			return;
		}
		const name = (await readProfileName()) ?? DEFAULT_NAME;
		if (!stopped && name !== known) {
			known = name;
			onName(name);
		}
	}

	look();
	const timer = setInterval(look, 15_000);
	document.addEventListener("visibilitychange", look);
	return () => {
		stopped = true;
		clearInterval(timer);
		document.removeEventListener("visibilitychange", look);
	};
}
