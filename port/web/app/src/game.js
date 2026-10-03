/*
GAME.JS

Starts the game (halo.js and halo.wasm, from `ninja web`) on a canvas, once
per page.

The game takes the canvas over: main runs on a worker (PROXY_TO_PTHREAD),
which draws on the canvas through an OffscreenCanvas. The page must thus keep
the same canvas element for as long as the page is open, and size it with CSS
only.
*/

let started = false;

/* onStatus receives Emscripten's status lines (loading, errors) */
export function startGame(canvas, onStatus) {
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
			new URLSearchParams(location.search).forEach((value, name) => {
				if (name.startsWith("HALO_")) {
					window.ENV[name] = value || "1";
				}
			});
		}],
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
