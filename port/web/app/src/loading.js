/*
LOADING.JS

Whether the game is waiting for its data, and how much of it has come: the
page's loading panel (App.jsx). While it waits the game draws nothing new:
the picture is black, or stands still.

The game waits twice over:

- as it starts, for its program (halo.wasm, which game.js fetches and tells
  of here) and then for the menus' map, before its first frame;
- later, for a map from the server (port/web/src/web_main.c): a level as it
  starts, or the start of one that the menus read ahead. The game's thread
  is then in a read that has not returned, or in the game's own wait for
  the map (game.c's game_precache_new_map), and its frames (crash.js) stand
  still while a request for a map is out (src/web_loading.c, whose state
  the game's threads keep: src/web_pre.js).

A map the game reads ahead while the menus run is not waited for, and is
not shown.

	const loading = startLoading((state) => ...);
	loading.program(received, size);
	loading.game(Module);
	loading.stop();

state: null, or { what: "game" or "map", percent } (percent: 0 to 100, or
null when the size is not known).
*/

import { frameCount, gameAlive } from "./crash.js";

const MAGIC = 0x4c4f4144;
const VERSION = 1;
/* struct web_loading_state (web_loading.c), in words */
const REQUESTS = 2;
const SIZE = 3;
const RECEIVED = 4;

const POLL_INTERVAL = 100;
/* frames standing still this long, with a map on its way, is a wait (ms):
shorter ones are not worth a panel */
const STALL_TIME = 400;
/* the program's part of the start; the rest is the menus' map (the two are
about as large) */
const PROGRAM_SHARE = 0.4;

export function startLoading(onLoading) {
	/* the game's memory, and where the state is in it */
	let words = null;
	let base = 0;
	let program = 0;
	let lastFrames = null;
	let lastReceived = 0;
	let moved = performance.now();
	/* a request for a map was out since the frames last moved */
	let waited = false;
	let told = null;

	function tell(state) {
		if (state?.what !== told?.what || state?.percent !== told?.percent) {
			told = state;
			onLoading(state);
		}
	}

	function poll() {
		const frames = frameCount();
		const requests = words ? Atomics.load(words, base + REQUESTS) : 0;
		const size = words ? Atomics.load(words, base + SIZE) : 0;
		const received = words ? Atomics.load(words, base + RECEIVED) : 0;
		const part = size ? Math.min(received / size, 1) : null;

		if (received !== lastReceived) {
			lastReceived = received;
			/* (a slow map is not a game that hangs) */
			gameAlive();
		}
		if (!frames) {
			/* (the only map so far is the menus') */
			tell({ what: "game", percent: Math.floor(100 * (PROGRAM_SHARE * program + (1 - PROGRAM_SHARE) * (part ?? 0))) });
			return;
		}
		if (frames !== lastFrames || document.visibilityState !== "visible") {
			lastFrames = frames;
			moved = performance.now();
			waited = false;
		} else if (requests > 0) {
			waited = true;
		}
		/* (shown until the frames move again: between two ranges no request
		is out, and after the last the game has the map to take in) */
		tell(waited && performance.now() - moved >= STALL_TIME ?
			{ what: "map", percent: part === null ? null : Math.floor(100 * part) } : null);
	}

	const timer = setInterval(poll, POLL_INTERVAL);
	poll();

	/* nothing more to wait for */
	function stop() {
		clearInterval(timer);
		tell(null);
	}
	/* (crash.js: the game stopped, and CrashPanel.jsx says so) */
	window.addEventListener("halo-stopped", stop);

	return {
		/* the program's bytes, as they come (size: 0 if not known) */
		program(received, size) {
			program = size ? Math.min(received / size, 1) : 0;
		},
		/* the program is there, and the game's memory with it */
		game(module) {
			const at = module._web_loading_state();
			const view = new Uint32Array(module.HEAPU8.buffer);
			program = 1;
			if (view[at >> 2] !== MAGIC || view[(at >> 2) + 1] !== VERSION) {
				console.warn("loading.js does not match this build of web_loading.c");
				return;
			}
			words = view;
			base = at >> 2;
		},
		/* the game will not start */
		stop,
	};
}
