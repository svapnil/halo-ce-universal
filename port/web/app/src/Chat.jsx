import { useEffect, useRef, useState } from "react";
import { PLAYER_COLORS } from "./online.js";

/* whether a player colour is dark: its chip's text is then light */
function dark(color) {
	const hex = PLAYER_COLORS[color] ?? PLAYER_COLORS.white;
	const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
	return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

/* The lobby's chat (online.js), to the right of the game: every page with
the site open, how many, and what they say. Each name in its player's colour
(the server's, by the browser's visitor id). Its keys are its own: the game
takes the window's (as the panels over it, App.jsx), and Esc gives the
keyboard back to the game. */
export function ChatPane({ count, messages, notice, state, onSay, onDone }) {
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
						<span className="chat-text">{message.text}</span>
						<time className="chat-time" dateTime={new Date(message.at * 1000).toISOString()}>
							{new Date(message.at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
						</time>
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
