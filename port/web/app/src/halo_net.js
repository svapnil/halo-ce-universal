/*
HALO_NET.JS

The page's side of network play between browsers (NETWORK.md): hosts or
joins a room through the signalling (the server of port/web/signalling, or
the Worker's own rooms, worker/rooms.js: the same messages), and gives
the links to the other machines, each two data channels through Cloudflare
Realtime SFU. It runs on the page's main thread, where RTCPeerConnection
is; the game's worker reaches it through a bridge (NETWORK.md, "The game's
side"). It knows nothing of the game's traffic: the channels carry what
web_p2p.c frames.

	const net = await hostGame({ id, netVersion, onLink, onUnlink });
	net.invite; // https://<site>/#join=<room>.<secret>
	const net = await joinGame(invite, { id, netVersion, onLink, onUnlink });

onLink(link) gets { peer, id, netVersion, reliable, unreliable }, the two
RTCDataChannels open (binary messages as ArrayBuffers); onUnlink(peer,
reason) when it ends; onClose(error) when the signalling ends (a game goes
on without it, but no one else can join, and links are no longer told of).
*/

const PROTOCOL_VERSION = 1;
const PING_INTERVAL = 30 * 1000;
const CONNECT_TIMEOUT = 30 * 1000;
const RTC_CONFIGURATION = {
	iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
	bundlePolicy: "max-bundle",
};
/* the link's two channels: the same options as the server's (rooms.js) */
const CHANNELS = {
	reliable: { ordered: true },
	unreliable: { ordered: false, maxRetransmits: 0 },
};

export class NetError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/* the room and secret of an invite (a link, its fragment, or
<room>.<secret>), or null */
export function parseInvite(text) {
	const match = /(?:#join=)?([0-9A-HJKMNP-TV-Z]{8})\.([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/i.exec(String(text || ""));
	return match ? { room: match[1].toUpperCase(), secret: match[2] } : null;
}

/* where the signalling is: ?signalling=<URL>, or what the site's Worker says
(GET /net/signalling: the server of port/web/signalling), or the Worker
itself (its own rooms, worker/rooms.js) */
async function signallingAddress() {
	const given = new URLSearchParams(location.search).get("signalling");
	if (given) {
		return given;
	}
	try {
		const answer = await (await fetch("/net/signalling")).json();
		return answer.signalling || location.origin;
	} catch {
		return location.origin;
	}
}

/* hosts a game: resolves once the room takes joiners */
export async function hostGame(options) {
	return connect({ signalling: await signallingAddress(), ...options, room: null, secret: null });
}

/* joins the game of an invite: resolves once the link to the host is open */
export async function joinGame(invite, options) {
	const parsed = parseInvite(invite);
	if (!parsed) {
		throw new NetError("invite", "Not an invite");
	}
	return connect({ signalling: await signallingAddress(), ...options, ...parsed });
}

function connect({
	id,
	netVersion,
	room,
	secret,
	signalling,
	onLink = () => {},
	onUnlink = () => {},
	onClose = () => {},
}) {
	const hosting = room === null;
	const peerConnection = new RTCPeerConnection(RTC_CONFIGURATION);
	const socket = new WebSocket(`${signalling.replace(/^http/, "ws")}/net/rooms/${hosting ? "new" : room}`);
	const links = new Map();
	let settled = false;
	let closed = false;
	let ping = 0;
	let resolveConnect;
	let rejectConnect;
	const connected = new Promise((resolve, reject) => {
		resolveConnect = resolve;
		rejectConnect = reject;
	});
	const timeout = setTimeout(() => fail(new NetError("timeout", "The game did not answer")), CONNECT_TIMEOUT);

	const session = {
		room,
		peer: null,
		invite: null,
		links,
		/* host only: ends a joiner's link (after a kick or ban in the game) */
		drop(peer) {
			send({ type: "drop", peer });
		},
		/* leaves the game: the signalling and every link */
		close() {
			end(null);
			peerConnection.close();
		},
	};

	function send(message) {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(message));
		}
	}

	function settle() {
		if (!settled) {
			settled = true;
			clearTimeout(timeout);
			resolveConnect(session);
		}
	}

	/* the signalling ends; links stay, unless connecting failed */
	function end(error) {
		if (closed) {
			return;
		}
		closed = true;
		clearTimeout(timeout);
		clearInterval(ping);
		socket.close();
		if (!settled) {
			settled = true;
			peerConnection.close();
			rejectConnect(error || new NetError("closed", "Left before connecting"));
		} else {
			onClose(error);
		}
	}

	function fail(error) {
		end(error);
	}

	function unlink(peer, reason) {
		const link = links.get(peer);
		if (link) {
			links.delete(peer);
			link.reliable.close();
			link.unreliable.close();
			onUnlink(peer, reason);
		}
	}

	async function answer(sdp) {
		await peerConnection.setRemoteDescription({ type: "offer", sdp });
		const description = await peerConnection.createAnswer();
		await peerConnection.setLocalDescription(description);
		send({ type: "answer", sdp: description.sdp });
	}

	function link(message) {
		const channels = {};
		for (const [name, options] of Object.entries(CHANNELS)) {
			const channel = peerConnection.createDataChannel(name, { negotiated: true, id: message[name], ...options });
			channel.binaryType = "arraybuffer";
			channels[name] = channel;
		}
		/* the host's subscription to reliable waits for its acknowledgement,
		which the SFU takes and does not pass on (NETWORK.md, "Data
		channels") */
		if (hosting) {
			channels.reliable.addEventListener("open", () => channels.reliable.send("ready"), { once: true });
		}
		const entry = { peer: message.peer, id: message.id, netVersion: message.netVersion, ...channels };
		links.set(message.peer, entry);
		for (const channel of Object.values(channels)) {
			channel.addEventListener("close", () => unlink(message.peer, "failed"), { once: true });
		}
		Promise.all(Object.values(channels).map(opened)).then(() => {
			if (links.get(message.peer) === entry) {
				onLink(entry);
				if (!hosting) {
					settle();
				}
			}
		});
	}

	socket.addEventListener("open", () => {
		send({ type: hosting ? "host" : "join", version: PROTOCOL_VERSION, id, netVersion, ...(hosting ? {} : { secret }) });
		ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send("ping"), PING_INTERVAL);
	});

	socket.addEventListener("message", (event) => {
		if (event.data === "pong") {
			return;
		}
		let message;
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}
		switch (message.type) {
			case "welcome":
				session.room = message.room;
				session.peer = message.peer;
				/* the invite leads to this page's site, wherever the
				signalling is */
				session.invite = message.secret ? `${location.origin}/#join=${message.room}.${message.secret}` : null;
				break;
			case "offer":
				answer(message.sdp).catch((error) => fail(new NetError("rtc", error.message)));
				break;
			case "link":
				link(message);
				break;
			case "unlink":
				unlink(message.peer, message.reason);
				break;
			case "error":
				fail(new NetError(message.code, message.message));
				break;
		}
	});

	socket.addEventListener("close", () => end(settled ? null : new NetError("closed", "The signalling closed")));

	/* the host is ready for joiners once it reaches the SFU */
	peerConnection.addEventListener("connectionstatechange", () => {
		const state = peerConnection.connectionState;
		if (state === "connected" && hosting) {
			settle();
		} else if (state === "failed") {
			for (const peer of [...links.keys()]) {
				unlink(peer, "failed");
			}
			fail(new NetError("rtc", "The connection to the SFU failed"));
		}
	});

	return connected;
}

function opened(channel) {
	if (channel.readyState === "open") {
		return Promise.resolve();
	}
	return new Promise((resolve) => channel.addEventListener("open", resolve, { once: true }));
}
