/*
TOUCH.JS

The page's side of the touch controls' gamepad (port/web/src/web_touch.c):
a block of the game's memory (struct web_touch_state) that the page writes
as the player's fingers move, and that the game reads into an SDL gamepad
before each pump of its events. The game writes one word back: whether a
menu is up (the page then shows the menus' controls).

	const pad = touchPad();
	pad.stick(x, y);              // -1 to 1 each, y down; (0, 0) at rest
	pad.button(BUTTON.south, true);
	pad.trigger(TRIGGER.right, true);
	pad.menus();                  // true while a menu is up

The pad writes nothing until the game's program is there (window.Module
with the game's memory); what is held then is written at the next change.
*/

const MAGIC = 0x544f5543;
const VERSION = 1;
/* struct web_touch_state, in words */
const TOUCHED = 2;
const STICK_X = 3;
const STICK_Y = 4;
const BUTTONS = 5;
const TRIGGERS = 6;
const MENUS = 7;

/* SDL_GamepadButton; the game sees the Xbox controller's: south A, east B,
west X, north Y, the shoulders white and black */
export const BUTTON = {
	south: 0, east: 1, west: 2, north: 3,
	back: 4, guide: 5, start: 6,
	leftStick: 7, rightStick: 8,
	leftShoulder: 9, rightShoulder: 10,
	dpadUp: 11, dpadDown: 12, dpadLeft: 13, dpadRight: 14,
};

/* web_touch.c's trigger bits */
export const TRIGGER = { left: 1, right: 2 };

const STICK_RANGE = 32767;

export function touchPad() {
	/* the game's memory, and where the state is in it (words) */
	let words = null;
	let base = 0;
	let buttons = 0;
	let triggers = 0;

	function connected() {
		if (words) {
			return true;
		}
		const module = window.Module;
		if (!module?._web_touch_state || !module.HEAPU8) {
			return false;
		}
		const at = module._web_touch_state();
		const view = new Int32Array(module.HEAPU8.buffer);
		if (view[at >> 2] !== MAGIC || view[(at >> 2) + 1] !== VERSION) {
			console.warn("touch.js does not match this build of web_touch.c");
			return false;
		}
		words = view;
		base = at >> 2;
		return true;
	}

	function write(word, value) {
		if (connected()) {
			Atomics.store(words, base + word, value);
			Atomics.store(words, base + TOUCHED, 1);
		}
	}

	return {
		stick(x, y) {
			write(STICK_X, Math.round(Math.max(-1, Math.min(1, x)) * STICK_RANGE));
			write(STICK_Y, Math.round(Math.max(-1, Math.min(1, y)) * STICK_RANGE));
		},
		button(index, down) {
			buttons = down ? buttons | (1 << index) : buttons & ~(1 << index);
			write(BUTTONS, buttons);
		},
		trigger(bit, down) {
			triggers = down ? triggers | bit : triggers & ~bit;
			write(TRIGGERS, triggers);
		},
		menus() {
			return connected() && Atomics.load(words, base + MENUS) !== 0;
		},
	};
}
