/*
CRASHPANEL.JSX

What the page shows when the game stops (crash.js): a panel over the
frozen picture that says so, with Reload, and Save log; and, with ?debug,
a Save log button in the bar at all times.
*/

import { useEffect, useState } from "react";
import { debugMode, saveLog, stoppedState } from "./crash.js";
import "./crash.css";

const TITLES = {
	exception: "The game crashed",
	hang: "The game stopped responding",
	"context-lost": "The game lost its graphics",
	exit: "The game was quit",
};

export function CrashPanel() {
	const [stopped, setStopped] = useState(stoppedState);

	useEffect(() => {
		const update = (event) => setStopped(event.detail);
		window.addEventListener("halo-stopped", update);
		return () => window.removeEventListener("halo-stopped", update);
	}, []);

	if (!stopped) {
		return null;
	}
	const quit = stopped.kind === "exit";
	return (
		<div className="overlay crash" role="alertdialog" aria-modal="true" aria-labelledby="crash-title"
			onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
			<div className="panel">
				<h2 id="crash-title" className="panel-title">{TITLES[stopped.kind] || "The game stopped"}</h2>
				<p className="panel-hint">
					{quit ? "Reload the page to play again." :
						"A report of what happened was sent, to help fix it. Reload the page to play again: " +
						"your profiles and settings are kept."}
				</p>
				{!quit && <p className="crash-detail">{stopped.message}</p>}
				<div className="crash-buttons">
					<button type="button" className="primary-button" autoFocus onClick={() => location.reload()}>Reload</button>
					{!quit && <button type="button" className="secondary-button" onClick={saveLog}>Save log</button>}
				</div>
			</div>
		</div>
	);
}

/* (with ?debug) */
export function SaveLogButton() {
	if (!debugMode) {
		return null;
	}
	return (
		<button type="button" className="net-button" onClick={saveLog} title="Save this visit's log as a file">
			Save log
		</button>
	);
}
