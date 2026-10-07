import { useEffect, useRef, useState } from "react";
import { PLAYER_COLORS } from "./online.js";

/* whether a player colour is dark: its chip's text is then light */
function dark(color) {
	const hex = PLAYER_COLORS[color] ?? PLAYER_COLORS.white;
	const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
	return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

/* a time line over the messages: at the first, and after a quiet while (ms) */
const QUIET_MS = 5 * 60 * 1000;

/* a message's time: the hour, and the day too when it is not today's */
function clock(at) {
	const date = new Date(at * 1000);
	const today = date.toDateString() === new Date().toDateString();
	return date.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } :
		{ weekday: "short", hour: "numeric", minute: "2-digit" });
}

/* The lobby's chat (online.js), to the right of the game: every page with
the site open, how many, what they say, and how many of the others type
(never who: a line over the input, its room kept so that the list does not
move). Each name in its player's colour
(the server's, by the browser's visitor id); the time over the messages after
a quiet while, not beside each. Its keys are its own: the game takes the
window's (as the panels over it, App.jsx), and Esc gives the keyboard back to
the game. The button at the header's left puts it away (onHide): beside the
game, to a narrow strip (ChatRail); over it, closed. */
export function ChatPane({ count, messages, notice, state, typing, onSay, onTyping, onDone, onHide, hideLabel }) {
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
				<button type="button" className="chat-hide" onClick={onHide} aria-label={hideLabel} title={hideLabel}
					aria-expanded={true}>
					<HideIcon />
				</button>
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
				{messages.map((message, at) => [
					(at === 0 || (message.at - messages[at - 1].at) * 1000 >= QUIET_MS) && (
						<li key={`time-${message.id}`} className="chat-time" aria-hidden="true">
							<time dateTime={new Date(message.at * 1000).toISOString()}>{clock(message.at)}</time>
						</li>
					),
					<li key={message.id} className="chat-message" title={clock(message.at)}>
						<span className="chat-name" style={{ color: PLAYER_COLORS[message.color] ?? PLAYER_COLORS.white }}
							data-color={message.color} data-dark={dark(message.color) || undefined}>
							<span className="chat-name-text">{message.name}</span>
						</span>
						<span className="chat-text">{message.text}</span>
					</li>,
				])}
			</ol>
			{notice && <p className="chat-notice" role="status">{notice}</p>}
			<p className="chat-typing" aria-live="polite">
				{typing > 0 && <>
					<span className="chat-typing-dots" aria-hidden="true"><span /><span /><span /></span>
					{typing === 1 ? "Someone is typing…" : `${typing.toLocaleString()} people are typing…`}
				</>}
			</p>
			<form className="chat-form" onSubmit={submit}>
				<input className="chat-input" value={text} maxLength={200} placeholder={connected ? "Message the lobby" : waiting}
					disabled={!connected} aria-label="Message" enterKeyHint="send" autoComplete="off"
					onChange={(event) => {
						setText(event.target.value);
						if (event.target.value.trim()) {
							onTyping();
						}
					}} />
				<button type="submit" className="primary-button chat-send" disabled={!connected || !text.trim()}>
					Send
				</button>
			</form>
		</aside>
	);
}

/* The chat beside the game, put away: a strip the game gives its room to,
with the button that brings the chat back and how many messages came
meanwhile */
export function ChatRail({ count, unread, onShow }) {
	const label = unread ? `Show the lobby chat: ${unread} new` : "Show the lobby chat";
	return (
		<aside className="chat chat-rail" aria-label="Lobby chat">
			<button type="button" className="chat-hide chat-show" onClick={onShow} aria-label={label} title={label}
				aria-expanded={false}>
				<HideIcon />
			</button>
			<button type="button" className="chat-rail-body" onClick={onShow} tabIndex={-1} aria-hidden="true">
				<ChatIcon />
				{unread > 0 && <span className="chat-unread">{unread > 99 ? "99+" : unread}</span>}
				{count !== null && (
					<span className="chat-rail-online">
						<span className="online-dot" />
						{count.toLocaleString()}
					</span>
				)}
			</button>
		</aside>
	);
}

/* (chevrons to the right, the way the chat goes; the rail's are turned) */
function HideIcon() {
	return (
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<path d="M6 6l6 6-6 6M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2"
				strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

export function ChatIcon() {
	return (
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
		</svg>
	);
}
