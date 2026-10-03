/*
GAME.JS

Starts the game (halo.js and halo.wasm, from `ninja web`) on a canvas, once
per page.

The game takes the canvas over: main runs on a worker (PROXY_TO_PTHREAD),
which draws on the canvas through an OffscreenCanvas. The page must thus keep
the same canvas element for as long as the page is open, and size it with CSS
only.
*/

import { startLobby } from "./lobby.js";
import { startNetBridge } from "./net_bridge.js";
import { sfuTransport } from "./sfu_transport.js";
import { tabTransport } from "./tab_transport.js";

let started = false;
let lobby = null;
let transport = null;

/* online games, for the page's menus (App.jsx) */
export const online = {
	/* hosts a game, which starts at once, or waits in the game's lobby
	until start(); its room's invite comes through onNet */
	host(map, gameType, options) {
		lobby?.host(map, gameType, options);
	},
	start() {
		lobby?.start();
	},
	/* joins the game of an invite: the page links to its host, then the game
	joins (onRuntimeInitialized) */
	join(invite) {
		transport?.join?.(invite);
	},
};

/* onStatus receives Emscripten's status lines (loading, errors); onNet,
network play's ({ state, invite, players, error }: sfu_transport.js);
onLobby, the game's online phase ({ phase, message }: lobby.js) */
export function startGame(canvas, { onStatus, onNet = () => {}, onLobby = () => {} }) {
	if (started) {
		return;
	}
	started = true;

	if (!crossOriginIsolated) {
		onStatus("This page needs cross-origin isolation (COOP and COEP headers): serve it with `npm run dev` (port/web/README.md).");
		return;
	}
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
			new URLSearchParams(location.search).forEach((value, name) => {
				if (name.startsWith("HALO_")) {
					window.ENV[name] = value || "1";
				}
			});
		}],
		// Network play (NETWORK.md): a game the game hosts gets a room, whose
		// invite (#join=<room>.<secret>) joins it from another browser
		// (sfu_transport.js); ?net=tabs links this page's game to the game's
		// other pages in this browser instead, as one LAN (tab_transport.js)
		onRuntimeInitialized: () => {
			const invite = /#join=([^&]+)/.exec(location.hash)?.[1] || null;
			/* (once the link to a host is up, the game joins its game: once
			for each room joined) */
			let joinAsked = false;
			const onTransport = (status) => {
				if (status.state === "joined" && !joinAsked) {
					joinAsked = true;
					lobby.join();
				} else if (status.state !== "joined") {
					joinAsked = false;
				}
				onNet(status);
			};
			lobby = startLobby(window.Module, onLobby);
			transport = new URLSearchParams(location.search).get("net") === "tabs" ?
				tabTransport() : sfuTransport({ invite, onStatus: onTransport });
			startNetBridge(window.Module, transport);
		},
		print: (text) => console.log(text),
		printErr: (text) => console.warn(text),
		setStatus: onStatus,
	};

	// a classic script, so that the game's threads find halo.js by
	// document.currentScript
	const script = document.createElement("script");
	script.src = "/halo.js";
	script.onerror = () => onStatus("Cannot load halo.js: build it with `ninja web`.");
	document.body.appendChild(script);
}
