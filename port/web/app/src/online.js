/* The site's lobby (NETWORK.md, "The online count", "The lobby's chat"): how
many browsers have the site open, and the chat between them, from the
signalling's server (signalling/, Signalling.Online), over a WebSocket kept
open with the page. A browser is its visitor id, kept in localStorage, so
that its tabs are one; the server gives each its colour by it.

The lobby is the page's extra: without the server (the Worker's own rooms
have none, or it is full or restarting) the page shows no count and the chat
waits, and tries again later, each page at its own moment, so that they do
not all come back at once after a restart. A tab hidden for a while lets go
of its WebSocket, until it is shown again. */

import { signallingAddress } from "./halo_net.js";

const VISITOR_KEY = "halo-visitor-v1";
const PING_EVERY = 30_000;
const RETRY_FIRST = 2_000;
const RETRY_MOST = 60_000;
const HIDDEN_FOR = 5 * 60_000;
/* the messages a page keeps */
const KEPT = 200;
/* how often a page that types says so (ms): the server forgets it after 5
seconds (Signalling.Typing) */
const TYPING_EVERY = 3_000;

/* the player colours of a multiplayer game, as the server names them
(Signalling.Chat), for the chat's names: the game's profile_color_table
(source/saved games/player_profile.c), in its order */
export const PLAYER_COLORS = {
	white: "#ffffff",
	black: "#000000",
	red: "#fe0000",
	blue: "#0201e3",
	gray: "#707e71",
	yellow: "#ffff01",
	green: "#00ff01",
	pink: "#ff56b9",
	purple: "#ab10f4",
	cyan: "#01ffff",
	cobalt: "#6493ed",
	orange: "#ff7f00",
	teal: "#1ecc91",
	sage: "#006401",
	brown: "#603814",
	tan: "#c69c6c",
	maroon: "#9d0b0e",
	salmon: "#f5999e",
};

/* this browser's visitor id; a new one each visit where the browser keeps
nothing */
function visitorId() {
	try {
		let id = localStorage.getItem(VISITOR_KEY);
		if (!/^[0-9A-Za-z_-]{16,64}$/.test(id || "")) {
			id = crypto.randomUUID();
			localStorage.setItem(VISITOR_KEY, id);
		}
		return id;
	} catch {
		return crypto.randomUUID();
	}
}

/* Connects the page to the lobby. Calls onCount(count) as it comes, and
onCount(null) while there is none; onMessages(messages) with the chat's
messages, oldest first, at each new one; onNotice(text) when the server
refuses a message; onState(state) as the WebSocket goes: "connecting"
(the first time), "connected", or "offline" (lost or refused, or a server
without the lobby: it tries again); onTyping(count) with how many other
pages type (0 while there is no server). Returns { say(text), typing(),
setName(name), stop() }: typing() at each of the player's keys in the
chat, which tells the server at most every 3 seconds. */
export function joinLobby({ onCount, onMessages, onNotice = () => {}, onState = () => {}, onTyping = () => {} }) {
	const visitor = visitorId();
	let socket = null;
	let typed = -Infinity;
	let ping = 0;
	let retry = 0;
	let hidden = 0;
	let wait = RETRY_FIRST;
	let stopped = false;
	let name = null;
	let messages = [];

	function send(message) {
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(message));
			return true;
		}
		return false;
	}

	/* the messages so far and these, each once (by its id) */
	function add(more) {
		const seen = new Set(messages.map((message) => message.id));
		messages = [...messages, ...more.filter((message) => !seen.has(message.id))]
			.sort((a, b) => a.id - b.id).slice(-KEPT);
		onMessages(messages);
	}

	function receive(data) {
		switch (data.type) {
		case "online":
			if (Number.isInteger(data.count)) {
				wait = RETRY_FIRST;
				onState("connected");
				onCount(data.count);
			}
			break;
		case "history":
			/* (the server's ids start again when it does: what it keeps
			now is the chat) */
			if (Array.isArray(data.messages)) {
				const last = messages.at(-1)?.id ?? 0;
				if (data.messages.length && data.messages.at(-1).id < last) {
					messages = [];
				}
				add(data.messages);
			}
			break;
		case "chat":
			add([data]);
			break;
		case "typing":
			if (Number.isInteger(data.count)) {
				onTyping(data.count);
			}
			break;
		case "error":
			onNotice(data.message);
			break;
		}
	}

	async function open() {
		clearTimeout(retry);
		if (stopped || socket) {
			return;
		}
		const base = (await signallingAddress()).replace(/^http/, "ws");
		if (stopped || socket) {
			return;
		}
		socket = new WebSocket(`${base}/net/online?visitor=${encodeURIComponent(visitor)}`);
		socket.addEventListener("message", (event) => {
			if (event.data === "pong") {
				return;
			}
			try {
				receive(JSON.parse(event.data));
			} catch {
				// (not the lobby's)
			}
		});
		socket.addEventListener("open", () => {
			if (name !== null) {
				send({ type: "name", name });
			}
			ping = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send("ping"), PING_EVERY);
		});
		socket.addEventListener("close", () => {
			clearInterval(ping);
			socket = null;
			typed = -Infinity;
			onCount(null);
			onTyping(0);
			onState("offline");
			if (!stopped && !document.hidden) {
				/* (each page at its own moment: half the wait, and a random
				part of the rest) */
				retry = setTimeout(open, wait / 2 + Math.random() * wait / 2);
				wait = Math.min(wait * 2, RETRY_MOST);
			}
		});
	}

	function close() {
		clearTimeout(retry);
		socket?.close();
	}

	function visibility() {
		clearTimeout(hidden);
		if (document.hidden) {
			hidden = setTimeout(close, HIDDEN_FOR);
		} else {
			open();
		}
	}

	document.addEventListener("visibilitychange", visibility);
	onState("connecting");
	open();

	return {
		/* false if the lobby is not reached */
		say(text) {
			/* (the message ends the typing, there: the next key says it again) */
			typed = -Infinity;
			return send({ type: "chat", text });
		},
		typing() {
			const now = performance.now();
			if (now - typed >= TYPING_EVERY && send({ type: "typing" })) {
				typed = now;
			}
		},
		setName(next) {
			name = next;
			send({ type: "name", name });
		},
		stop() {
			stopped = true;
			document.removeEventListener("visibilitychange", visibility);
			clearTimeout(hidden);
			close();
		},
	};
}
