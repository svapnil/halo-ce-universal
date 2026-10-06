import { memo, useEffect, useRef, useState } from "react";
import { CrashPanel, SaveLogButton } from "./CrashPanel.jsx";
import { browserSupport, startGame } from "./game.js";
import { keepFromBrowser } from "./keys.js";
import { ChatPane } from "./Chat.jsx";
import { joinLobby } from "./online.js";
import { watchProfileName } from "./profile.js";
import { TouchControls, useTouchDevice } from "./TouchControls.jsx";

/* The game's canvas. It never re-renders: the game owns it once started
(game.js). */
const GameCanvas = memo(function GameCanvas({ onStatus, onNet, onLobby, onLoading }) {
	const canvas = useRef(null);

	useEffect(() => {
		canvas.current.focus();
		startGame(canvas.current, { onStatus, onNet, onLobby, onLoading });
		// SDL gives the canvas's drawing buffer the canvas's size at each of
		// the window's resize events, and the game draws at that size
		// (sdl_platform.c's platform_screen_mode). The canvas can change size
		// without one: fullscreen from a window already the screen's size.
		const observer = new ResizeObserver(() => window.dispatchEvent(new Event("resize")));
		observer.observe(canvas.current);
		return () => observer.disconnect();
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
				/* (a finger is not the mouse: it aims by itself, sdl_platform.c) */
				if (event.pointerType !== "touch") {
					captureMouse(event.currentTarget);
				}
			}}
			onKeyDown={(event) => keepFromBrowser(event) && event.preventDefault()}
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
	// (refused for a moment after Esc frees the mouse: the next click again;
	// iOS has no pointer lock at all)
	Promise.resolve(canvas.requestPointerLock?.()).catch(() => {});
}

export default function App() {
	const frame = useRef(null);
	const [status, setStatus] = useState("");
	const [net, setNet] = useState(null);
	const [lobby, setLobby] = useState({ phase: "other", message: "" });
	/* what the game waits for (loading.js), or null */
	const [loading, setLoading] = useState(null);
	const [fullscreen, setFullscreen] = useState(false);
	const [controlsOpen, setControlsOpen] = useState(false);
	/* the game's volume, a percentage: null until the game tells it */
	const [volume, setVolume] = useState(null);
	const volumeKept = useRef(null);
	/* the notice's answer: the game starts only once it is confirmed */
	const [notice, setNotice] = useState(() => noticeConfirmed() ? "confirmed" : "pending");
	/* why this browser cannot run the game, or null (game.js) */
	const [unsupported] = useState(browserSupport);
	/* a phone or a tablet: the touch controls over the game */
	const touch = useTouchDevice();
	/* the chat beside the game where the window has room for it (a wide
	window, with a mouse); else over the game, from the bar's button */
	const chatDocked = useMediaQuery(CHAT_DOCKED_QUERY);
	const [chatOpen, setChatOpen] = useState(false);
	/* a phone sideways: the bar is hidden, for the picture to have the whole
	screen, and shown over it from the corner's button (or by a status to
	read) */
	const landscape = useMediaQuery("(orientation: landscape)");
	const barFloating = touch && landscape;
	const [barOpen, setBarOpen] = useState(false);
	const barHidden = barFloating && !barOpen;
	/* no fullscreen for pages (an iPhone's Safari): the way is the Home
	Screen, which the fullscreen button then explains; from the Home Screen
	(standalone) there is nothing to ask for */
	const [homeScreenHint, setHomeScreenHint] = useState(false);
	const standalone = useMediaQuery("(display-mode: standalone)") || navigator.standalone === true;
	/* the site's lobby (online.js): how many browsers have the site open (or
	null), and its chat */
	const [online, setOnline] = useState(null);
	const [messages, setMessages] = useState([]);
	const [chatNotice, setChatNotice] = useState("");
	const [chatState, setChatState] = useState("connecting");
	const siteLobby = useRef(null);

	useEffect(() => {
		const joined = joinLobby({ onCount: setOnline, onMessages: setMessages, onNotice: setChatNotice,
			onState: setChatState });
		siteLobby.current = joined;
		/* the chat's name: the player's Halo profile's (profile.js) */
		const stopName = watchProfileName((name) => joined.setName(name));
		return () => {
			stopName();
			joined.stop();
			siteLobby.current = null;
		};
	}, []);

	function say(text) {
		setChatNotice("");
		return siteLobby.current?.say(text) ?? false;
	}

	/* (a status to read shows the hidden bar for a while; a status cleared
	meanwhile leaves the bar until then) */
	const statusTimer = useRef(null);
	useEffect(() => {
		if (!status || !barFloating) {
			return;
		}
		setBarOpen(true);
		clearTimeout(statusTimer.current);
		statusTimer.current = setTimeout(() => setBarOpen(false), STATUS_SHOW_MS);
	}, [status, barFloating]);

	/* the floating bar goes as the game is touched (as the click goes down,
	before the game's canvas has it) */
	useEffect(() => {
		if (!barFloating || !barOpen) {
			return undefined;
		}
		const outside = (event) => {
			if (!event.target.closest(".bar, .bar-toggle, .overlay")) {
				setBarOpen(false);
			}
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [barFloating, barOpen]);

	useEffect(() => {
		const update = () => setFullscreen(document.fullscreenElement === frame.current);
		document.addEventListener("fullscreenchange", update);
		/* the game's F11, and its Settings' fullscreen (detail: 1 on, 0 off,
		-1 switch): the page's fullscreen, as the button's */
		const fromGame = (event) => setPageFullscreen(event.detail);
		window.addEventListener("halo-fullscreen", fromGame);
		/* the game's volume, as it starts and when its Settings change it
		(dsound_sdl.c's web_volume_tell_page) */
		const volumeFromGame = (event) => setVolume(event.detail);
		window.addEventListener("halo-volume", volumeFromGame);
		return () => {
			document.removeEventListener("fullscreenchange", update);
			window.removeEventListener("halo-fullscreen", fromGame);
			window.removeEventListener("halo-volume", volumeFromGame);
		};
	}, []);

	/* The bar's volume is the game's own: config.toml's audio.volume, which
	the game's Settings > Audio shows as MASTER VOLUME and the browser keeps
	with the saves (web_main.c). The game follows the control as it moves,
	and writes its settings once the control has come to rest (dsound_sdl.c's
	web_set_volume). */
	function changeVolume(percent) {
		setVolume(percent);
		window.Module?._web_set_volume?.(percent, 0);
		clearTimeout(volumeKept.current);
		volumeKept.current = setTimeout(() => window.Module?._web_set_volume?.(percent, 1), VOLUME_KEEP_DELAY);
	}

	/* on: true, false, or -1 to switch */
	function setPageFullscreen(on) {
		const now = Boolean(document.fullscreenElement);
		const want = on === -1 ? !now : Boolean(on);
		if (want && !now) {
			if (!frame.current.requestFullscreen) {
				if (/iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.maxTouchPoints > 1) {
					setHomeScreenHint(true);
				} else {
					setStatus("Fullscreen is not available in this browser.");
				}
				return;
			}
			frame.current.requestFullscreen().then(
				/* (a phone: sideways, as the game is played; where the browser
				lets a page ask) */
				() => screen.orientation?.lock?.("landscape").catch(() => {}),
				(error) => setStatus(`Fullscreen: ${error.message}`));
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
		frame.current.querySelector("canvas")?.focus();
	}

	function closeChat() {
		setChatOpen(false);
		focusGame();
	}

	const chatProps = { count: online, messages, notice: chatNotice, state: chatState, onSay: say };

	return (
		<main className="page">
			<div className="layout">
				<div className="console">
					<div ref={frame} className="screen">
						{unsupported ?
							<UnsupportedPanel reason={unsupported} /> :
							notice === "confirmed" ?
								<GameCanvas onStatus={setStatus} onNet={setNet} onLobby={setLobby} onLoading={setLoading} /> :
								<OwnershipNotice denied={notice === "denied"} onAnswer={(answer) => {
									if (answer === "confirmed") {
										rememberNoticeConfirmed();
									}
									setNotice(answer);
								}} />}
						{!unsupported && notice === "confirmed" && touch &&
							<TouchControls mainMenu={lobby.phase === "main-menu"} />}
						{!homeScreenHint && <RotateHint />}
						<LoadingPanel loading={loading} />
						<OnlineToast lobby={lobby} net={net} onClose={focusGame} />
						<CrashPanel />
						{controlsOpen && <ControlsDialog touch={touch} onClose={() => { setControlsOpen(false); focusGame(); }} />}
						{barFloating && !barOpen && (
							<button type="button" className="bar-toggle" onClick={() => setBarOpen(true)}
								aria-label="Show the bar" aria-expanded={false}>
								<MoreIcon />
							</button>
						)}
						{homeScreenHint && <HomeScreenHint landscape={landscape} onClose={() => { setHomeScreenHint(false); focusGame(); }} />}
						{!chatDocked && chatOpen && (
							<div className="overlay chat-drawer" onClick={(event) => event.target === event.currentTarget && closeChat()}>
								<ChatPane {...chatProps} onDone={closeChat} />
								<button type="button" className="toast-close chat-drawer-close" onClick={closeChat}
									aria-label="Close the chat">×</button>
							</div>
						)}
					</div>
					{/* (the upright Home Screen hint points past the bar at Safari's: the bar goes meanwhile) */}
					<div className={`bar${barFloating ? " bar-floating" : ""}`} hidden={barHidden || (homeScreenHint && !landscape)}>
						<span className="status">{status}</span>
						<NetStatus net={net} />
						<SaveLogButton />
						{!chatDocked && (
							<button type="button" className="bar-button bar-chat" onClick={() => setChatOpen(!chatOpen)}
								aria-label="Lobby chat" aria-expanded={chatOpen}
								title={online !== null ? `Lobby chat: ${online.toLocaleString()} online` : "Lobby chat"}>
								<ChatIcon />
								{online !== null && <span className="bar-chat-count">{online.toLocaleString()}</span>}
							</button>
						)}
						<VolumeControl volume={volume} onChange={changeVolume} onDone={focusGame} />
						<button type="button" className="bar-button" onClick={() => setControlsOpen(!controlsOpen)}
							aria-label="Controls" aria-expanded={controlsOpen} title="Controls">
							<ControlsIcon />
						</button>
						{!standalone && (
							<button type="button" className="bar-button" onClick={toggleFullscreen}
								aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
								title={fullscreen ? "Exit fullscreen (F11, or hold Esc)" : "Fullscreen (F11): the game takes every key"}>
								{fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
							</button>
						)}
					</div>
				</div>
				{chatDocked && <ChatPane {...chatProps} onDone={focusGame} />}
			</div>
		</main>
	);
}

/* how long a status shows the hidden bar (ms) */
const STATUS_SHOW_MS = 6000;

/* where the chat is docked beside the game: a wide window whose pointer is
not a finger (styles.css's --chat-width agrees) */
const CHAT_DOCKED_QUERY = "(min-width: 901px) and (not (pointer: coarse))";

/* whether a media query matches, as the window changes */
function useMediaQuery(query) {
	const [matches, setMatches] = useState(() => matchMedia(query).matches);

	useEffect(() => {
		const list = matchMedia(query);
		const update = () => setMatches(list.matches);
		update();
		list.addEventListener("change", update);
		return () => list.removeEventListener("change", update);
	}, [query]);
	return matches;
}

/* Over the game while it waits for its data, and draws nothing new: as it
starts (the picture is black until the menus' map has come), and later for
a map from the server (the picture stands still, or is black). How much has
come is loading.js's; without a size to measure it against, the bar only
moves. */
function LoadingPanel({ loading }) {
	if (!loading) {
		return null;
	}
	const { what, percent } = loading;
	const label = what === "map" ? "Loading map" : "Loading";
	return (
		<div className="loading" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
			aria-valuenow={percent ?? undefined}>
			<div className="loading-text">
				<span>{label}</span>
				{percent !== null && <span className="loading-percent">{percent}%</span>}
			</div>
			<div className={`loading-track${percent === null ? " loading-unknown" : ""}`}>
				<div className="loading-bar" style={percent === null ? undefined : { width: `${percent}%` }} />
			</div>
		</div>
	);
}

/* how long the volume control rests before the game writes its settings
(ms) */
const VOLUME_KEEP_DELAY = 300;

/* The bar's volume: an icon, which shows how loud the game is. A click on it
shows the slider, until another click on it, a click elsewhere or Esc.
Without a volume yet (the game has not started), there is none to change. */
function VolumeControl({ volume, onChange, onDone }) {
	const control = useRef(null);
	const [open, setOpen] = useState(false);
	const known = volume !== null;

	useEffect(() => {
		if (!open) {
			return undefined;
		}
		/* (as the click goes down, before the game's canvas has it) */
		const outside = (event) => !control.current.contains(event.target) && setOpen(false);
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [open]);

	function close() {
		setOpen(false);
		onDone();
	}

	return (
		<div ref={control} className="volume"
			onKeyDown={(event) => {
				/* (the game takes the window's keys: these are the control's) */
				event.stopPropagation();
				if (event.key === "Escape" && open) {
					close();
				}
			}}
			onKeyUp={(event) => event.stopPropagation()}>
			{/* (to the icon's left: the icon stays where it was clicked) */}
			{open && (
				<input type="range" className="volume-slider" min="0" max="100" step="1" value={volume}
					onChange={(event) => onChange(Number(event.target.value))}
					// (the keyboard back to the game once the mouse lets go)
					onPointerUp={onDone}
					aria-label="Volume" title={`Volume: ${volume}%`} autoFocus />
			)}
			<button type="button" className="bar-button" onClick={() => open ? close() : setOpen(true)}
				disabled={!known} aria-label="Volume" aria-expanded={open}
				title={known ? `Volume: ${volume}%` : "Volume"}>
				<VolumeIcon volume={volume ?? 100} />
			</button>
		</div>
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

/* Instead of the game, where the browser cannot run it (game.js's
browserSupport): what to do about it, by platform. */
function UnsupportedPanel({ reason }) {
	return (
		<div className="overlay" role="alert">
			<div className="panel">
				<h2 className="panel-title">{reason.title}</h2>
				<p className="panel-hint">{reason.text}</p>
			</div>
		</div>
	);
}

/* An iPhone's fullscreen button: Safari has no fullscreen for pages; the
Home Screen is the way. Sideways, Safari hides its bar, so the phone goes
upright first. Upright, Share is behind the menu button at the left end of
the address bar: every iPhone that runs the game has iOS 27 (JSPI), whose
Safari has that compact bar unless the player chose another layout (Safari's
user agent does not tell the version), and a pointer at the bottom shows
where the button is. */
function HomeScreenHint({ landscape, onClose }) {
	return (
		<div className={`overlay home-hint${landscape ? "" : " home-hint-upright"}`} role="dialog" aria-modal="true"
			aria-labelledby="home-screen-title" onClick={(event) => event.target === event.currentTarget && onClose()}>
			<div className="panel">
				<div className="panel-header">
					<h2 id="home-screen-title" className="panel-title">Full screen on an iPhone</h2>
					<button type="button" className="toast-close" onClick={onClose} aria-label="Close" autoFocus>×</button>
				</div>
				{landscape ? (
					<>
						<p className="panel-hint">
							Safari gives pages no full screen. For the whole screen, add this page to your Home Screen
							and play from that icon.
						</p>
						<p className="panel-hint home-hint-step">
							<RotateIcon />
							<span><strong>Turn your phone upright first.</strong> Sideways, Safari hides its bar, and
							the Share button with it.</span>
						</p>
					</>
				) : (
					<>
						<ol className="panel-hint home-hint-steps">
							<li>At the bottom of Safari, tap the <strong>menu button</strong> at the left end of the
								address bar.</li>
							<li>Tap <strong>Share</strong>.</li>
							<li>Scroll down and tap <strong>Add to Home Screen</strong>, then play from that icon.</li>
						</ol>
						<p className="panel-hint home-hint-note">
							With Safari's "Bottom" or "Top" layout, tap its Share button instead, the box with an arrow.
						</p>
					</>
				)}
			</div>
			{!landscape && (
				<div className="home-hint-pointer" aria-hidden="true">
					<span className="home-hint-pointer-label">Menu</span>
					<svg viewBox="0 0 24 24" width="28" height="28">
						<path d="M12 4v14M6 12l6 7 6-7" fill="none" stroke="currentColor" strokeWidth="2.5"
							strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</div>
			)}
		</div>
	);
}

/* a phone held upright: the game is played sideways (styles.css shows it in
portrait only) */
function RotateHint() {
	return (
		<div className="rotate-hint" role="status">
			<RotateIcon />
			<span>Turn your phone sideways to play</span>
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

/* the touch controls (TouchControls.jsx) */
const TOUCH_CONTROLS = [
	["Move", ["Stick"]],
	["Aim", ["Drag the picture"]],
	["Fire, grenade, jump, melee…", ["Buttons"]],
	["Pause menu, scoreboard", ["Top buttons"]],
	["Menus: choose", ["Tap", "D-pad"]],
	["Menus: back", ["B"]],
];

const PAGE_CONTROLS = [
	["Aim with the mouse", ["Click the game"]],
	["Free the mouse", ["Esc"]],
	["Fullscreen", ["F11"]],
	["Leave fullscreen", ["F11", "Hold Esc", "Alt+Tab"]],
	["Keep Ctrl+W and the like for the game", ["Play in fullscreen"]],
	["Developer console", ["`"]],
];

function ControlsDialog({ touch, onClose }) {
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
					<div className="controls-column">
						{touch && <ControlsSection title="Touch" controls={TOUCH_CONTROLS} />}
						<ControlsSection title="Playing" controls={PLAYING_CONTROLS} />
					</div>
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

function VolumeIcon({ volume }) {
	return (
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<path d="M3 9.5h3.5L11 6v12l-4.5-3.5H3z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
			{volume === 0 ?
				<path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /> :
				<path d={volume < 50 ? "M15 9.5a3.5 3.5 0 0 1 0 5" : "M15 9.5a3.5 3.5 0 0 1 0 5M17.5 6.5a7.5 7.5 0 0 1 0 11"}
					fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
		</svg>
	);
}

function MoreIcon() {
	return (
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<circle cx="6" cy="12" r="1.8" fill="currentColor" />
			<circle cx="12" cy="12" r="1.8" fill="currentColor" />
			<circle cx="18" cy="12" r="1.8" fill="currentColor" />
		</svg>
	);
}

function ChatIcon() {
	return (
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
		</svg>
	);
}

function RotateIcon() {
	return (
		<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
			<rect x="7" y="3" width="10" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
			<path d="M20 9a8 8 0 0 0-3-5M4 15a8 8 0 0 0 3 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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
