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
import { startRelayBridge } from "./relay_bridge.js";
import { sfuTransport } from "./sfu_transport.js";
import { tabTransport } from "./tab_transport.js";

let started = false;
let lobby = null;
let transport = null;

/* a desktop build's invite (halo://join/...) the page was opened with
(#native=<invite>), or null */
function nativeInvite() {
	const match = /#native=(.+)$/.exec(location.hash);
	return match ? decodeURIComponent(match[1]) : null;
}

/* native games (NETWORK.md, "Native games"): the desktop's internet play,
through the relay, to join a desktop build's game (#native=<invite>) */
function playsNative() {
	return nativeInvite() !== null;
}

/* whether text holds a desktop build's invite (as p2p.c's parse_invite
takes it: a link) */
const NATIVE_INVITE = /halo:\/\/join\/[0-9a-f]{64}/i;
export function isNativeInvite(text) {
	return NATIVE_INVITE.test(text);
}

/* a game the page was started again to host, with browsers' internet play
(#host=<map>.<game type>.<now or wait>), or null */
function hostRequest() {
	const match = /#host=([a-z0-9_]+)\.([a-z0-9_]+)\.(now|wait)$/.exec(location.hash);
	return match ? { map: match[1], gameType: match[2], startNow: match[3] === "now" } : null;
}

/* the game's internet play is chosen as it starts (web_p2p_select.c): to
play the other kind, the page starts again, at this address */
function restartAt(address) {
	const target = new URL(address, location.origin);
	const samePage = target.pathname + target.search === location.pathname + location.search;
	location.assign(target);
	/* (a change of the fragment alone loads nothing) */
	if (samePage) {
		location.reload();
	}
}

/* online games, for the page's menus (App.jsx) */
export const online = {
	/* hosts a game, which starts at once, or waits in the game's lobby
	until start(); its invite comes through onNet. (Games are hosted for
	browsers only: a page that joined a desktop build's starts again) */
	host(map, gameType, options) {
		if (playsNative()) {
			restartAt(`/#host=${map}.${gameType}.${options.startNow ? "now" : "wait"}`);
			return;
		}
		lobby?.host(map, gameType, options);
	},
	start() {
		lobby?.start();
	},
	/* joins the game of an invite: the page links to its host, then the game
	joins (onRuntimeInitialized); a desktop build's invite starts the page
	again, to join with the desktop's internet play */
	join(invite) {
		if (isNativeInvite(invite)) {
			restartAt(`/#native=${encodeURIComponent(invite.match(NATIVE_INVITE)[0])}`);
		} else if (playsNative()) {
			restartAt(`/#join=${encodeURIComponent(invite)}`);
		} else {
			transport?.join?.(invite);
		}
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
			// (web_p2p_select.c chooses the game's internet play from these)
			if (playsNative()) {
				window.ENV.HALO_NET_NATIVE = "1";
				const invite = nativeInvite();
				if (invite) {
					window.ENV.HALO_NET_NATIVE_INVITE = invite;
				}
			}
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
			/* (at the main menu the saves are mounted: web_main.c; where the
			browser cannot keep them, the player is told) */
			let savesChecked = false;
			/* a native invite's game is joined from the main menu: the game's
			internet play reaches its host meanwhile, whose game the search
			then finds (web_lobby.c searches for a while; asked again should
			it find none) */
			const native = playsNative();
			/* (but for the network tests', which join by themselves: HALO_NETWORK_TEST) */
			let nativeJoins = native && nativeInvite() && !window.ENV.HALO_NETWORK_TEST ? 3 : 0;
			/* (a game the page was started again to host: hosted from the main
			menu, once) */
			let hostAsked = hostRequest();
			lobby = startLobby(window.Module, (status) => {
				if (status.phase === "main-menu" && !savesChecked) {
					savesChecked = true;
					if (window.Module._web_saves_persist() === 2) {
						onStatus("This browser cannot keep saved games: profiles and progress last for this visit only.");
					}
				}
				if (nativeJoins > 0 && (status.phase === "main-menu" || status.phase === "failed")) {
					nativeJoins--;
					lobby.join();
				}
				if (hostAsked && status.phase === "main-menu") {
					lobby.host(hostAsked.map, hostAsked.gameType, { startNow: hostAsked.startNow });
					hostAsked = null;
					history.replaceState(null, "", location.pathname + location.search);
				}
				onLobby(status);
			});
			if (native) {
				startRelayBridge(window.Module, { onStatus: (status) => onNet({ ...status, state: `relay-${status.state}` }) });
				return;
			}
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
