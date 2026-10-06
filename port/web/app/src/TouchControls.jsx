/*
TOUCHCONTROLS.JSX

The touch controls over the game, for phones and tablets: a stick to move
with on the left, the Xbox controller's buttons on the right, and the pause
menu's and the scoreboard's at the top. They are the game's controller
(touch.js, port/web/src/web_touch.c): the game sees an Xbox controller with
its default layout, and its Settings > Controls Setup changes what the
buttons do, as a real controller's. The buttons are named by their
default actions.

The canvas between them is the aim: a finger dragged on it turns the view
(sdl_platform.c's finger events). In the menus a tap on the canvas is a
click, and the controls are the menus' (the D-pad, A and B), which the
game's text entry (its on-screen keyboard) takes too.

Shown on a device whose pointer is a finger (pointer: coarse), or from the
first touch on another; not before.
*/

import { useEffect, useRef, useState } from "react";
import { BUTTON, TRIGGER, touchPad } from "./touch.js";

/* how often the game is asked whether a menu is up (ms) */
const MENUS_POLL = 100;

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
	const [gameMenus, setGameMenus] = useState(false);
	if (!pad.current) {
		pad.current = touchPad();
	}

	useEffect(() => {
		const timer = setInterval(() => setGameMenus(pad.current.menus()), MENUS_POLL);
		return () => clearInterval(timer);
	}, []);

	const menus = gameMenus || mainMenu;
	return (
		<div className={`touch${menus ? " touch-menus" : ""}`} aria-hidden="true"
			onContextMenu={(event) => event.preventDefault()}>
			{menus ? <MenuControls pad={pad.current} /> : <GameControls pad={pad.current} />}
		</div>
	);
}

/* the game's: as config.toml's [controls] defaults and the Xbox layout */
function GameControls({ pad }) {
	return (
		<>
			<Stick pad={pad} />
			<div className="touch-top">
				<PadButton pad={pad} button={BUTTON.back} className="touch-small" label="Scores" />
				<PadButton pad={pad} button={BUTTON.start} className="touch-small touch-start" label="Pause" />
			</div>
			<div className="touch-right">
				<PadButton pad={pad} button={BUTTON.leftShoulder} className="touch-small touch-light" label="Light" />
				<PadButton pad={pad} button={BUTTON.rightShoulder} className="touch-small touch-grenade-type" label="Type" sub="grenade" />
				<PadButton pad={pad} button={BUTTON.north} className="touch-swap" label="Swap" />
				<PadButton pad={pad} button={BUTTON.west} className="touch-use" label="Use" sub="reload" />
				<PadButton pad={pad} button={BUTTON.east} className="touch-melee" label="Melee" />
				<PadButton pad={pad} button={BUTTON.south} className="touch-jump" label="Jump" />
				<PadButton pad={pad} button={BUTTON.rightStick} className="touch-small touch-zoom" label="Zoom" />
				<PadButton pad={pad} button={BUTTON.leftStick} className="touch-small touch-crouch" label="Crouch" />
				<PadButton pad={pad} trigger={TRIGGER.left} className="touch-grenade" label="Grenade" />
				<PadButton pad={pad} trigger={TRIGGER.right} className="touch-fire" label="Fire" />
			</div>
		</>
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
