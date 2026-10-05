/*
ROOMS.JS

Signalling for network play between browsers (NETWORK.md): one GameRoom
Durable Object for each hosted game. Pages talk to it over a WebSocket, in
the JSON messages of NETWORK.md, and it sets up their links through
Cloudflare Realtime SFU, whose app token only it holds. Game traffic never
comes here: it goes between the pages through the SFU's data channels.

The room keeps what it must across hibernation (the Durable Object sleeps
while no message comes, which is most of a game) in storage (`room`) and in
each WebSocket's attachment (its page), not in memory.

TODO: remove these rooms (this file's GameRoom and handleRooms, and what
wrangler.toml has for them) once the pages have moved to the signalling's
server and it has run a while: NETWORK.md, "Removing the Worker's rooms".

The same rooms as a server of our own: port/web/signalling (Elixir), on the
relay's machine, which speaks these messages too (its test,
signalling/test/rooms.test.mjs, runs against either). The pages use it
when wrangler.toml's SIGNALLING_URL says where it is (handleSignalling,
below), and these rooms when it does not. What it is for, and a Durable
Object does not give:
- a live server browser: a "lobby" that each room updates with its game
  (hosts would send it the map, the game type and the players), which
  pages watch. Here that would be one more Durable Object, a directory,
  that rooms report to (see `welcome` in host());
- a host that reconnects to its room (a room here ends when its host's
  WebSocket closes).
*/

import { DurableObject } from "cloudflare:workers";

const PROTOCOL_VERSION = 1;
const SFU_API = "https://rtc.live.cloudflare.com/v1";
const ROOM_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const HOST_PEER = 0;
/* 16 machines: the browser host has a page's bandwidth, not a server's */
const MAXIMUM_JOINERS = 15;
/* a page that has not answered the SFU's offer by then is closed */
const ANSWER_TIMEOUT = 30 * 1000;
const SFU_TIMEOUT = 10 * 1000;

/* the link's two channels (NETWORK.md, "Data channels") */
const CHANNELS = {
	reliable: { ordered: true },
	unreliable: { ordered: false, maxRetransmits: 0 },
};

class RoomError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/* a new room's code: 8 characters of Crockford's base 32 */
export function newRoomCode() {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte & 31]).join("");
}

export function isRoomCode(text) {
	return ROOM_CODE.test(text);
}

function randomSecret() {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* compares two strings in a time that does not depend on where they differ */
function sameSecret(a, b) {
	if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
		return false;
	}
	let difference = 0;
	for (let index = 0; index < a.length; index++) {
		difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return difference === 0;
}

function isIdentifier(value) {
	return typeof value === "string" && /^[0-9a-f]{12}$/.test(value);
}

function isNetVersion(value) {
	return Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

export class GameRoom extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.room = null;
		ctx.blockConcurrencyWhile(async () => {
			this.room = (await ctx.storage.get("room")) || null;
		});
		/* answered without waking the room (NETWORK.md, "Signalling messages") */
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	/* the Worker hands over a page's WebSocket upgrade: role "host" (a new
	room, `code`) or "join" */
	async fetch(request) {
		const url = new URL(request.url);
		const role = url.searchParams.get("role");
		const code = url.searchParams.get("room");
		if (request.headers.get("Upgrade") !== "websocket" || (role !== "host" && role !== "join") || !isRoomCode(code)) {
			return new Response("Expected a WebSocket", { status: 426 });
		}
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		pair[1].serializeAttachment({ role, code, stage: "new" });
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(socket, message) {
		const page = socket.deserializeAttachment();
		try {
			let data;
			try {
				data = typeof message === "string" ? JSON.parse(message) : null;
			} catch {
				data = null;
			}
			if (!data || typeof data.type !== "string") {
				throw new RoomError("protocol", "Expected a JSON object with a type");
			}

			if (page.stage === "new" && page.role === "host" && data.type === "host") {
				await this.host(socket, page, data);
			} else if (page.stage === "new" && page.role === "join" && data.type === "join") {
				await this.join(socket, page, data);
			} else if (page.stage === "offered" && data.type === "answer") {
				await this.answer(socket, page, data);
			} else if (page.stage === "ready" && page.role === "host" && data.type === "drop") {
				await this.drop(data.peer);
			} else {
				throw new RoomError("protocol", `Unexpected ${data.type}`);
			}
		} catch (error) {
			await this.fail(socket, error);
		}
	}

	async webSocketClose(socket) {
		await this.pageGone(socket);
	}

	async webSocketError(socket) {
		await this.pageGone(socket);
	}

	/* closes the pages that did not answer the SFU's offer in time */
	async alarm() {
		const now = Date.now();
		let next = 0;
		for (const socket of this.ctx.getWebSockets()) {
			const page = socket.deserializeAttachment();
			if (page.stage !== "new" && page.stage !== "offered") {
				continue;
			}
			const due = (page.since || now) + ANSWER_TIMEOUT;
			if (due <= now) {
				await this.fail(socket, new RoomError("timeout", "No answer to the offer"));
			} else if (!next || due < next) {
				next = due;
			}
		}
		if (next) {
			await this.ctx.storage.setAlarm(next);
		}
	}

	async host(socket, page, data) {
		this.checkHello(data);
		if (this.room) {
			throw new RoomError("protocol", "The room already has a host");
		}
		const secret = randomSecret();
		this.room = {
			code: page.code,
			secret,
			id: data.id,
			netVersion: data.netVersion,
			session: null,
			ready: false,
		};
		await this.ctx.storage.put("room", this.room);
		Object.assign(page, { peer: HOST_PEER, id: data.id, netVersion: data.netVersion });
		socket.serializeAttachment(page);

		this.send(socket, {
			type: "welcome",
			room: page.code,
			peer: HOST_PEER,
			secret,
		});
		/* a server browser would learn of the room here (see the note at the
		start of this file) */
		await this.offer(socket, page);
		this.room.session = page.session;
		await this.ctx.storage.put("room", this.room);
	}

	async join(socket, page, data) {
		this.checkHello(data);
		const room = this.room;
		if (!room) {
			throw new RoomError("not-found", "No such game");
		}
		if (!sameSecret(data.secret, room.secret)) {
			throw new RoomError("secret", "The invite is not this game's");
		}
		if (data.netVersion !== room.netVersion) {
			throw new RoomError("version", `The host plays network version ${room.netVersion}, this page ${data.netVersion}`);
		}
		if (!room.ready) {
			throw new RoomError("not-ready", "The host is still connecting");
		}

		/* the peer number is taken before any await, so that two joins at
		once do not take the same one */
		const pages = this.pages().filter((other) => other.socket !== socket);
		if (pages.some((other) => other.page.id === data.id)) {
			throw new RoomError("duplicate", "A machine with this identifier is already in the game");
		}
		const taken = new Set(pages.map((other) => other.page.peer));
		let peer = 1;
		while (taken.has(peer)) {
			peer++;
		}
		if (peer > MAXIMUM_JOINERS) {
			throw new RoomError("full", "The game is full");
		}
		Object.assign(page, { peer, id: data.id, netVersion: data.netVersion });
		socket.serializeAttachment(page);

		this.send(socket, { type: "welcome", room: room.code, peer });
		await this.offer(socket, page);
	}

	/* makes the page's SFU session and sends it the SFU's offer */
	async offer(socket, page) {
		page.since = Date.now();
		socket.serializeAttachment(page);
		await this.ctx.storage.setAlarm(page.since + ANSWER_TIMEOUT);

		const session = await this.sfuRequest("POST", "/sessions/new");
		const established = await this.sfuRequest("POST", `/sessions/${session.sessionId}/datachannels/establish`, {
			dataChannel: { location: "remote", dataChannelName: "server-events" },
		});
		const description = established.sessionDescription;
		if (!session.sessionId || !description || description.type !== "offer") {
			throw new RoomError("sfu", "The SFU did not offer a connection");
		}
		Object.assign(page, { session: session.sessionId, stage: "offered" });
		socket.serializeAttachment(page);
		this.send(socket, { type: "offer", sdp: description.sdp });
	}

	async answer(socket, page, data) {
		if (typeof data.sdp !== "string") {
			throw new RoomError("protocol", "An answer needs its sdp");
		}
		await this.sfuRequest("PUT", `/sessions/${page.session}/renegotiate`, {
			sessionDescription: { type: "answer", sdp: data.sdp },
		});
		page.stage = "ready";
		socket.serializeAttachment(page);

		if (page.role === "host") {
			this.room.ready = true;
			await this.ctx.storage.put("room", this.room);
		} else {
			await this.link(socket, page);
		}
	}

	/* a joiner publishes the link's channels and the host subscribes to them,
	able to reply (NETWORK.md, "Data channels") */
	async link(socket, page) {
		const host = this.hostSocket();
		if (!host) {
			throw new RoomError("closed", "The host left");
		}
		const names = Object.keys(CHANNELS);
		const published = await this.sfuRequest("POST", `/sessions/${page.session}/datachannels/new`, {
			dataChannels: names.map((name) => ({ location: "local", dataChannelName: name, ...CHANNELS[name] })),
		});
		const subscribed = await this.sfuRequest("POST", `/sessions/${this.room.session}/datachannels/new`, {
			dataChannels: names.map((name) => ({
				location: "remote",
				sessionId: page.session,
				dataChannelName: name,
				...CHANNELS[name],
				canReply: true,
				...(name === "reliable" ? { waitForAck: true } : {}),
			})),
		});
		const joinerIds = this.channelIds(published, names);
		const hostIds = this.channelIds(subscribed, names);

		page.hostChannels = names.map((name) => hostIds[name]);
		page.stage = "linked";
		socket.serializeAttachment(page);

		this.send(socket, {
			type: "link",
			peer: HOST_PEER,
			id: this.room.id,
			netVersion: this.room.netVersion,
			...joinerIds,
		});
		this.send(host, { type: "link", peer: page.peer, id: page.id, netVersion: page.netVersion, ...hostIds });
	}

	/* the host ends a joiner's link */
	async drop(peer) {
		const joiner = this.pages().find((other) => other.page.role === "join" && other.page.peer === peer);
		if (joiner) {
			await this.fail(joiner.socket, new RoomError("dropped", "The host dropped this machine"));
		}
	}

	async pageGone(socket, reason = "left") {
		const page = socket.deserializeAttachment();
		if (page.gone) {
			return;
		}
		page.gone = true;
		socket.serializeAttachment(page);
		try {
			socket.close(1000, reason);
		} catch {
			/* already closed */
		}

		if (page.role === "host" && page.peer === HOST_PEER) {
			/* the room ends: links made keep working, but no one else joins */
			for (const other of this.pages()) {
				await this.fail(other.socket, new RoomError("closed", "The host left"));
			}
			this.room = null;
			await this.ctx.storage.deleteAll();
			return;
		}
		if (page.role === "join" && page.stage === "linked") {
			const host = this.hostSocket();
			if (host) {
				this.send(host, { type: "unlink", peer: page.peer, reason });
			}
			if (this.room && this.room.session && page.hostChannels) {
				await this.sfuRequest("PUT", `/sessions/${this.room.session}/datachannels/close`, {
					dataChannels: page.hostChannels.map((id) => ({ id })),
				}).catch(() => {});
			}
		}
	}

	/* the open pages that have said who they are, with their sockets */
	pages() {
		return this.ctx
			.getWebSockets()
			.map((socket) => ({ socket, page: socket.deserializeAttachment() }))
			.filter(({ page }) => !page.gone && page.peer !== undefined);
	}

	hostSocket() {
		const host = this.pages().find(({ page }) => page.role === "host");
		return host ? host.socket : null;
	}

	checkHello(data) {
		if (data.version !== PROTOCOL_VERSION) {
			throw new RoomError("version", `This server speaks version ${PROTOCOL_VERSION} of the protocol`);
		}
		if (!isIdentifier(data.id) || !isNetVersion(data.netVersion)) {
			throw new RoomError("protocol", "Expected an id (12 hex digits) and a netVersion");
		}
	}

	channelIds(result, names) {
		const ids = {};
		const channels = Array.isArray(result.dataChannels) ? result.dataChannels : [];
		names.forEach((name, index) => {
			const channel = channels.find((item) => item && item.dataChannelName === name) || channels[index];
			if (!channel || channel.errorCode || !Number.isInteger(channel.id)) {
				throw new RoomError("sfu", `The SFU did not make the ${name} channel`);
			}
			ids[name] = channel.id;
		});
		return ids;
	}

	async sfuRequest(method, path, body) {
		const { REALTIME_APP_ID: appId, REALTIME_APP_TOKEN: token } = this.env;
		if (!appId || !token) {
			throw new RoomError("sfu", "The server has no Realtime SFU app (REALTIME_APP_ID, REALTIME_APP_TOKEN)");
		}
		let response;
		try {
			/* (SFU_API: the SFU of signalling/test/rooms.test.mjs) */
			response = await fetch(`${this.env.SFU_API || SFU_API}/apps/${encodeURIComponent(appId)}${path}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(SFU_TIMEOUT),
			});
		} catch {
			throw new RoomError("sfu", `The SFU did not answer ${path}`);
		}
		const payload = await response.json().catch(() => null);
		if (!response.ok || !payload || payload.errorCode) {
			const detail = payload && payload.errorCode ? `${payload.errorCode} ${payload.errorDescription || ""}` : response.status;
			console.error(`SFU ${method} ${path}: ${detail}`);
			throw new RoomError("sfu", "The SFU refused the request");
		}
		return payload;
	}

	send(socket, message) {
		try {
			socket.send(JSON.stringify(message));
		} catch {
			/* the page is gone: webSocketClose follows */
		}
	}

	/* tells the page why, and lets it go */
	async fail(socket, error) {
		const code = error instanceof RoomError ? error.code : "protocol";
		if (!(error instanceof RoomError)) {
			console.error(error);
		}
		this.send(socket, { type: "error", code, message: error.message });
		await this.pageGone(socket, code === "dropped" ? "dropped" : "failed");
	}
}

/* refuses a page's WebSocket with a reason it can show (an HTTP error would
reach it only as a WebSocket that failed) */
function refuse(code, message) {
	const pair = new WebSocketPair();
	pair[1].accept();
	pair[1].send(JSON.stringify({ type: "error", code, message }));
	pair[1].close(1008, code);
	return new Response(null, { status: 101, webSocket: pair[0] });
}

/* GET /net/signalling: where the pages' signalling is (halo_net.js):
{ "signalling": "https://..." } for the server of port/web/signalling
(SIGNALLING_URL), or null for the rooms here */
export function handleSignalling(request, env) {
	return new Response(JSON.stringify({ signalling: env.SIGNALLING_URL || null }), {
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

/* the Worker's part: /net/rooms/new (host) and /net/rooms/<code> (join) */
export async function handleRooms(request, env, url) {
	if (request.headers.get("Upgrade") !== "websocket") {
		return new Response("Expected a WebSocket", { status: 426 });
	}
	/* only the site's own pages may use the SFU through it */
	if (request.headers.get("Origin") !== url.origin) {
		return new Response("Forbidden", { status: 403 });
	}
	const match = /^\/net\/rooms\/([^/]+)$/.exec(url.pathname);
	if (!match) {
		return new Response("Not found", { status: 404 });
	}
	const role = match[1] === "new" ? "host" : "join";
	const code = role === "host" ? newRoomCode() : match[1].toUpperCase();
	if (!isRoomCode(code)) {
		return new Response("Not found", { status: 404 });
	}
	/* (each room and join is SFU sessions on this account's bill: wrangler.toml) */
	const limit = role === "host" ? env.HOST_LIMIT : env.JOIN_LIMIT;
	const address = request.headers.get("CF-Connecting-IP") || "local";
	if (limit && !(await limit.limit({ key: address })).success) {
		return refuse("busy", role === "host" ?
			"Too many games from this address: try again in a minute" :
			"Too many joins from this address: try again in a minute");
	}
	const room = env.ROOMS.get(env.ROOMS.idFromName(code));
	const forward = new URL("https://room/");
	forward.search = new URLSearchParams({ role, room: code }).toString();
	return room.fetch(new Request(forward, request));
}
