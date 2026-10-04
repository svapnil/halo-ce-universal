import { memo, useEffect, useRef, useState } from "react";
import { startGame } from "./game.js";

/* The game's canvas. It never re-renders: the game owns it once started
(game.js). */
const GameCanvas = memo(function GameCanvas({ onStatus, onNet, onLobby }) {
	const canvas = useRef(null);

	useEffect(() => {
		canvas.current.focus();
		startGame(canvas.current, { onStatus, onNet, onLobby });
	}, []);

	return (
		<canvas
			ref={canvas}
			id="canvas"
			className="game-canvas"
			tabIndex={0}
			onContextMenu={(event) => event.preventDefault()}
			onPointerDown={(event) => {
				event.currentTarget.focus();
				captureMouse(event.currentTarget);
			}}
			onKeyDown={(event) => GAME_KEYS.has(event.code) && event.preventDefault()}
			// the keyboard back from a panel over the game, which kept the
			// releases of keys pressed before it (sdl_platform.c's
			// web_reset_keyboard); not there before the game has started
			onFocus={() => window.Module?._web_reset_keyboard?.()}
		/>
	);
}, () => true);

/* The game's keys that the browser also acts on (Tab leaves the canvas,
Space and the arrows scroll, F1 opens help, F11 makes the browser's window
fullscreen). SDL means to keep them from the browser, but it sees them on
the game's thread, after the browser has acted: the canvas keeps them
itself. (The game still gets them: its F11 asks for the page's fullscreen,
as the button does: sdl_platform.c's web_page_fullscreen.) */
const GAME_KEYS = new Set([
	"Tab", "Space", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "F1", "F11",
]);

/* the pointer lock back at a click on the game, while the game wants the
mouse (sdl_platform.c's web_mouse_wants_capture): only a request in the
click's own handler is granted */
function captureMouse(canvas) {
	if (document.pointerLockElement === canvas || !window.Module?._web_mouse_wants_capture?.()) {
		return;
	}
	// (refused for a moment after Esc frees the mouse: the next click again)
	Promise.resolve(canvas.requestPointerLock()).catch(() => {});
}

export default function App() {
	const frame = useRef(null);
	const [status, setStatus] = useState("");
	const [net, setNet] = useState(null);
	const [lobby, setLobby] = useState({ phase: "other", message: "" });
	const [fullscreen, setFullscreen] = useState(false);
	const [controlsOpen, setControlsOpen] = useState(false);
	/* the notice's answer: the game starts only once it is confirmed */
	const [notice, setNotice] = useState(() => noticeConfirmed() ? "confirmed" : "pending");

	useEffect(() => {
		const update = () => setFullscreen(document.fullscreenElement === frame.current);
		document.addEventListener("fullscreenchange", update);
		/* the game's F11, and its Settings' fullscreen (detail: 1 on, 0 off,
		-1 switch): the page's fullscreen, as the button's */
		const fromGame = (event) => setPageFullscreen(event.detail);
		window.addEventListener("halo-fullscreen", fromGame);
		return () => {
			document.removeEventListener("fullscreenchange", update);
			window.removeEventListener("halo-fullscreen", fromGame);
		};
	}, []);

	/* on: true, false, or -1 to switch */
	function setPageFullscreen(on) {
		const now = Boolean(document.fullscreenElement);
		const want = on === -1 ? !now : Boolean(on);
		if (want && !now) {
			frame.current.requestFullscreen().catch((error) => setStatus(`Fullscreen: ${error.message}`));
		} else if (!want && now) {
			document.exitFullscreen();
		}
		frame.current.querySelector("canvas").focus();
	}

	function toggleFullscreen() {
		setPageFullscreen(-1);
	}

	/* the game takes the keyboard back when a panel over it closes */
	function focusGame() {
		frame.current.querySelector("canvas").focus();
	}

	return (
		<main className="page">
			<div className="console">
				<div ref={frame} className="screen">
					{notice === "confirmed" ?
						<GameCanvas onStatus={setStatus} onNet={setNet} onLobby={setLobby} /> :
						<OwnershipNotice denied={notice === "denied"} onAnswer={(answer) => {
							if (answer === "confirmed") {
								rememberNoticeConfirmed();
							}
							setNotice(answer);
						}} />}
					<OnlineToast lobby={lobby} net={net} onClose={focusGame} />
					{controlsOpen && <ControlsDialog onClose={() => { setControlsOpen(false); focusGame(); }} />}
				</div>
				<div className="bar">
					<span className="status">{status}</span>
					<NetStatus net={net} />
					<button type="button" className="bar-button" onClick={() => setControlsOpen(!controlsOpen)}
						aria-label="Controls" aria-expanded={controlsOpen} title="Controls">
						<ControlsIcon />
					</button>
					<button type="button" className="bar-button" onClick={toggleFullscreen}
						aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
						title={fullscreen ? "Exit fullscreen (Esc, F11)" : "Fullscreen (F11)"}>
						{fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
					</button>
				</div>
			</div>
		</main>
	);
}

/* The ownership notice's Confirm, kept in the browser so that it is asked
once (a new key when its text changes asks again). A Deny is not kept: the
next visit asks again. Where the browser keeps nothing (storage blocked),
the notice is asked at every visit. */
const NOTICE_KEY = "halo-ownership-notice-v1";

function noticeConfirmed() {
	try {
		return localStorage.getItem(NOTICE_KEY) === "confirmed";
	} catch {
		return false;
	}
}

function rememberNoticeConfirmed() {
	try {
		localStorage.setItem(NOTICE_KEY, "confirmed");
	} catch {
		// (asked again at the next visit)
	}
}

/* Before the game starts, until the player confirms: the site is a fan
project, for those who own the original game. Deny, and the game never
loads. */
function OwnershipNotice({ denied, onAnswer }) {
	if (denied) {
		return (
			<div className="overlay" role="alert">
				<div className="panel">
					<h2 className="panel-title">You are not allowed to use the site</h2>
					<p className="panel-hint">
						This site is only for people who own a copy of the original game.
					</p>
					<button type="button" className="text-button" onClick={() => onAnswer("pending")}>
						Back to the notice
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="overlay" role="dialog" aria-modal="true" aria-labelledby="notice-title"
			aria-describedby="notice-text">
			<div className="panel">
				<h2 id="notice-title" className="panel-title">Before you play</h2>
				<p id="notice-text" className="panel-hint">
					This site is a non-commercial, open source project based on the{" "}
					<a className="notice-link" href="https://github.com/cybersecurity/halo-ce-universal"
						target="_blank" rel="noreferrer">Halo 1 decompilation project</a>.
					To use the site, please certify that you own a copy of the original game.
				</p>
				<div className="notice-buttons">
					<button type="button" className="secondary-button" onClick={() => onAnswer("denied")}>Deny</button>
					<button type="button" className="primary-button" onClick={() => onAnswer("confirmed")} autoFocus>
						Confirm
					</button>
				</div>
			</div>
		</div>
	);
}

/* the mouse is the page's while a panel shows over the game (a locked
pointer sends every click to the game) */
function useReleasedPointer(active) {
	useEffect(() => {
		if (!active) {
			return undefined;
		}
		const release = () => document.pointerLockElement && document.exitPointerLock();
		release();
		document.addEventListener("pointerlockchange", release);
		return () => document.removeEventListener("pointerlockchange", release);
	}, [active]);
}

/* the keyboard and the mouse, as config.toml's [controls] has them by
default (port/linux/src/port_config.c; the game's Settings > Controls Setup
changes them), and the menus' keys (port/linux/src/xinput_sdl.c) */
const PLAYING_CONTROLS = [
	["Move", ["W", "A", "S", "D"]],
	["Aim", ["Mouse"]],
	["Fire", ["Left click"]],
	["Throw a grenade", ["Right click", "G"]],
	["Jump", ["Space"]],
	["Melee", ["F", "Mouse 4"]],
	["Action", ["E"]],
	["Reload", ["R"]],
	["Change weapon", ["Wheel", "1"]],
	["Change grenade", ["X"]],
	["Crouch", ["Left Ctrl", "C"]],
	["Zoom", ["Z", "Middle click"]],
	["Flashlight", ["Q"]],
	["Scoreboard", ["Tab"]],
	["Pause menu", ["Esc"]],
];

const MENU_CONTROLS = [
	["Choose", ["Mouse", "Arrows"]],
	["Select", ["Left click", "Enter", "Space"]],
	["Back", ["Esc", "Backspace"]],
	["Scroll", ["Wheel"]],
];

const PAGE_CONTROLS = [
	["Aim with the mouse", ["Click the game"]],
	["Free the mouse", ["Esc"]],
	["Fullscreen", ["F11"]],
	["Developer console", ["`"]],
];

function ControlsDialog({ onClose }) {
	useReleasedPointer(true);

	return (
		<div className="overlay" role="dialog" aria-modal="true" aria-labelledby="controls-title"
			onClick={(event) => event.target === event.currentTarget && onClose()}
			onKeyDown={(event) => {
				/* (the game takes the window's keys: these are the dialog's) */
				event.stopPropagation();
				if (event.key === "Escape") {
					onClose();
				}
			}}
			onKeyUp={(event) => event.stopPropagation()}>
			<div className="panel panel-wide">
				<div className="panel-header">
					<h2 id="controls-title" className="panel-title">Controls</h2>
					<button type="button" className="toast-close" onClick={onClose} aria-label="Close" autoFocus>×</button>
				</div>
				<div className="controls">
					<ControlsSection title="Playing" controls={PLAYING_CONTROLS} />
					<div className="controls-column">
						<ControlsSection title="Menus" controls={MENU_CONTROLS} />
						<ControlsSection title="In the browser" controls={PAGE_CONTROLS} />
					</div>
				</div>
			</div>
		</div>
	);
}

function ControlsSection({ title, controls }) {
	return (
		<section className="panel-section">
			<h3>{title}</h3>
			<dl className="control-list">
				{controls.map(([action, keys]) => (
					<div key={action} className="control">
						<dt>{action}</dt>
						<dd>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</dd>
					</div>
				))}
			</dl>
		</section>
	);
}

/* Over the game: the host's invite to copy once its game is online, and a
joining player's progress or why it failed. */
function OnlineToast({ lobby, net, onClose }) {
	const [dismissed, setDismissed] = useState(null);
	const [copied, setCopied] = useState(false);
	const invite = net?.state === "hosting" ? net.invite : null;

	let toast = null;
	if (invite && invite !== dismissed) {
		toast = { key: invite, title: "Your game is online",
			text: "Invite friends with this link (the game's lobby has it too). They can join a game in progress." };
	} else if (lobby.phase === "joining" || (net?.state === "connecting" && /#join=/.test(location.hash))) {
		toast = { key: "joining", title: "Joining your friend's game…" };
	} else if (lobby.phase === "failed" && dismissed !== lobby.message) {
		toast = { key: lobby.message, title: "Could not join the game", text: lobby.message, error: true };
	} else if (net?.state === "error" && dismissed !== net.error) {
		toast = { key: net.error, title: "Online play stopped", text: net.error, error: true };
	}
	if (!toast) {
		return null;
	}

	function dismiss() {
		setDismissed(toast.key);
		onClose();
	}

	function copy() {
		navigator.clipboard.writeText(invite).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	}

	return (
		<div className={`toast${toast.error ? " toast-error" : ""}`} role="status"
			onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
			<div className="toast-body">
				<strong>{toast.title}</strong>
				{toast.text && <span>{toast.text}</span>}
			</div>
			{toast.key === invite && (
				<button type="button" className="primary-button" onClick={copy}>
					{copied ? "Copied" : "Copy invite link"}
				</button>
			)}
			{toast.key !== "joining" && (
				<button type="button" className="toast-close" onClick={dismiss} aria-label="Dismiss">×</button>
			)}
		</div>
	);
}

/* network play's state (sfu_transport.js): the invite to copy while
hosting, joining, and why it failed */
function NetStatus({ net }) {
	const [copied, setCopied] = useState(false);

	/* a room's state (browsers' games), else the relay's (desktop builds'
	games: relay_bridge.js), once the game has reached it */
	const state = net && net.state !== "idle" ? net.state :
		net?.relay ? `relay-${net.relay.startsWith("error") ? "error" : net.relay}` : null;
	if (!state) {
		return null;
	}
	const players = `${net.players} ${net.players === 1 ? "player" : "players"}`;
	const text = {
		connecting: "Connecting…",
		hosting: `Hosting · ${players}`,
		/* (the host's game is then in Multiplayer, System Link) */
		joined: "Connected to the host",
		error: `Network: ${net.error}`,
		"relay-connecting": "Reaching the relay…",
		"relay-connected": "Relay connected",
		"relay-disconnected": "Relay lost: reconnecting…",
		"relay-error": `Relay: ${net.relay?.slice("error: ".length)}`,
	}[state];

	function copy() {
		navigator.clipboard.writeText(net.invite).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	}

	return (
		<span className={`net net-${state}`}>
			<span className="net-text" title={text}>{text}</span>
			{net.state === "hosting" && net.invite && (
				<button type="button" className="net-button" onClick={copy} title={net.invite}>
					{copied ? "Copied" : "Copy invite"}
				</button>
			)}
		</span>
	);
}

function ControlsIcon() {
	return (
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<rect x="2" y="6" width="20" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
			<path d="M6 10h1M10 10h1M14 10h1M18 10h1M7 14h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		</svg>
	);
}

function FullscreenIcon() {
	return (
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" strokeWidth="2" />
		</svg>
	);
}

function ExitFullscreenIcon() {
	return (
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" fill="none" stroke="currentColor" strokeWidth="2" />
		</svg>
	);
}
