import { memo, useEffect, useRef, useState } from "react";
import { startGame } from "./game.js";

/* The game's canvas. It never re-renders: the game owns it once started
(game.js). */
const GameCanvas = memo(function GameCanvas({ onStatus }) {
	const canvas = useRef(null);

	useEffect(() => {
		canvas.current.focus();
		startGame(canvas.current, onStatus);
	}, []);

	return (
		<canvas
			ref={canvas}
			id="canvas"
			className="game-canvas"
			tabIndex={0}
			onContextMenu={(event) => event.preventDefault()}
			onPointerDown={(event) => event.currentTarget.focus()}
			// the keyboard back from a panel over the game, which kept the
			// releases of keys pressed before it (sdl_platform.c's
			// web_reset_keyboard); not there before the game has started
			onFocus={() => window.Module?._web_reset_keyboard?.()}
		/>
	);
}, () => true);

export default function App() {
	const frame = useRef(null);
	const [status, setStatus] = useState("");
	const [fullscreen, setFullscreen] = useState(false);

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

	return (
		<main className="page">
			<div className="console">
				<div ref={frame} className="screen">
					<GameCanvas onStatus={setStatus} />
				</div>
				<div className="bar">
					<span className="status">{status}</span>
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
