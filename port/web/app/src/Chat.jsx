import { useEffect, useRef, useState } from "react";
import { PLAYER_COLORS } from "./online.js";

/* whether a player colour is dark: its chip's text is then light */
function dark(color) {
	const hex = PLAYER_COLORS[color] ?? PLAYER_COLORS.white;
	const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
	return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

/* the maps' names, by their scenario's (the menus' mp_map_list and
map_list) */
const MAP_NAMES = {
	beavercreek: "Battle Creek", sidewinder: "Sidewinder", damnation: "Damnation", ratrace: "Rat Race",
	prisoner: "Prisoner", hangemhigh: "Hang 'Em High", chillout: "Chill Out", carousel: "Derelict",
	boardingaction: "Boarding Action", bloodgulch: "Blood Gulch", longest: "Longest", wizard: "Wizard",
	putput: "Chiron TL-34", deathisland: "Death Island", dangercanyon: "Danger Canyon", infinity: "Infinity",
	icefields: "Ice Fields", timberland: "Timberland", gephyrophobia: "Gephyrophobia",
	a10: "The Pillar of Autumn", a30: "Halo", a50: "The Truth and Reconciliation", b30: "The Silent Cartographer",
	b40: "Assault on the Control Room", c10: "343 Guilty Spark", c20: "The Library", c40: "Two Betrayals",
	d20: "Keyes", d40: "The Maw",
};
const ENGINE_NAMES = {
	slayer: "Slayer", ctf: "Capture the Flag", oddball: "Oddball", king: "King of the Hill", race: "Race", coop: "Co-op",
};

/* the time now, again each second while `ticking` */
function useNow(ticking) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!ticking) {
			return undefined;
		}
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [ticking]);
	return now;
}

function clock(milliseconds) {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const two = (value) => String(value).padStart(2, "0");
	return hours ? `${hours}:${two(minutes % 60)}:${two(seconds % 60)}` : `${minutes}:${two(seconds % 60)}`;
}

/* A game card (online.js): a browser's game as the server last told it,
with a Join button that joins it (onJoin), but for a game the page hosts
(here: "hosting") or is in ("joined"), or one that is full or over. */
function GameCard({ card, here, onJoin }) {
	const ended = card.status === "ended";
	const playing = !ended && card.inProgress;
	const now = useNow(playing && Boolean(card.matchStartedAt));
	const map = MAP_NAMES[card.map] ?? card.map ?? "A Halo game";
	const kind = card.gametype?.trim() || ENGINE_NAMES[card.engine] || "";
	const players = Number.isInteger(card.players) && card.maximumPlayers ?
		`${card.players} of ${card.maximumPlayers} players` : "";
	const full = Number.isInteger(card.players) && card.maximumPlayers > 0 && card.players >= card.maximumPlayers;
	let status;
	let tone;
	if (ended) {
		status = "Game over";
		tone = "ended";
	} else if (card.host === "reconnecting") {
		status = "Host reconnecting…";
		tone = "waiting";
	} else if (!card.engine) {
		status = "Starting…";
		tone = "waiting";
	} else if (playing) {
		status = card.matchStartedAt ? `In a match · ${clock(now - Date.parse(card.matchStartedAt))}` : "In a match";
		tone = "live";
	} else {
		status = "In the lobby";
		tone = "lobby";
	}

	return (
		<div className={`game-card${ended ? " game-card-ended" : ""}`}>
			<div className="game-card-body">
				<span className={`game-card-status game-card-status-${tone}`}>
					{tone === "live" && <span className="game-card-dot" aria-hidden="true" />}
					{status}
				</span>
				<strong className="game-card-map">{map}</strong>
				<span className="game-card-detail">{[kind, players].filter(Boolean).join(" · ")}</span>
				{card.name && <span className="game-card-name">{card.name}</span>}
			</div>
			{!ended && (here ?
				<span className="game-card-own">{here === "hosting" ? "Your game" : "You're in"}</span> :
				<button type="button" className="join-button" disabled={full} onClick={() => onJoin(card)}>
					{full ? "Full" : "Join"}
				</button>)}
		</div>
	);
}

/* The lobby's chat (online.js), to the right of the game: every page with
the site open, how many, and what they say. Each name in its player's colour
(the server's, by the browser's visitor id). Its keys are its own: the game
takes the window's (as the panels over it, App.jsx), and Esc gives the
keyboard back to the game. */
export function ChatPane({ count, messages, notice, state, ownRoom, joinedRoom, onSay, onJoin, onDone }) {
	const connected = state === "connected" && count !== null;
	const waiting = state === "offline" ? "Offline: trying again…" : "Connecting…";
	const list = useRef(null);
	const [text, setText] = useState("");
	/* whether the list is at its bottom: then it follows new messages */
	const following = useRef(true);

	useEffect(() => {
		if (following.current && list.current) {
			list.current.scrollTop = list.current.scrollHeight;
		}
	}, [messages]);

	function submit(event) {
		event.preventDefault();
		if (text.trim() && onSay(text)) {
			setText("");
			following.current = true;
		}
	}

	return (
		<aside className="chat" aria-label="Lobby chat"
			onKeyDown={(event) => {
				/* (the game takes the window's keys: these are the chat's) */
				event.stopPropagation();
				if (event.key === "Escape") {
					event.target.blur?.();
					onDone();
				}
			}}
			onKeyUp={(event) => event.stopPropagation()}>
			<header className="chat-header">
				<h2 className="chat-title">Lobby</h2>
				{count !== null ?
					<span className="chat-online" title="Browsers with the site open">
						<span className="online-dot" aria-hidden="true" />
						{count.toLocaleString()} online
					</span> :
					<span className="chat-online chat-offline">{waiting}</span>}
			</header>
			<ol ref={list} className="chat-messages" aria-live="polite"
				onScroll={(event) => {
					const box = event.currentTarget;
					following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
				}}>
				{messages.length === 0 && <li className="chat-empty">No messages yet. Say hello.</li>}
				{messages.map((message) => (
					<li key={message.id} className="chat-message">
						<span className="chat-name" style={{ color: PLAYER_COLORS[message.color] ?? PLAYER_COLORS.white }}
							data-color={message.color} data-dark={dark(message.color) || undefined}>
							<span className="chat-name-text">{message.name}</span>
						</span>
						{message.card ?
							<span className="chat-text chat-said">{message.started ? "started a game" : "shared a game"}</span> :
							<span className="chat-text">{message.text}</span>}
						<time className="chat-time" dateTime={new Date(message.at * 1000).toISOString()}>
							{new Date(message.at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
						</time>
						{message.card && <GameCard card={message.card}
							here={message.card.room === ownRoom ? "hosting" : message.card.room === joinedRoom ? "joined" : null}
							onJoin={onJoin} />}
					</li>
				))}
			</ol>
			{notice && <p className="chat-notice" role="status">{notice}</p>}
			<form className="chat-form" onSubmit={submit}>
				<input className="chat-input" value={text} maxLength={200} placeholder={connected ? "Message the lobby" : waiting}
					disabled={!connected} aria-label="Message" enterKeyHint="send" autoComplete="off"
					onChange={(event) => setText(event.target.value)} />
				<button type="submit" className="primary-button chat-send" disabled={!connected || !text.trim()}>
					Send
				</button>
			</form>
		</aside>
	);
}
