/*
LOBBY.JS

The page's side of the browser's online games (port/web/src/web_lobby.c;
NETWORK.md, "The lobby"): what the game's menus show, and asking the game to
host a game or to join the linked host's.

The game writes its phase to a mailbox in its memory and notifies
event_sequence; the page writes a request there and raises
request_sequence, which the game reads once a frame.

	const lobby = startLobby(Module, ({ phase, message }) => ...);
	lobby.host("bloodgulch", "slayer", { startNow: true });
	lobby.start();    // a game waiting in the lobby
	lobby.join();

phase: "other", "main-menu", "multiplayer-menu" (the game's Multiplayer menu
opened), "starting", "lobby" (hosting, waiting in the game's lobby for the
host to start), "hosting" (the game runs), "joining", "joined", "failed"
(message says why).
*/

const MAGIC = 0x4c4f4259;
const VERSION = 2;
/* struct web_lobby_mailbox (web_lobby.c) */
const REQUEST_SEQUENCE = 8;
const REQUEST = 12;
const MAP = 16;
const VARIANT = 48;
const OPTIONS = 80;
const EVENT_SEQUENCE = 84;
const PHASE = 88;
const MESSAGE = 92;
const OPTION_START_NOW = 1;
const NAME_SIZE = 32;
const MESSAGE_SIZE = 128;

const PHASES = ["other", "main-menu", "multiplayer-menu", "starting", "hosting", "joining", "joined", "failed", "lobby"];
const REQUESTS = { host: 1, join: 2, start: 3 };

/* the multiplayer maps (their file names) and what the game calls them */
export const MAPS = [
	["bloodgulch", "Blood Gulch"],
	["sidewinder", "Sidewinder"],
	["hangemhigh", "Hang 'Em High"],
	["damnation", "Damnation"],
	["beavercreek", "Battle Creek"],
	["ratrace", "Rat Race"],
	["prisoner", "Prisoner"],
	["chillout", "Chill Out"],
	["boardingaction", "Boarding Action"],
	["carousel", "Derelict"],
	["longest", "Longest"],
	["putput", "Chiron TL-34"],
	["wizard", "Wizard"],
];

/* the game's built-in game types (game_engine_get_variant_by_name) */
export const GAME_TYPES = [
	["slayer", "Slayer"],
	["team_slayer", "Team Slayer"],
	["ctf", "Capture the Flag"],
	["king", "King of the Hill"],
	["oddball", "Oddball"],
	["race", "Race"],
];

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

	function writeName(offset, text) {
		const encoded = new TextEncoder().encode(text).subarray(0, NAME_SIZE - 1);
		bytes.fill(0, base + offset, base + offset + NAME_SIZE);
		bytes.set(encoded, base + offset);
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

	function request(kind, map = "", variant = "", options = 0) {
		writeName(MAP, map);
		writeName(VARIANT, variant);
		Atomics.store(words, (base + OPTIONS) >> 2, options);
		Atomics.store(words, (base + REQUEST) >> 2, REQUESTS[kind]);
		/* (last: the game reads the rest once it sees this change) */
		Atomics.add(words, (base + REQUEST_SEQUENCE) >> 2, 1);
	}

	readLoop();
	return {
		host(map, gameType, { startNow = true } = {}) {
			request("host", map, gameType, startNow ? OPTION_START_NOW : 0);
		},
		start() {
			request("start");
		},
		join() {
			request("join");
		},
	};
}
