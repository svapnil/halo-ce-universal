/*
LOBBY.JS

The page's side of joining a game from an invite link
(port/web/src/web_lobby.c; NETWORK.md, "The lobby"): where the game is, and
asking it to join the game of the host the page has linked to. The game's
own menus (the PC version's) do the rest of online play, as on the desktop.

The game writes its phase to a mailbox in its memory and notifies
event_sequence; the page writes a request there and raises
request_sequence, which the game reads once a frame.

	const lobby = startLobby(Module, ({ phase, message }) => ...);
	lobby.join();

phase: "other", "main-menu" (the main menu is up), "joining", "joined",
"failed" (message says why).
*/

const MAGIC = 0x4c4f4259;
const VERSION = 3;
/* struct web_lobby_mailbox (web_lobby.c) */
const REQUEST_SEQUENCE = 8;
const REQUEST = 12;
const EVENT_SEQUENCE = 16;
const PHASE = 20;
const MESSAGE = 24;
const MESSAGE_SIZE = 128;

const PHASES = ["other", "main-menu", "joining", "joined", "failed"];
const REQUESTS = { join: 1 };

export function startLobby(module, onPhase) {
	const base = module._web_lobby_mailbox();
	const buffer = module.HEAPU8.buffer;
	const bytes = new Uint8Array(buffer);
	const words = new Int32Array(buffer);
	const view = new DataView(buffer);
	if (view.getUint32(base, true) !== MAGIC || view.getUint32(base + 4, true) !== VERSION) {
		throw new Error("lobby.js does not match this build of web_lobby.c");
	}

	function readText(offset, size) {
		const raw = bytes.slice(base + offset, base + offset + size);
		const end = raw.indexOf(0);
		return new TextDecoder().decode(raw.subarray(0, end < 0 ? size : end));
	}

	async function readLoop() {
		let seen = Atomics.load(words, (base + EVENT_SEQUENCE) >> 2);
		for (;;) {
			const wait = Atomics.waitAsync(words, (base + EVENT_SEQUENCE) >> 2, seen);
			if (wait.async) {
				await wait.value;
			}
			seen = Atomics.load(words, (base + EVENT_SEQUENCE) >> 2);
			const phase = PHASES[Atomics.load(words, (base + PHASE) >> 2)] || "other";
			onPhase({ phase, message: readText(MESSAGE, MESSAGE_SIZE) });
		}
	}

	function request(kind) {
		Atomics.store(words, (base + REQUEST) >> 2, REQUESTS[kind]);
		/* (last: the game reads the rest once it sees this change) */
		Atomics.add(words, (base + REQUEST_SEQUENCE) >> 2, 1);
	}

	readLoop();
	return {
		join() {
			request("join");
		},
	};
}
