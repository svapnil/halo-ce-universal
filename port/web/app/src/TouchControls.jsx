/*
TOUCHCONTROLS.JSX

The touch controls over the game, for phones and tablets: a stick to move
with on the left, the Xbox controller's buttons on the right, and the pause
menu's and the scoreboard's at the top. The game reads them as upstream's
touch controls (touch.js; port/linux/src/touch_input.c, which moves the
player by the stick and turns the view by the swipe, with
input.touch_aim_assist), with port 0's controller: Settings > Controls Setup
changes what the buttons do, as a real controller's, and the buttons are
named by what they do (the profile's mapping, which the game writes).

The screen between them is the aim: a finger dragged on it turns the view
(touch_input.c's touch_input_look). In the menus, and during a
cinematic, a tap on the canvas is a click (sdl_platform.c's finger events),
and the controls are the menus' (the D-pad, A and B), which the game's text
entry (its on-screen keyboard) takes too.

Shown on a device whose pointer is a finger (pointer: coarse), or from the
first touch on another; not before; and never with input.touch_controls
"off".
*/

import { useEffect, useRef, useState } from "react";
import { BUTTON, GAME_BUTTON, GAME_CONTROLS, TRIGGER, touchPad } from "./touch.js";

/* how often the game is asked whether a menu is up, the buttons' mapping
and the rumble (ms) */
const MENUS_POLL = 100;
/* the phone's vibration while the game rumbles (ms): renewed at each poll */
const VIBRATION_MS = 150;
/* the swipe's units, as upstream's overlay has them (Android's 960 x 540
grid, its units the same size across and down): a swipe across the screen
turns the view as far on any phone */
const GRID_WIDTH = 960;
const GRID_HEIGHT = 540;

/* whether the page is used by touch: a device whose pointer is a finger, or
the first touch on another (a laptop with a touch screen) */
export function useTouchDevice() {
	const [touch, setTouch] = useState(() => matchMedia("(pointer: coarse)").matches);

	useEffect(() => {
		if (touch) {
			return undefined;
		}
		const first = () => setTouch(true);
		window.addEventListener("touchstart", first, { once: true, passive: true });
		return () => window.removeEventListener("touchstart", first);
	}, [touch]);
	return touch;
}

/* mainMenu: the page knows the main menu is up (lobby.js's phase), which
the game says too, but a moment later (its menus come to life after they
are first drawn): the menus' controls meanwhile, not the game's */
export function TouchControls({ mainMenu = false }) {
	const pad = useRef(null);
	const [scene, setScene] = useState({ known: false, menus: true, on: false, off: false });
	const [bindings, setBindings] = useState(0);
	if (!pad.current) {
		pad.current = touchPad();
	}

	useEffect(() => {
		const timer = setInterval(() => {
			const now = pad.current.scene();
			setScene((was) => was.known === now.known && was.menus === now.menus && was.on === now.on &&
				was.off === now.off ? was : now);
			setBindings(pad.current.bindingsSerial());
			if (pad.current.rumble() && navigator.vibrate) {
				navigator.vibrate(VIBRATION_MS);
			}
		}, MENUS_POLL);
		const release = () => pad.current.release();
		window.addEventListener("blur", release);
		return () => {
			clearInterval(timer);
			window.removeEventListener("blur", release);
		};
	}, []);

	/* (the game's own menus, a cinematic, or the chat's on-screen keyboard:
	touch_input.c's scene; until the game says, the menus') */
	const menus = !scene.known || scene.menus || mainMenu;
	useEffect(() => pad.current.release(), [menus, scene.off]);
	if (scene.off) {
		return null;
	}
	return (
		<div className={`touch${menus ? " touch-menus" : ""}`} aria-hidden="true"
			onContextMenu={(event) => event.preventDefault()}>
			{menus ? <MenuControls pad={pad.current} /> : <GameControls pad={pad.current} bindings={bindings} />}
		</div>
	);
}

/* the game's: in the Xbox layout, each button named by the game control the
profile gives it (its default's name until the game says) */
function GameControls({ pad, bindings }) {
	const named = (gameButton, label) => GAME_CONTROLS[pad.control(gameButton)] ?? label;
	/* (the default's second line only while the button does its default) */
	const sub = (gameButton, label, text) => named(gameButton, label) === label ? text : undefined;
	return (
		<>
			<LookArea pad={pad} />
			<Stick pad={pad} />
			<div className="touch-top" data-bindings={bindings}>
				<PadButton pad={pad} button={BUTTON.back} className="touch-small" label={named(GAME_BUTTON.back, "Scores")} />
				<PadButton pad={pad} button={BUTTON.start} className="touch-small touch-start" label={named(GAME_BUTTON.start, "Pause")} />
			</div>
			<div className="touch-right">
				<PadButton pad={pad} button={BUTTON.leftShoulder} className="touch-small touch-light" label={named(GAME_BUTTON.white, "Light")} />
				<PadButton pad={pad} button={BUTTON.rightShoulder} className="touch-small touch-grenade-type" label={named(GAME_BUTTON.black, "Type")} sub={sub(GAME_BUTTON.black, "Type", "grenade")} />
				<PadButton pad={pad} button={BUTTON.north} className="touch-swap" label={named(GAME_BUTTON.y, "Swap")} />
				<PadButton pad={pad} button={BUTTON.west} className="touch-use" label={named(GAME_BUTTON.x, "Use")} sub={sub(GAME_BUTTON.x, "Use", "reload")} />
				<PadButton pad={pad} button={BUTTON.east} className="touch-melee" label={named(GAME_BUTTON.b, "Melee")} />
				<PadButton pad={pad} button={BUTTON.south} className="touch-jump" label={named(GAME_BUTTON.a, "Jump")} />
				<PadButton pad={pad} button={BUTTON.rightStick} className="touch-small touch-zoom" label={named(GAME_BUTTON.rightStick, "Zoom")} />
				<PadButton pad={pad} button={BUTTON.leftStick} className="touch-small touch-crouch" label={named(GAME_BUTTON.leftStick, "Crouch")} />
				<PadButton pad={pad} trigger={TRIGGER.left} className="touch-grenade" label={named(GAME_BUTTON.leftTrigger, "Grenade")} />
				<PadButton pad={pad} trigger={TRIGGER.right} className="touch-fire" label={named(GAME_BUTTON.rightTrigger, "Fire")} />
			</div>
		</>
	);
}

/* the screen behind the controls: a finger dragged on it turns the view
(each finger its own swipe), in the grid's units */
function LookArea({ pad }) {
	const fingers = useRef(new Map());

	function unit() {
		return Math.min(window.innerWidth / GRID_WIDTH, window.innerHeight / GRID_HEIGHT) || 1;
	}

	function lift(event) {
		fingers.current.delete(event.pointerId);
	}

	return (
		<div className="touch-look"
			onPointerDown={(event) => {
				event.preventDefault();
				capture(event);
				fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
			}}
			onPointerMove={(event) => {
				const finger = fingers.current.get(event.pointerId);
				if (!finger) {
					return;
				}
				const size = unit();
				pad.look((event.clientX - finger.x) / size, (event.clientY - finger.y) / size);
				finger.x = event.clientX;
				finger.y = event.clientY;
			}}
			onPointerUp={lift}
			onPointerCancel={lift}
			onLostPointerCapture={lift} />
	);
}

/* the menus': the D-pad, A (choose) and B (back) */
function MenuControls({ pad }) {
	return (
		<div className="touch-menu">
			<div className="touch-dpad">
				<PadButton pad={pad} button={BUTTON.dpadUp} className="touch-dpad-up" label="▲" />
				<PadButton pad={pad} button={BUTTON.dpadLeft} className="touch-dpad-left" label="◀" />
				<PadButton pad={pad} button={BUTTON.dpadRight} className="touch-dpad-right" label="▶" />
				<PadButton pad={pad} button={BUTTON.dpadDown} className="touch-dpad-down" label="▼" />
			</div>
			<PadButton pad={pad} button={BUTTON.east} className="touch-b" label="B" sub="back" />
			<PadButton pad={pad} button={BUTTON.south} className="touch-a" label="A" sub="choose" />
		</div>
	);
}

/* the finger that lands on a control stays its own until it lifts, wherever
it moves (pointer capture; refused while the mouse is locked to the canvas,
a touch screen beside a mouse: the control then follows the finger as far
as the browser sends it) */
function capture(event) {
	try {
		event.currentTarget.setPointerCapture(event.pointerId);
	} catch {
		// (the finger is still down on it)
	}
}

/* a button held while a finger is on it */
function PadButton({ pad, button, trigger, className, label, sub }) {
	const [down, setDown] = useState(false);

	function hold(held) {
		setDown(held);
		if (trigger !== undefined) {
			pad.trigger(trigger, held);
		} else {
			pad.button(button, held);
		}
	}

	return (
		<div className={`touch-button ${className}${down ? " touch-down" : ""}`}
			onPointerDown={(event) => {
				event.preventDefault();
				capture(event);
				hold(true);
			}}
			onPointerUp={() => hold(false)}
			onPointerCancel={() => hold(false)}
			onLostPointerCapture={() => down && hold(false)}>
			<span className="touch-label">{label}</span>
			{sub && <span className="touch-sub">{sub}</span>}
		</div>
	);
}

/* the stick's knob stays within this of its centre (px, of the page) */
const STICK_TRAVEL = 44;

/* the left stick: the finger that lands on it moves its knob, up to
STICK_TRAVEL from the centre; let go, it springs back */
function Stick({ pad }) {
	const [knob, setKnob] = useState({ x: 0, y: 0 });
	const base = useRef(null);
	const finger = useRef(null);

	function moveTo(event) {
		const bounds = base.current.getBoundingClientRect();
		let x = event.clientX - (bounds.left + bounds.width / 2);
		let y = event.clientY - (bounds.top + bounds.height / 2);
		const length = Math.hypot(x, y);
		if (length > STICK_TRAVEL) {
			x *= STICK_TRAVEL / length;
			y *= STICK_TRAVEL / length;
		}
		setKnob({ x, y });
		pad.stick(x / STICK_TRAVEL, y / STICK_TRAVEL);
	}

	function release() {
		finger.current = null;
		setKnob({ x: 0, y: 0 });
		pad.stick(0, 0);
	}

	return (
		<div ref={base} className={`touch-stick${finger.current !== null ? " touch-down" : ""}`}
			onPointerDown={(event) => {
				if (finger.current !== null) {
					return;
				}
				event.preventDefault();
				finger.current = event.pointerId;
				capture(event);
				moveTo(event);
			}}
			onPointerMove={(event) => event.pointerId === finger.current && moveTo(event)}
			onPointerUp={(event) => event.pointerId === finger.current && release()}
			onPointerCancel={(event) => event.pointerId === finger.current && release()}
			onLostPointerCapture={(event) => event.pointerId === finger.current && release()}>
			<div className="touch-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
		</div>
	);
}
