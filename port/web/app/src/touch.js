/*
TOUCH.JS

The page's side of the touch controls (TouchControls.jsx): the words of the
game's memory that upstream's touch_input.c reads with port 0's controller
(port/web/src/web_shared.h, web_touch.c), as upstream's own page writes
them. The page writes the stick, the buttons and triggers held, a count of
each one's presses (a tap shorter than a frame still reaches the game) and
the view's swipe; the game writes back when the controls show (the scene),
the game control each button has (the profile's mapping) and the rumble.

	const pad = touchPad();
	pad.stick(x, y);              // -1 to 1 each, y down; (0, 0) at rest
	pad.button(BUTTON.south, true);
	pad.trigger(TRIGGER.right, true);
	pad.look(dx, dy);             // the swipe, in the page's pixels
	pad.scene();                  // { known, menus, on, off }
	pad.control(GAME_BUTTON.a);   // the game control on a button, or -1
	pad.rumble();                 // 0, or 64 to 255

The pad writes nothing until the game's program is there (window.Module
with the game's memory); what is held then is written at the next change.
*/

/* web_shared.h's word indices */
const SCENE = 1;
const RUMBLE = 2;
const BINDINGS_SERIAL = 3;
const BINDINGS = 4;
const STATE = 20;
const PRESSES = 27;
const LOOK = 44;

/* touch_input.c's _touch_scene_* bits */
const SCENE_KNOWN = 1;
const SCENE_MENUS = 2;
const SCENE_ON = 4;
const SCENE_OFF = 8;

/* SDL_GamepadButton, the bits of the state's buttons word; touch_input.c
gives them to the game as the Xbox controller's: south A, east B, west X,
north Y, the shoulders white and black */
export const BUTTON = {
	south: 0, east: 1, west: 2, north: 3,
	back: 4, guide: 5, start: 6,
	leftStick: 7, rightStick: 8,
	leftShoulder: 9, rightShoulder: 10,
	dpadUp: 11, dpadDown: 12, dpadLeft: 13, dpadRight: 14,
};

export const TRIGGER = { left: 1, right: 2 };

/* the game's controller buttons (input.h), which the bindings are by */
export const GAME_BUTTON = {
	a: 0, b: 1, x: 2, y: 3, black: 4, white: 5, leftTrigger: 6, rightTrigger: 7,
	up: 8, down: 9, left: 10, right: 11, start: 12, back: 13, leftStick: 14, rightStick: 15,
};

/* the game's controls (input_abstraction.c's _game_control_*), by the
number a binding has */
export const GAME_CONTROLS = ["Jump", "Type", "Use", "Swap", "Melee", "Light", "Grenade", "Fire", "Pause",
	"Scores", "Crouch", "Zoom"];

const STICK_RANGE = 32767;
/* the view's swipe is in 1/256 of a logical pixel (web_touch.c) */
const LOOK_UNITS = 256;

export function touchPad() {
	/* the game's memory, and where the shared words are in it */
	let words = null;
	let base = 0;
	let buttons = 0;
	let triggers = 0;
	let stickX = 0;
	let stickY = 0;

	function connected() {
		if (words) {
			return true;
		}
		const module = window.Module;
		if (!module?._web_state || !module.HEAPU8) {
			return false;
		}
		words = new Int32Array(module.HEAPU8.buffer);
		base = module._web_state() >> 2;
		return true;
	}

	/* the state touch_input.c reads: the sticks, the triggers, the buttons */
	function write() {
		if (!connected()) {
			return;
		}
		const state = [stickX, stickY, 0, 0, triggers & TRIGGER.left ? STICK_RANGE : 0,
			triggers & TRIGGER.right ? STICK_RANGE : 0, buttons];
		state.forEach((value, index) => Atomics.store(words, base + STATE + index, value));
	}

	/* (a press counted, held for the game's next read: web_touch.c) */
	function press(input) {
		if (connected()) {
			Atomics.add(words, base + PRESSES + input, 1);
		}
	}

	return {
		stick(x, y) {
			stickX = Math.round(Math.max(-1, Math.min(1, x)) * STICK_RANGE);
			stickY = Math.round(Math.max(-1, Math.min(1, y)) * STICK_RANGE);
			write();
		},
		button(index, down) {
			buttons = down ? buttons | (1 << index) : buttons & ~(1 << index);
			if (down) {
				press(index);
			}
			write();
		},
		trigger(bit, down) {
			triggers = down ? triggers | bit : triggers & ~bit;
			if (down) {
				press(bit === TRIGGER.left ? 15 : 16);
			}
			write();
		},
		look(dx, dy) {
			if (connected()) {
				Atomics.add(words, base + LOOK, Math.round(dx * LOOK_UNITS));
				Atomics.add(words, base + LOOK + 1, Math.round(dy * LOOK_UNITS));
			}
		},
		scene() {
			const scene = connected() ? Atomics.load(words, base + SCENE) : 0;
			return {
				known: (scene & SCENE_KNOWN) !== 0,
				menus: (scene & SCENE_MENUS) !== 0,
				on: (scene & SCENE_ON) !== 0,
				off: (scene & SCENE_OFF) !== 0,
			};
		},
		/* the serial of the bindings, which changes with them */
		bindingsSerial() {
			return connected() ? Atomics.load(words, base + BINDINGS_SERIAL) : 0;
		},
		control(gameButton) {
			return connected() && this.bindingsSerial() ? Atomics.load(words, base + BINDINGS + gameButton) : -1;
		},
		rumble() {
			return connected() ? Atomics.load(words, base + RUMBLE) : 0;
		},
		/* everything let go (the page hid the controls, or lost the focus) */
		release() {
			buttons = 0;
			triggers = 0;
			stickX = 0;
			stickY = 0;
			write();
		},
	};
}
