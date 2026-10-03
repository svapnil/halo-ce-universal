import { memo, useEffect, useRef, useState } from "react";
import { online, startGame } from "./game.js";
import { GAME_TYPES, MAPS } from "./lobby.js";

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
			// the keyboard back from a panel over the game, which kept the
			// releases of keys pressed before it (sdl_platform.c's
			// web_reset_keyboard); not there before the game has started
			onFocus={() => window.Module?._web_reset_keyboard?.()}
		/>
	);
}, () => true);

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

	useEffect(() => {
		const update = () => setFullscreen(document.fullscreenElement === frame.current);
		document.addEventListener("fullscreenchange", update);
		return () => document.removeEventListener("fullscreenchange", update);
	}, []);

	function toggleFullscreen() {
		if (document.fullscreenElement) {
			document.exitFullscreen();
		} else {
			frame.current.requestFullscreen().catch((error) => setStatus(`Fullscreen: ${error.message}`));
		}
		frame.current.querySelector("canvas").focus();
	}

	/* the game takes the keyboard back when a panel over it closes */
	function focusGame() {
		frame.current.querySelector("canvas").focus();
	}

	return (
		<main className="page">
			<div className="console">
				<div ref={frame} className="screen">
					<GameCanvas onStatus={setStatus} onNet={setNet} onLobby={setLobby} />
					<MultiplayerMenu lobby={lobby} onClose={focusGame} />
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
						title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}>
						{fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
					</button>
				</div>
			</div>
		</main>
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

/* The page's Multiplayer menu, over the game's when it opens (the game's
stays behind it, for split screen and local games): host an online game,
which starts at once or waits in the game's lobby for friends, or join a
friend's with their invite. */
function MultiplayerMenu({ lobby, onClose }) {
	const [open, setOpen] = useState(false);
	const [map, setMap] = useState(MAPS[0][0]);
	const [gameType, setGameType] = useState(GAME_TYPES[0][0]);
	const [startNow, setStartNow] = useState(true);
	const [invite, setInvite] = useState("");

	/* (again each time the game's Multiplayer menu opens) */
	useEffect(() => {
		setOpen(lobby.phase === "multiplayer-menu");
	}, [lobby]);

	useReleasedPointer(open);

	if (!open) {
		return null;
	}

	function close() {
		setOpen(false);
		onClose();
	}

	function host(event) {
		event.preventDefault();
		online.host(map, gameType, { startNow });
		close();
	}

	function join(event) {
		event.preventDefault();
		if (invite.trim()) {
			online.join(invite.trim());
			close();
		}
	}

	return (
		<div className="overlay" role="dialog" aria-modal="true" aria-labelledby="multiplayer-title"
			onKeyDown={(event) => {
				/* (the game takes the window's keys: these are the menu's) */
				event.stopPropagation();
				if (event.key === "Escape") {
					close();
				}
			}}
			onKeyUp={(event) => event.stopPropagation()}>
			<div className="panel">
				<h2 id="multiplayer-title" className="panel-title">Multiplayer</h2>
				<form className="panel-section" onSubmit={host}>
					<h3>Host an online game</h3>
					<p className="panel-hint">
						{startNow ?
							"You start playing right away. Send friends the invite link; they join the game in progress." :
							"You wait in the lobby. Send friends the invite link, and start the game when everyone is in."}
					</p>
					<div className="fields">
						<label className="field">
							<span>Map</span>
							<select value={map} onChange={(event) => setMap(event.target.value)}>
								{MAPS.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
							</select>
						</label>
						<label className="field">
							<span>Game type</span>
							<select value={gameType} onChange={(event) => setGameType(event.target.value)}>
								{GAME_TYPES.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
							</select>
						</label>
					</div>
					<div className="choice" role="radiogroup" aria-label="When the game starts">
						<label className={startNow ? "choice-option selected" : "choice-option"}>
							<input type="radio" name="start" checked={startNow} onChange={() => setStartNow(true)} />
							Start now
						</label>
						<label className={startNow ? "choice-option" : "choice-option selected"}>
							<input type="radio" name="start" checked={!startNow} onChange={() => setStartNow(false)} />
							Wait for friends
						</label>
					</div>
					<button type="submit" className="primary-button" autoFocus>Create game</button>
				</form>
				<form className="panel-section" onSubmit={join}>
					<h3>Join a friend</h3>
					<div className="join-row">
						<input type="text" value={invite} onChange={(event) => setInvite(event.target.value)}
							placeholder="Paste an invite link" aria-label="Invite link" spellCheck={false} />
						<button type="submit" className="secondary-button" disabled={!invite.trim()}>Join</button>
					</div>
				</form>
				<button type="button" className="text-button" onClick={close}>
					Split screen or local network: use the game's menu
				</button>
			</div>
		</div>
	);
}

/* the keyboard and the mouse as controller 1 (port/linux/src/xinput_sdl.c,
the Linux README's Controls) */
const PLAYING_CONTROLS = [
	["Move", ["W", "A", "S", "D"]],
	["Aim", ["Mouse"]],
	["Fire", ["Left click"]],
	["Throw a grenade", ["Right click", "G"]],
	["Jump", ["Space"]],
	["Melee", ["F", "Mouse 4"]],
	["Action, reload", ["E", "R"]],
	["Change weapon", ["Tab", "Wheel"]],
	["Change grenade", ["X"]],
	["Crouch", ["Ctrl", "C"]],
	["Zoom", ["Z", "Middle click"]],
	["Flashlight", ["Q"]],
	["Pause menu", ["Esc"]],
	["Scoreboard", ["F1"]],
];

const MENU_CONTROLS = [
	["Choose", ["Mouse", "Arrows"]],
	["Select", ["Left click", "Enter"]],
	["Back", ["Right click", "Backspace"]],
	["Scroll", ["Wheel"]],
];

const PAGE_CONTROLS = [
	["Aim with the mouse", ["Click the game"]],
	["Free the mouse", ["Esc"]],
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

	const waiting = lobby.phase === "lobby";
	let toast = null;
	if (invite && invite !== dismissed) {
		toast = waiting ?
			{ key: invite, title: "Waiting for friends", text: "Share the link, then start when everyone is in." } :
			{ key: invite, title: "Your game is online", text: "Invite friends with this link. They join the game in progress." };
	} else if (lobby.phase === "joining" || (net?.state === "connecting" && /#join=/.test(location.hash))) {
		toast = { key: "joining", title: "Joining your friend's game…" };
	} else if (lobby.phase === "failed" && dismissed !== lobby.message) {
		toast = { key: lobby.message, title: "Could not start the online game", text: lobby.message, error: true };
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
				<button type="button" className={waiting ? "secondary-button" : "primary-button"} onClick={copy}>
					{copied ? "Copied" : "Copy invite link"}
				</button>
			)}
			{toast.key === invite && waiting && (
				<button type="button" className="primary-button" onClick={() => { online.start(); onClose(); }}>Start game</button>
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

	if (!net || net.state === "idle") {
		return null;
	}
	const players = `${net.players} ${net.players === 1 ? "player" : "players"}`;
	const text = {
		connecting: "Connecting…",
		hosting: `Hosting · ${players}`,
		/* (the host's game is then in Multiplayer, System Link) */
		joined: "Connected to the host",
		error: `Network: ${net.error}`,
	}[net.state];

	function copy() {
		navigator.clipboard.writeText(net.invite).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	}

	return (
		<span className={`net net-${net.state}`}>
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
