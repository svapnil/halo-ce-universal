/*
KEYS.JS

Keeps the game's keys from the browser. A game's keys are a browser's
shortcuts: Ctrl is crouch and W is forward, and Ctrl+W closes the tab; R
reloads the weapon, and Ctrl+R the page. Three things, as no one of them
covers it:

- every key pressed on the game's canvas is kept from the browser
  (keepFromBrowser), which stops the shortcuts a page may stop: Ctrl+S, D,
  F, G, R and the rest, Tab, Space, the arrows, F1, F11;
- a few a page may not stop in a tab: Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Q. In
  fullscreen the browser gives a page those too, if it asks for their keys
  (the Keyboard Lock API, in Chrome and Edge): asked, whenever the page is
  fullscreen, with Esc, which then goes to the game (its pause menu) and,
  held, leaves fullscreen. Tab is not asked for, so that Alt+Tab stays the
  system's (and Ctrl+Tab the browser's): switching to another window
  leaves fullscreen and lets the mouse go, as do F11 and the page's button;
- and when the page is about to go while a game is being played (Ctrl+W
  out of fullscreen, Ctrl+R in a browser that lets it by, the window's
  close), the browser asks first (beforeunload).
*/

import { stoppedState } from "./crash.js";

/* whether a key pressed on the game's canvas is kept from the browser:
all, but the Command key's own (a Mac's shortcuts, which the game's keys
are not) and F12 (the browser's tools). SDL takes the keys on the game's
thread, after the browser has acted, so the canvas keeps them itself; the
game still gets them (its text comes of the keys, not of the browser's
input). */
export function keepFromBrowser(event) {
	return !event.metaKey && event.code !== "F12";
}

/* the keys asked of the browser in fullscreen: those of the shortcuts a
page cannot stop otherwise (Ctrl+W, T, N, Q), and Esc. Not Tab: with it
the page would take Alt+Tab too */
const LOCKED_KEYS = ["KeyW", "KeyT", "KeyN", "KeyQ", "Escape"];

let playing = false;

/* game.js's: whether a game is being played (not the main menu) */
export function setPlaying(isPlaying) {
	playing = isPlaying;
}

export function startKeyGuard() {
	document.addEventListener("fullscreenchange", () => {
		if (document.fullscreenElement) {
			navigator.keyboard?.lock?.(LOCKED_KEYS).catch(() => {});
		} else {
			navigator.keyboard?.unlock?.();
		}
	});
	/* another window taken (Alt+Tab): out of fullscreen, and the mouse let
	go, so that coming back is to a page, not to a captured screen */
	window.addEventListener("blur", () => {
		if (document.fullscreenElement) {
			document.exitFullscreen().catch(() => {});
		}
		if (document.pointerLockElement) {
			document.exitPointerLock();
		}
	});
	window.addEventListener("beforeunload", (event) => {
		/* (a game that has stopped is left with its Reload) */
		if (playing && !stoppedState()) {
			event.preventDefault();
			event.returnValue = "";
		}
	});
}
