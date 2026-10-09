/*
GAME.JS

Starts the game (halo.js and halo.wasm, from `ninja web`) on a canvas, once
per page.

The game takes the canvas over: main runs on a worker (PROXY_TO_PTHREAD),
which draws on the canvas through an OffscreenCanvas. The page must thus keep
the same canvas element for as long as the page is open, and size it with CSS
only.
*/

import { logLine, mark, watchGame } from "./crash.js";
import { setPlaying } from "./keys.js";
import { startLoading } from "./loading.js";
import { startLobby } from "./lobby.js";
import { startNetBridge } from "./net_bridge.js";
import { startRelayBridge } from "./relay_bridge.js";
import { sfuTransport } from "./sfu_transport.js";
import { tabTransport } from "./tab_transport.js";

let started = false;

/* Why this browser cannot run the game ({ title, text }), or null where it
can. The game suspends each frame (JSPI: sdl_platform.c's
web_wait_for_frame), which Chrome 137, Firefox 153, Safari 27 and iOS 27
have; before them, halo.js threw at its first line (launch day: 400 such
reports, most from Safari 26 and iOS 26). An iPhone's or iPad's browsers
are all Safari's engine: the system's update is the way. */
export function browserSupport() {
	if (typeof WebAssembly.Suspending === "function") {
		return null;
	}
	const agent = navigator.userAgent;
	/* (an iPad asks for desktop pages, as a Mac with a touch screen) */
	const apple = /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
	if (apple) {
		return { title: "This game needs iOS 27 or later",
			text: "Update your iPhone or iPad in Settings > General > Software Update, then come back in any browser." };
	}
	if (/Android/.test(agent)) {
		return { title: "This game needs Chrome 137 or later",
			text: "Update Chrome in the Play Store, then come back." };
	}
	return { title: "This browser cannot run the game yet",
		text: "It needs Chrome 137, Edge 137, Firefox 153 or Safari 27, or later." };
}

/* a desktop build's invite (halo://join/...) the page was opened with
(#native=<invite>), or null */
function nativeInvite() {
	const match = /#native=(.+)$/.exec(location.hash);
	return match ? decodeURIComponent(match[1]) : null;
}

/* writes text into the game's memory at address (NUL-terminated, cut to
size) */
function writeText(module, address, size, text) {
	const encoded = new TextEncoder().encode(text).subarray(0, size - 1);
	module.HEAPU8.fill(0, address, address + size);
	module.HEAPU8.set(encoded, address);
}

/* The browsers' games, for the game's server browser (NETWORK.md,
"Browsers' games in the server browser"): the lobby's list (online.js's
onGames) written where web_p2p.c's p2p_lobby_games reads it, struct
web_room_games: magic, version, sequence, count, then the games, each a
struct web_room_game of ROOM_GAME_SIZE bytes. The sequence is raised before
and after the writing (odd while it goes on), for the game's reads. */
const ROOM_GAMES_MAGIC = 0x47414d53;
const ROOM_GAMES_VERSION = 1;
const ROOM_GAMES_SEQUENCE = 8;
const ROOM_GAMES_COUNT = 12;
const ROOM_GAMES_FIRST = 16;
const ROOM_GAMES_MAXIMUM = 64;
/* struct web_room_game's fields */
const ROOM_GAME_INVITE = 0;
const ROOM_GAME_INVITE_SIZE = 32;
const ROOM_GAME_IDENTIFIER = 32;
const ROOM_GAME_ENGINE = 38;
const ROOM_GAME_FLAGS = 39;
const ROOM_GAME_PLAYERS = 40;
const ROOM_GAME_MAXIMUM_PLAYERS = 41;
const ROOM_GAME_NAME = 42;
const ROOM_GAME_NAME_SIZE = 32;
const ROOM_GAME_MAP = 74;
const ROOM_GAME_MAP_SIZE = 32;
const ROOM_GAME_GAMETYPE = 106;
const ROOM_GAME_GAMETYPE_SIZE = 24;
const ROOM_GAME_SIZE = 132;
/* web_p2p.c's _game_open, _game_in_progress, _game_teams */
const GAME_OPEN = 1;
const GAME_IN_PROGRESS = 2;
const GAME_TEAMS = 4;
/* the game's engines, as the server names them (net_bridge.js's readGame,
by index: 0 is co-op's) */
const ENGINES = ["coop", "ctf", "slayer", "oddball", "king", "race"];

/* the list as the lobby last gave it, and the writer once the game runs */
let roomGames = [];
let writeRoomGames = null;

/* the browsers' games as the lobby has them (online.js): to the game's
server browser, less this page's own game and those of another network
version (which a room refuses) */
export function listGames(games) {
	roomGames = games;
	writeRoomGames?.();
}

function roomGamesWriter(module) {
	const base = module._web_p2p_room_games();
	const bridge = module._web_p2p_bridge();
	const view = new DataView(module.HEAPU8.buffer);
	if (view.getUint32(base, true) !== ROOM_GAMES_MAGIC || view.getUint32(base + 4, true) !== ROOM_GAMES_VERSION) {
		throw new Error("game.js does not match this build of web_p2p.c (the room games)");
	}
	/* (net_bridge.js: the identifier, then the network version) */
	const own = Array.from(module.HEAPU8.subarray(bridge + 16, bridge + 22), (b) => b.toString(16).padStart(2, "0")).join("");
	const netVersion = view.getUint16(bridge + 22, true);
	const encoder = new TextEncoder();

	function text(bytes, at, size, value) {
		bytes.fill(0, at, at + size);
		bytes.set(encoder.encode(String(value ?? "")).subarray(0, size - 1), at);
	}

	function hex(bytes, at, value) {
		for (let index = 0; index < 6; index++) {
			bytes[at + index] = parseInt(String(value).substr(index * 2, 2), 16) || 0;
		}
	}

	return () => {
		const bytes = module.HEAPU8;
		const words = new Int32Array(bytes.buffer);
		const listed = roomGames.filter((game) => game.hostId !== own && game.netVersion === netVersion &&
			/^[0-9A-HJKMNP-TV-Z]{8}$/.test(game.room) && /^[A-Za-z0-9_-]{22}$/.test(game.secret))
			.slice(0, ROOM_GAMES_MAXIMUM);
		Atomics.add(words, (base + ROOM_GAMES_SEQUENCE) >> 2, 1);
		listed.forEach((game, index) => {
			const at = base + ROOM_GAMES_FIRST + index * ROOM_GAME_SIZE;
			bytes.fill(0, at, at + ROOM_GAME_SIZE);
			text(bytes, at + ROOM_GAME_INVITE, ROOM_GAME_INVITE_SIZE, `${game.room}.${game.secret}`);
			hex(bytes, at + ROOM_GAME_IDENTIFIER, game.hostId);
			bytes[at + ROOM_GAME_ENGINE] = Math.max(0, ENGINES.indexOf(game.engine));
			bytes[at + ROOM_GAME_FLAGS] = (game.open ? GAME_OPEN : 0) | (game.inProgress ? GAME_IN_PROGRESS : 0) |
				(game.teams ? GAME_TEAMS : 0);
			bytes[at + ROOM_GAME_PLAYERS] = Math.min(255, Math.max(0, game.players | 0));
			bytes[at + ROOM_GAME_MAXIMUM_PLAYERS] = Math.min(255, Math.max(0, game.maximumPlayers | 0));
			text(bytes, at + ROOM_GAME_NAME, ROOM_GAME_NAME_SIZE, game.name);
			text(bytes, at + ROOM_GAME_MAP, ROOM_GAME_MAP_SIZE, game.map);
			text(bytes, at + ROOM_GAME_GAMETYPE, ROOM_GAME_GAMETYPE_SIZE, game.gametype);
		});
		Atomics.store(words, (base + ROOM_GAMES_COUNT) >> 2, listed.length);
		Atomics.add(words, (base + ROOM_GAMES_SEQUENCE) >> 2, 1);
	};
}

/* halo.wasm's size when the page was built; 0 if it was not there */
const PROGRAM_SIZE = typeof __PROGRAM_SIZE__ === "undefined" ? 0 : __PROGRAM_SIZE__;
/* halo.js's and halo.wasm's paths: the copies named by their content's
hash (vite.config.js), which a browser keeps for good */
const PROGRAM_JS = typeof __PROGRAM_JS__ === "undefined" ? "/halo.js" : __PROGRAM_JS__;
const PROGRAM_WASM = typeof __PROGRAM_WASM__ === "undefined" ? "/halo.wasm" : __PROGRAM_WASM__;

/* The game's program, instantiated as halo.js would by itself (compiled as
it comes), but for its bytes being counted on the way, for the loading
panel: received(bytes, size), the size being 0 when it is not known. The
browser compiles the server's own answer, and the count reads a copy of it:
the browser keeps the compiled code for the next visit with that answer, as
it did (not with one made here from the counted bytes). */
async function instantiateProgram(address, imports, received) {
	const response = await fetch(address, { credentials: "same-origin" });
	if (!response.ok) {
		throw new Error(`${address}: ${response.status}`);
	}
	/* (a compressed answer's length is not the program's: the page's build
	knows that one, vite.config.js) */
	const size = response.headers.has("Content-Encoding") ? PROGRAM_SIZE :
		Number(response.headers.get("Content-Length")) || PROGRAM_SIZE;
	const reader = response.clone().body.getReader();
	(async () => {
		for (let count = 0; ;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			count += value.byteLength;
			received(count, size);
		}
	})().catch(() => {});
	return WebAssembly.instantiateStreaming(response, imports);
}

/* joins a browser's game by its invite from the page itself (the lobby
chat's game cards): at once, in this page, if the game is at its main menu
(as an invite the page was opened with: the link to the host, then the game
joins it); false otherwise (in a game, or the menus: the page is to be
opened with the invite instead) */
let joinFromPage = () => false;
export function joinInvite(invite) {
	return joinFromPage(invite);
}

/* onStatus receives Emscripten's status lines (loading, errors); onNet,
network play's ({ state, invite, players, error, relay }: sfu_transport.js,
and relay_bridge.js's state as relay); onLobby, the game's phase while it
joins from an invite ({ phase, message }: lobby.js); onLoading, what the
game waits for, or null ({ what, percent }: loading.js) */
export function startGame(canvas, { onStatus, onNet = () => {}, onLobby = () => {}, onLoading = () => {} }) {
	if (started) {
		return;
	}
	started = true;

	if (!crossOriginIsolated) {
		onStatus("This page needs cross-origin isolation (COOP and COEP headers): serve it with `npm run dev` (port/web/README.md).");
		return;
	}
	/* (App.jsx shows the panel instead of the game; this is for a page
	that starts the game anyway) */
	const unsupported = browserSupport();
	if (unsupported) {
		onStatus(`${unsupported.title}. ${unsupported.text}`);
		return;
	}
	const loading = startLoading(onLoading);
	/* (crash.js reports it, and CrashPanel.jsx says that the game stopped) */
	window.addEventListener("error", (event) => onStatus(`Error: ${event.message}`));

	// halo.js reads its settings from the global Module
	window.Module = {
		canvas,
		// Settings: any HALO_* query parameter becomes an environment variable,
		// which port_config.c reads (?HALO_GL_DEBUG=1&HALO_GPU_STATS=1, say).
		preRun: [() => {
			// The game starts windowed: its own fullscreen would take the bare
			// canvas fullscreen at the first click, hiding the page's panels
			// over it (App.jsx); the page's fullscreen button takes the whole
			// screen, panels and all.
			window.ENV.HALO_FULLSCREEN = "0";
			// The clipboard is read when the menus' PASTE LINK asks
			// (web_clipboard.c), not each time the game comes to the front,
			// which would have the browser ask the player each time.
			window.ENV.HALO_NET_JOIN_FROM_CLIPBOARD = "0";
			// No Halo Custom Edition maps (game.custom_edition): the page has
			// no custom_maps folder to put them in, and WebGL 2 cannot sample
			// their textures' channel orders (xbox_textures.c). The map lists
			// have no CUSTOM kinds (menu_functions.c), and a game on one is
			// refused with a word to that effect.
			window.ENV.HALO_CUSTOM_EDITION = "0";
			new URLSearchParams(location.search).forEach((value, name) => {
				if (name.startsWith("HALO_")) {
					window.ENV[name] = value || "1";
				}
			});
			// a desktop build's invite, which the game joins as its internet
			// play starts (web_p2p_select.c)
			const invite = nativeInvite();
			if (invite) {
				window.ENV.HALO_NET_NATIVE_INVITE = invite;
			}
		}],
		// Network play (NETWORK.md): a game the game hosts for the internet gets
		// a room, whose invite (#join=<room>.<secret>) joins it from another
		// browser (sfu_transport.js); ?net=tabs links this page's game to the
		// game's other pages in this browser instead, as one LAN
		// (tab_transport.js). Desktop builds' games go through the relay
		// (relay_bridge.js), which the page reaches only once the game does.
		onRuntimeInitialized: () => {
			const module = window.Module;
			const invite = /#join=([^&]+)/.exec(location.hash)?.[1] || null;
			let net = { state: "idle" };
			let relay = null;
			/* the relay's cap on what the peers send, once they went past it
			(relay_bridge.js); kept for the session, forgotten with it */
			let relayCapped = 0;
			const report = () => {
				mark(`network ${net.state}${net.error ? `: ${net.error}` : ""}${relay ? `, relay ${relay}` : ""}` +
					`${relayCapped ? `, capped at ${relayCapped} bytes a second` : ""}`);
				onNet({ ...net, relay, relayCapped });
			};
			watchGame(module);
			loading.game(module);
			/* (once the link to a host is up, the game joins its game: once
			for each room joined) */
			let joinAsked = false;
			/* the room's invite, for the game's menus to show and copy
			(web_p2p.c's p2p_invite_link) */
			const roomInvite = module._web_p2p_room_invite();
			/* the browsers' games, for the menus' server browser (listGames) */
			writeRoomGames = roomGamesWriter(module);
			writeRoomGames();
			const onTransport = (status) => {
				if (status.state === "joined" && !joinAsked) {
					joinAsked = true;
					lobby.join();
				} else if (status.state !== "joined") {
					joinAsked = false;
				}
				const hosted = status.state === "hosting" && status.invite ? status.invite : "";
				if (hosted && hosted !== net.invite) {
					console.log(`room: hosting, invite ${hosted}`);
				}
				if (!!status.reconnecting !== !!net.reconnecting) {
					console.log(status.reconnecting ? "room: the signalling is lost, connecting again" : "room: the signalling is back");
				}
				writeText(module, roomInvite, 256, hosted);
				net = status;
				report();
			};
			/* (at the main menu the saves are mounted: web_main.c; where the
			browser cannot keep them, the player is told) */
			let savesChecked = false;
			/* a desktop build's game is joined from the main menu: the game's
			internet play reaches its host meanwhile, whose game the search
			then finds (web_lobby.c searches for a while; asked again should
			it find none). But for the network tests', which join by
			themselves (HALO_NETWORK_TEST) */
			let nativeJoins = nativeInvite() && !window.ENV.HALO_NETWORK_TEST ? 3 : 0;
			let phase = "other";
			const lobby = startLobby(module, (status) => {
				phase = status.phase;
				if (status.phase === "main-menu" && !savesChecked) {
					savesChecked = true;
					if (module._web_saves_persist() === 2) {
						onStatus("This browser cannot keep saved games: profiles and progress last for this visit only.");
					}
				}
				if (nativeJoins > 0 && (status.phase === "main-menu" || status.phase === "failed")) {
					nativeJoins--;
					lobby.join();
				}
				mark(`game ${status.phase}${status.message ? `: ${status.message}` : ""}`);
				/* (in a game, the browser asks before the page goes: keys.js) */
				setPlaying(status.phase !== "main-menu" && status.phase !== "failed");
				onLobby(status);
			});
			startRelayBridge(module, {
				onStatus: (status) => {
					if (status.state === "capped") {
						relayCapped = status.bytesPerSecond;
					} else {
						relay = status.state === "error" ? `error: ${status.error}` : status.state;
						if (status.state === "connected") {
							relayCapped = 0;
						}
					}
					report();
				},
			});
			const transport = new URLSearchParams(location.search).get("net") === "tabs" ?
				tabTransport() : sfuTransport({ invite, onStatus: onTransport });
			startNetBridge(module, transport);
			joinFromPage = (invite) => {
				if (phase !== "main-menu" || !transport.join) {
					return false;
				}
				transport.join(invite);
				return true;
			};
		},
		// (kept for a crash's report, and ?debug's Save log: crash.js)
		print: (text) => {
			logLine(text);
			console.log(text);
		},
		printErr: (text) => {
			logLine(text);
			console.warn(text);
		},
		setStatus: onStatus,
		// halo.js's own way, but for the loading panel being told of the
		// program's bytes as they come
		instantiateWasm: (imports, receive) => {
			instantiateProgram(PROGRAM_WASM, imports, loading.program).then(
				({ instance, module }) => receive(instance, module),
				/* (unhandled: crash.js takes it for the game's end, as it
				does halo.js's own failure to load its program) */
				(error) => {
					throw new Error(`Cannot load halo.wasm: ${error.message}`);
				});
			return {};
		},
	};

	// a classic script, so that the game's threads find halo.js by
	// document.currentScript (each thread is a worker made from it)
	const script = document.createElement("script");
	script.src = PROGRAM_JS;
	script.onerror = () => {
		loading.stop();
		onStatus("Cannot load halo.js: build it with `ninja web`.");
	};
	document.body.appendChild(script);
}
