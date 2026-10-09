/*
LIMITS.TEST.MJS

The relay's limits (main.go; NETWORK.md, "The relay's limits"): tokens,
origins, names, TCP, and what UDP it sends and takes. It builds the relay
(Go), runs it on this machine, with tokens and with private addresses
allowed (so that a peer here can stand for one on the internet), and talks
to it as a page does. Its tokens are the Worker's own (worker/relay.js).

	cd port/web && node --test relay/test/limits.test.mjs
*/

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import dgram from "node:dgram";
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import { makeRelayToken } from "../../worker/relay.js";

const PORT = 8799;
const UDP_PORT = 41000;
/* a STUN server of the test's, and the address the relay says it is at */
const STUN_PORT = 34780;
const PUBLIC_IP = "203.0.113.7";
/* where the relay is told the signalling is (RELAY_SIGNALLING) */
const SIGNALLING_PORT = 8798;
/* its round trips for Prometheus (RELAY_METRICS) */
const METRICS_PORT = 8797;
const SECRET = "a secret for the tests";
const ORIGIN = "http://localhost:8765";
const OUT = { datagram: 1, connected: 2, refused: 3, data: 4, closed: 5, resolved: 6, capped: 7 };

let relay;
let output = "";

before(async () => {
	const binary = join(mkdtempSync(join(tmpdir(), "halo-relay-")), "relay");
	execFileSync("go", ["build", "-o", binary, "."], { cwd: new URL("..", import.meta.url).pathname, stdio: "inherit" });
	relay = spawn(binary, [], {
		env: {
			...process.env, PORT: String(PORT), RELAY_TOKEN_SECRET: SECRET, RELAY_ORIGINS: ORIGIN,
			RELAY_ALLOW_PRIVATE: "1", RELAY_UDP_PORTS: `${UDP_PORT}-${UDP_PORT + 1}`,
			RELAY_STUN: `stun.l.google.com:19302,localhost:${STUN_PORT}`, RELAY_PUBLIC_IP: PUBLIC_IP,
			RELAY_SIGNALLING: `127.0.0.1:${SIGNALLING_PORT}`, RELAY_METRICS: String(METRICS_PORT),
		},
	});
	relay.stdout.on("data", (data) => { output += data; });
	relay.stderr.on("data", (data) => { output += data; });
	while (!output.includes("listening")) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
});

after(() => relay.kill());

/* what a test opened, closed after it (pass or fail: an open socket keeps
the run going) */
const opened = [];
afterEach(() => {
	for (const thing of opened.splice(0)) {
		try {
			thing.close();
		} catch {}
	}
});

async function udpSocket(address = "127.0.0.1") {
	const socket = dgram.createSocket("udp4");
	opened.push(socket);
	await new Promise((resolve) => socket.bind(0, address, resolve));
	return socket;
}

/* this machine's address on its network: another address than 127.0.0.1,
for a stranger */
const LAN_ADDRESS = Object.values(networkInterfaces()).flat()
	.find((entry) => entry.family === "IPv4" && !entry.internal)?.address;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* a page: its WebSocket, and the messages it got */
function page({ token, origin = ORIGIN, edge } = {}) {
	return new Promise((resolve) => {
		const url = `ws://127.0.0.1:${PORT}/${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`;
		/* (on Fly.io, its edge's region: Fly-Region) */
		const socket = new WebSocket(url, { origin, headers: edge ? { "Fly-Region": edge } : {} });
		opened.push(socket);
		const messages = [];
		const page = { socket, messages, opened: true, pings: 0 };
		socket.on("message", (data) => {
			const bytes = Buffer.from(data);
			if (bytes[0] === 0x7f) {
				socket.send(bytes);
				page.pings++;
			} else {
				messages.push(bytes);
			}
		});
		socket.on("open", () => resolve(page));
		socket.on("unexpected-response", (request, response) => resolve({ opened: false, status: response.statusCode }));
		socket.on("error", () => resolve({ opened: false }));
	});
}

function send(socket, type, ...parts) {
	socket.send(Buffer.concat([Buffer.from([type]), ...parts]));
}

const u32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value >>> 0); return bytes; };
const u16 = (value) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
const LOCALHOST = 0x7f000001;

/* a tunnel packet's shape (p2p.c): magic, identifier, number, sealed */
function tunnelPacket(number, size = 64) {
	const packet = Buffer.alloc(size);
	packet[0] = 0x69;
	packet.writeBigUInt64LE(BigInt(number), 7);
	return packet;
}

async function until(check, time = 2000) {
	const end = Date.now() + time;
	while (!check() && Date.now() < end) {
		await sleep(20);
	}
	return check();
}

test("a page without a token is refused", async () => {
	assert.equal((await page()).status, 401);
	assert.equal((await page({ token: "1.abcdefghijklmnop.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })).status, 401);
});

test("a token another secret signed is refused", async () => {
	assert.equal((await page({ token: await makeRelayToken("another secret") })).status, 401);
});

test("an expired token is refused", async () => {
	assert.equal((await page({ token: await makeRelayToken(SECRET, Date.now() - 120 * 1000) })).status, 401);
});

test("a page of another site is refused", async () => {
	assert.equal((await page({ token: await makeRelayToken(SECRET), origin: "https://elsewhere.example" })).status, 403);
});

test("a token is taken once", async () => {
	const token = await makeRelayToken(SECRET);
	const first = await page({ token });
	assert.ok(first.opened);
	assert.equal((await page({ token })).status, 401);
	first.socket.close();
});

test("only the brokers' and STUN servers' names are looked up", async () => {
	const { socket, messages } = await page({ token: await makeRelayToken(SECRET) });
	send(socket, 5, u32(1), Buffer.from("example.com"));
	send(socket, 5, u32(2), Buffer.from("stun.l.google.com"));
	assert.ok(await until(() => messages.filter((m) => m[0] === OUT.resolved).length === 2, 5000));
	const answers = Object.fromEntries(messages.filter((m) => m[0] === OUT.resolved)
		.map((m) => [m.readUInt32BE(1), m.readUInt32BE(5)]));
	assert.equal(answers[1], 0);
	assert.notEqual(answers[2], 0);
	socket.close();
});

test("TCP reaches only the brokers", async () => {
	const { socket, messages } = await page({ token: await makeRelayToken(SECRET) });
	send(socket, 2, u32(7), u32(LOCALHOST), u16(PORT));
	assert.ok(await until(() => messages.some((m) => m[0] === OUT.refused && m.readUInt32BE(1) === 7)));
	socket.close();
});

test("UDP: tunnel packets go, other datagrams do not; only those sent to answer", { skip: !LAN_ADDRESS && "no network address" }, async () => {
	const peer = await udpSocket();
	const stranger = await udpSocket(LAN_ADDRESS);
	const got = [];
	peer.on("message", (data, from) => {
		got.push(data);
		peer.send(tunnelPacket(1000 + got.length), from.port, from.address);
	});
	const { socket, messages } = await page({ token: await makeRelayToken(SECRET) });
	const peerPort = peer.address().port;

	send(socket, 1, u32(3), u32(LOCALHOST), u16(peerPort), Buffer.from("not a tunnel packet, padded to 40 bytes."));
	send(socket, 1, u32(3), u32(LOCALHOST), u16(peerPort), tunnelPacket(1));
	assert.ok(await until(() => got.length === 1));
	assert.equal(got[0][0], 0x69);
	/* (the peer's answer reaches the page) */
	assert.ok(await until(() => messages.some((m) => m[0] === OUT.datagram)));

	/* a stranger's datagram (from an address the page never sent to) to the
	page's socket here does not */
	const before = messages.filter((m) => m[0] === OUT.datagram).length;
	stranger.send(tunnelPacket(5), UDP_PORT, LAN_ADDRESS);
	await sleep(300);
	assert.equal(messages.filter((m) => m[0] === OUT.datagram).length, before);
	socket.close();
	peer.close();
	stranger.close();
});

test("UDP: a peer behind a NAT answers from another port of its address, and gets through", async () => {
	const peer = await udpSocket();
	const otherPort = await udpSocket();
	const { socket, messages } = await page({ token: await makeRelayToken(SECRET) });
	/* (the page sends to the port STUN told it; the peer's NAT answers from
	another) */
	peer.on("message", (data, from) => otherPort.send(tunnelPacket(2000), from.port, from.address));
	send(socket, 1, u32(6), u32(LOCALHOST), u16(peer.address().port), tunnelPacket(1));
	assert.ok(await until(() => messages.some((m) => m[0] === OUT.datagram &&
		m.readUInt16BE(9) === otherPort.address().port)));
});

test("UDP: a destination that never answers gets at most a few hundred", async () => {
	const silent = await udpSocket();
	let count = 0;
	silent.on("message", () => count++);
	const { socket } = await page({ token: await makeRelayToken(SECRET) });
	for (let index = 0; index < 400; index++) {
		send(socket, 1, u32(4), u32(LOCALHOST), u16(silent.address().port), tunnelPacket(index));
	}
	await sleep(1000);
	assert.equal(count, 200);
	socket.close();
	silent.close();
});

test("a session's UDP rate is capped", async () => {
	const sink = await udpSocket();
	let count = 0;
	/* (it answers each, so the unanswered cap does not stop them) */
	sink.on("message", (data, from) => {
		count++;
		sink.send(tunnelPacket(count), from.port, from.address);
	});
	const { socket } = await page({ token: await makeRelayToken(SECRET) });
	/* 3000 at 10,000 a second (100 each 10 ms: the sink answers each well
	before 200 are unanswered) */
	for (let batch = 0; batch < 30; batch++) {
		for (let index = 0; index < 100; index++) {
			send(socket, 1, u32(5), u32(LOCALHOST), u16(sink.address().port), tunnelPacket(batch * 100 + index, 32));
		}
		await sleep(10);
	}
	await sleep(500);
	/* a second's worth (200), and what refilled in the 0.3 s they came over */
	assert.ok(count >= 180 && count <= 450, `${count} went`);
	socket.close();
	sink.close();
});

test("a session's UDP from its peers is capped too", async () => {
	const flooder = await udpSocket();
	const { socket, messages } = await page({ token: await makeRelayToken(SECRET) });
	/* (the page sends it one: it may answer) */
	let relayPort = 0;
	flooder.on("message", (data, from) => { relayPort = from.port; });
	send(socket, 1, u32(7), u32(LOCALHOST), u16(flooder.address().port), tunnelPacket(1));
	assert.ok(await until(() => relayPort));
	for (let index = 0; index < 3000; index++) {
		flooder.send(tunnelPacket(index), relayPort, "127.0.0.1");
	}
	await sleep(1000);
	const count = messages.filter((m) => m[0] === OUT.datagram).length;
	/* a second's worth (500), and what refilled while they came */
	assert.ok(count >= 400 && count <= 1200, `${count} came in`);
	/* and the page is told once, with the cap, for its status bar */
	const capped = messages.filter((m) => m[0] === OUT.capped);
	assert.equal(capped.length, 1, `${capped.length} capped notices`);
	assert.equal(capped[0].readUInt32BE(1), 256 << 10);
});

test("STUN's answers tell the page the relay's public address", async () => {
	/* a STUN server that saw 198.51.100.9:1234 (XOR-MAPPED-ADDRESS) */
	const server = dgram.createSocket("udp4");
	opened.push(server);
	await new Promise((resolve) => server.bind(STUN_PORT, "127.0.0.1", resolve));
	server.on("message", (request, from) => {
		const answer = Buffer.alloc(32);
		answer.writeUInt16BE(0x0101, 0);
		answer.writeUInt16BE(12, 2);
		request.copy(answer, 4, 4, 20);
		answer.writeUInt16BE(0x0020, 20);
		answer.writeUInt16BE(8, 22);
		answer.writeUInt16BE(0x0001, 24);
		answer.writeUInt16BE(1234 ^ 0x2112, 26);
		answer.writeUInt32BE((0xc6336409 ^ 0x2112a442) >>> 0, 28);
		server.send(answer, from.port, from.address);
	});
	const { socket, messages } = await page({ token: await makeRelayToken(SECRET) });
	send(socket, 5, u32(1), Buffer.from("localhost"));
	assert.ok(await until(() => messages.some((m) => m[0] === OUT.resolved && m.readUInt32BE(5) === LOCALHOST)));
	const request = Buffer.alloc(20);
	request.writeUInt16BE(0x0001, 0);
	request.writeUInt32BE(0x2112a442, 4);
	send(socket, 1, u32(9), u32(LOCALHOST), u16(STUN_PORT), request);
	assert.ok(await until(() => messages.some((m) => m[0] === OUT.datagram)));
	const answer = messages.find((m) => m[0] === OUT.datagram).subarray(11);
	const port = answer.readUInt16BE(26) ^ 0x2112;
	const address = (answer.readUInt32BE(28) ^ 0x2112a442) >>> 0;
	assert.equal(address, 0xcb007107);
	assert.ok(port === UDP_PORT || port === UDP_PORT + 1, `port ${port}`);
});

test("the rooms' WebSockets go to the signalling, as they are", async () => {
	/* a signalling that says what it was asked, and echoes */
	const signalling = new WebSocketServer({ port: SIGNALLING_PORT, host: "127.0.0.1" });
	opened.push(signalling);
	signalling.on("connection", (socket, request) => {
		socket.send(JSON.stringify({ path: request.url, origin: request.headers.origin, from: request.headers["fly-client-ip"] }));
		socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
	});
	await new Promise((resolve) => signalling.on("listening", resolve));

	/* (no token: the relay's are for its own sessions) */
	const socket = new WebSocket(`ws://127.0.0.1:${PORT}/net/rooms/new`, { origin: ORIGIN, headers: { "Fly-Client-IP": "198.51.100.9" } });
	opened.push(socket);
	const messages = [];
	socket.on("message", (data) => messages.push(data.toString()));
	await new Promise((resolve, reject) => socket.on("open", resolve).on("error", reject));
	socket.send("ping");
	assert.ok(await until(() => messages.length === 2));
	assert.deepEqual(JSON.parse(messages[0]), { path: "/net/rooms/new", origin: ORIGIN, from: "198.51.100.9" });
	assert.equal(messages[1], "ping");

	/* and nothing else does */
	assert.equal((await fetch(`http://127.0.0.1:${PORT}/net/relay`)).status, 404);
});

/* a histogram's count and sum for an edge, from the relay's /metrics */
async function metric(name, edge) {
	const text = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text();
	const value = (suffix) => Number(text.match(new RegExp(`^${name}_${suffix}\\{edge="${edge}"\\} (\\S+)$`, "m"))?.[1] ?? 0);
	return { count: value("count"), sum: value("sum") };
}

test("a peer's round trip, as the page tells it, is counted less the page's own", async () => {
	const peer = await udpSocket();
	const page_ = await page({ token: await makeRelayToken(SECRET), edge: "lhr" });
	/* (the relay's first ping, a second in: the page's round trip) */
	assert.ok(await until(() => page_.pings > 0, 3000));
	const before = await metric("relay_peer_round_trip_seconds", "lhr");
	const game = await metric("relay_game_round_trip_seconds", "lhr");
	/* a peer the page never sent to is not believed */
	send(page_.socket, 6, u32(0x0a000009), u16(5000), u32(80));
	/* one it did is */
	send(page_.socket, 1, u32(7), u32(LOCALHOST), u16(peer.address().port), tunnelPacket(1));
	await sleep(100);
	send(page_.socket, 6, u32(LOCALHOST), u16(peer.address().port), u32(80));
	await sleep(200);
	const after = await metric("relay_peer_round_trip_seconds", "lhr");
	assert.equal(after.count, before.count + 1);
	assert.equal((await metric("relay_game_round_trip_seconds", "lhr")).count, game.count + 1);
	/* (80 ms, less this machine's round trip to the page: a few at most) */
	const peerTrip = after.sum - before.sum;
	assert.ok(peerTrip > 0.06 && peerTrip <= 0.08, `peer round trip ${peerTrip}`);
	/* (the page's own, counted by its edge too) */
	assert.ok((await metric("relay_page_round_trip_seconds", "lhr")).count >= 1);
});

test("the metrics are not on the public port", async () => {
	assert.equal((await fetch(`http://127.0.0.1:${PORT}/metrics`)).status, 404);
});
