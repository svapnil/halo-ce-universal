/*
ROOMS.TEST.MJS

The signalling's messages (NETWORK.md, "Signalling messages"), against
either server that speaks them: this one (Elixir), or the Worker's rooms
(worker/rooms.js), so that the two stay the same to a page. It runs the
server on this machine, with an SFU of the test's own, and talks to it as
pages do.

	cd port/web && node --test signalling/test/rooms.test.mjs
	cd port/web && SERVER=worker node --test signalling/test/rooms.test.mjs

SERVER=machine runs Fly.io's image instead (Dockerfile, which it builds;
Docker must be running): the same server as the machine has it, reached
through the relay's port.
*/

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

const SERVER = process.env.SERVER || "elixir";
const PORT = 8796;
const SFU_PORT = 8795;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ANSWER_TIMEOUT = 1500;
/* how long a room waits for a host whose WebSocket was lost */
const HOST_GRACE = 1500;
/* (32 as deployed: more than an address's rooms and joins of one minute) */
const PAGES_AT_ONCE = 20;
const WEB = new URL("../..", import.meta.url).pathname;
const MACHINE = "halo-web-machine-test";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- the test's SFU: Realtime's calls, as rooms.js makes them */

const sfu = { calls: [], sessions: 0, channels: 100, fail: null };

const sfuServer = createServer(async (request, response) => {
	let text = "";
	for await (const chunk of request) {
		text += chunk;
	}
	const path = request.url.replace(/^\/apps\/[^/]+/, "");
	const body = text ? JSON.parse(text) : null;
	const authorized = /^Bearer .+/.test(request.headers.authorization || "");
	sfu.calls.push({ method: request.method, path, body, authorized });

	let answer = {};
	let match;
	if (sfu.fail && path.includes(sfu.fail)) {
		answer = { errorCode: "test", errorDescription: "The test's SFU fails this" };
	} else if (request.method === "POST" && path === "/sessions/new") {
		answer = { sessionId: `session${++sfu.sessions}` };
	} else if ((match = /^\/sessions\/(\w+)\/datachannels\/establish$/.exec(path))) {
		answer = { sessionDescription: { type: "offer", sdp: `offer for ${match[1]}` } };
	} else if (/^\/sessions\/\w+\/datachannels\/new$/.test(path)) {
		answer = { dataChannels: body.dataChannels.map((channel) => ({ dataChannelName: channel.dataChannelName, id: ++sfu.channels })) };
	}
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(answer));
});

const called = (method, pattern) => sfu.calls.filter((call) => call.method === method && pattern.test(call.path));

/* ---------- the server */

let server;
let output = "";

function start() {
	const sfuApi = `http://127.0.0.1:${SFU_PORT}`;
	if (SERVER === "worker") {
		return spawn("npx", [
			"wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--inspector-port", "0",
			"--persist-to", mkdtempSync(join(tmpdir(), "halo-rooms-")),
			"--var", `SFU_API:${sfuApi}`, "--var", "REALTIME_APP_ID:test", "--var", "REALTIME_APP_TOKEN:token",
		], { cwd: WEB });
	}
	const settings = {
		SIGNALLING_PORT: String(PORT), SIGNALLING_ORIGINS: ORIGIN, SFU_API: sfuApi,
		SIGNALLING_ANSWER_TIMEOUT: String(ANSWER_TIMEOUT), SIGNALLING_PAGES_AT_ONCE: String(PAGES_AT_ONCE),
		SIGNALLING_HOST_GRACE: String(HOST_GRACE),
		REALTIME_APP_ID: "test", REALTIME_APP_TOKEN: "token",
	};
	if (SERVER === "machine") {
		execFileSync("docker", ["build", "-q", "-t", MACHINE, "."], { cwd: WEB, stdio: "inherit" });
		/* (the relay's port is the machine's; the test's SFU is on this
		computer, outside the container) */
		Object.assign(settings, {
			SIGNALLING_PORT: "8791", RELAY_SIGNALLING: "127.0.0.1:8791", RELAY_INSECURE: "1",
			SFU_API: `http://host.docker.internal:${SFU_PORT}`,
		});
		return spawn("docker", [
			"run", "--rm", "--name", MACHINE, "-p", `127.0.0.1:${PORT}:8790`,
			...Object.entries(settings).flatMap(([name, value]) => ["-e", `${name}=${value}`]), MACHINE,
		]);
	}
	return spawn("mix", ["run", "--no-halt"], { cwd: join(WEB, "signalling"), env: { ...process.env, ...settings } });
}

before(async () => {
	await new Promise((resolve) => sfuServer.listen(SFU_PORT, "127.0.0.1", resolve));
	server = start();
	server.stdout.on("data", (data) => { output += data; });
	server.stderr.on("data", (data) => { output += data; });
	/* (the rooms' address answers 426 to what is not a WebSocket: on the
	machine, the relay answers before the signalling has started) */
	const end = Date.now() + 60000;
	for (;;) {
		const status = await fetch(`${ORIGIN}/net/rooms/new`, { headers: { Origin: ORIGIN } })
			.then((response) => response.status, () => 0);
		if (status === 426) {
			break;
		}
		assert.ok(Date.now() < end && server.exitCode === null, `the server did not start:\n${output}`);
		await sleep(200);
	}
});

after(() => {
	if (SERVER === "machine") {
		try {
			execFileSync("docker", ["rm", "-f", MACHINE], { stdio: "ignore" });
		} catch {
			/* (already going) */
		}
	}
	server?.kill();
	sfuServer.close();
	/* (the server's connections to it, kept open, would keep the test) */
	sfuServer.closeAllConnections();
});

/* ---------- pages */

const opened = [];
afterEach(async () => {
	for (const socket of opened.splice(0)) {
		socket.close();
	}
	sfu.fail = null;
	/* (the rooms end with their pages) */
	await sleep(100);
});

/* each test's pages come from an address of its own: an address makes at
most 5 rooms and 20 joins a minute */
let addresses = 0;
let address = "";
function newAddress() {
	address = `198.51.100.${++addresses}`;
}

/* a page's WebSocket to /net/rooms/<name>: what it got, and its end */
function page(name, { origin = ORIGIN, from = address } = {}) {
	return new Promise((resolve) => {
		const socket = new WebSocket(`ws://127.0.0.1:${PORT}/net/rooms/${name}`, {
			origin, headers: { "Fly-Client-IP": from, "CF-Connecting-IP": from },
		});
		opened.push(socket);
		const result = { socket, messages: [], texts: [], closed: null, opened: true, taken: 0 };
		socket.on("message", (data, isBinary) => {
			const text = isBinary ? null : data.toString();
			if (text === "pong") {
				result.texts.push(text);
			} else {
				result.messages.push(JSON.parse(text));
			}
		});
		socket.on("close", (code, reason) => { result.closed = { code, reason: reason.toString() }; });
		socket.on("open", () => resolve(result));
		socket.on("unexpected-response", (request, response) => resolve({ opened: false, status: response.statusCode }));
		socket.on("error", () => resolve({ opened: false }));
		result.send = (message) => socket.send(typeof message === "string" ? message : JSON.stringify(message));
		/* the page's next message (of that type), in the order they came */
		result.next = async (type) => {
			const end = Date.now() + 5000;
			while (result.messages.length <= result.taken) {
				assert.ok(Date.now() < end, `no ${type} came: ${JSON.stringify(result.messages)}, ${JSON.stringify(result.closed)}`);
				await sleep(10);
			}
			const message = result.messages[result.taken++];
			assert.equal(message.type, type, JSON.stringify(message));
			return message;
		};
		result.error = async (code) => {
			const message = await result.next("error");
			assert.equal(message.code, code, message.message);
			await until(() => result.closed);
			return message;
		};
	});
}

async function until(check, time = 5000) {
	const end = Date.now() + time;
	while (!check()) {
		assert.ok(Date.now() < end, "it did not happen");
		await sleep(10);
	}
}

const HOST_ID = "0123456789ab";
const hello = (type, id, extra = {}) => ({ type, version: 1, id, netVersion: 7, ...extra });
const joinerId = (number) => number.toString(16).padStart(12, "0");

/* a host's page, whose room takes joiners */
async function host({ answer = true } = {}) {
	const page_ = await page("new");
	assert.ok(page_.opened);
	page_.send(hello("host", HOST_ID));
	page_.welcome = await page_.next("welcome");
	page_.offer = await page_.next("offer");
	if (answer) {
		page_.send({ type: "answer", sdp: "the host's answer" });
		await until(() => called("PUT", /renegotiate$/).some((call) => page_.offer.sdp.endsWith(call.path.split("/")[2])));
		/* (the Worker's room is ready once it has stored that) */
		await sleep(100);
	}
	return page_;
}

/* a joiner's page, linked to the host */
async function joiner(hostPage, number = 1) {
	const page_ = await page(hostPage.welcome.room);
	page_.send(hello("join", joinerId(number), { secret: hostPage.welcome.secret }));
	page_.welcome = await page_.next("welcome");
	page_.offer = await page_.next("offer");
	page_.send({ type: "answer", sdp: "a joiner's answer" });
	page_.link = await page_.next("link");
	return page_;
}

/* the host's page again, its WebSocket lost: its room back (rehost) */
async function rehost(hostPage, { peers = [], hostKey = hostPage.welcome.hostKey, id = HOST_ID } = {}) {
	const page_ = await page(hostPage.welcome.room);
	page_.send(hello("rehost", id, { hostKey, session: hostPage.offer.session, peers }));
	return page_;
}

/* ---------- the tests */

test("hosting: a welcome with the room and its secret, then the SFU's offer", async () => {
	newAddress();
	sfu.calls.length = 0;
	const page_ = await host();
	assert.match(page_.welcome.room, /^[0-9A-HJKMNP-TV-Z]{8}$/);
	assert.match(page_.welcome.secret, /^[A-Za-z0-9_-]{22}$/);
	assert.equal(page_.welcome.peer, 0);
	assert.match(page_.offer.sdp, /^offer for session\d+$/);

	const session = page_.offer.sdp.slice("offer for ".length);
	assert.deepEqual(sfu.calls.map((call) => `${call.method} ${call.path}`), [
		"POST /sessions/new",
		`POST /sessions/${session}/datachannels/establish`,
		`PUT /sessions/${session}/renegotiate`,
	]);
	assert.ok(sfu.calls.every((call) => call.authorized));
	assert.equal(sfu.calls[0].body, null);
	assert.deepEqual(sfu.calls[1].body, { dataChannel: { location: "remote", dataChannelName: "server-events" } });
	assert.deepEqual(sfu.calls[2].body, { sessionDescription: { type: "answer", sdp: "the host's answer" } });
});

test("joining: a link for the joiner and one for the host, through the SFU", async () => {
	newAddress();
	const hostPage = await host();
	sfu.calls.length = 0;
	const page_ = await joiner(hostPage);
	assert.deepEqual(page_.welcome, { type: "welcome", room: hostPage.welcome.room, peer: 1 });

	const hostSession = hostPage.offer.sdp.slice("offer for ".length);
	const session = page_.offer.sdp.slice("offer for ".length);
	const [published] = called("POST", new RegExp(`^/sessions/${session}/datachannels/new$`));
	const [subscribed] = called("POST", new RegExp(`^/sessions/${hostSession}/datachannels/new$`));
	assert.deepEqual(published.body, { dataChannels: [
		{ location: "local", dataChannelName: "reliable", ordered: true },
		{ location: "local", dataChannelName: "unreliable", ordered: false, maxRetransmits: 0 },
	] });
	assert.deepEqual(subscribed.body, { dataChannels: [
		{ location: "remote", sessionId: session, dataChannelName: "reliable", ordered: true, canReply: true, waitForAck: true },
		{ location: "remote", sessionId: session, dataChannelName: "unreliable", ordered: false, maxRetransmits: 0, canReply: true },
	] });

	/* (the test's SFU numbers channels as they are made: the joiner's two,
	then the host's) */
	const hostLink = await hostPage.next("link");
	assert.deepEqual(page_.link, { type: "link", peer: 0, id: HOST_ID, netVersion: 7,
		reliable: hostLink.reliable - 2, unreliable: hostLink.unreliable - 2 });
	assert.deepEqual(hostLink, { type: "link", peer: 1, id: joinerId(1), netVersion: 7,
		reliable: hostLink.reliable, unreliable: hostLink.reliable + 1 });
});

test("a joiner that leaves: the host is told, and its channels closed", async () => {
	newAddress();
	const hostPage = await host();
	const first = await joiner(hostPage, 1);
	const second = await joiner(hostPage, 2);
	assert.equal(second.welcome.peer, 2);
	const link = await hostPage.next("link");
	await hostPage.next("link");

	sfu.calls.length = 0;
	first.socket.close();
	assert.deepEqual(await hostPage.next("unlink"), { type: "unlink", peer: 1, reason: "left" });
	const hostSession = hostPage.offer.sdp.slice("offer for ".length);
	await until(() => called("PUT", /datachannels\/close$/).length);
	assert.equal(called("PUT", /datachannels\/close$/)[0].path, `/sessions/${hostSession}/datachannels/close`);
	assert.deepEqual(called("PUT", /datachannels\/close$/)[0].body, { dataChannels: [{ id: link.reliable }, { id: link.unreliable }] });

	/* its number is the next joiner's */
	const third = await joiner(hostPage, 3);
	assert.equal(third.welcome.peer, 1);
});

test("a joiner the host drops", async () => {
	newAddress();
	const hostPage = await host();
	const page_ = await joiner(hostPage);
	await hostPage.next("link");
	hostPage.send({ type: "drop", peer: 1 });
	await page_.error("dropped");
	assert.deepEqual(page_.closed, { code: 1000, reason: "dropped" });
	assert.deepEqual(await hostPage.next("unlink"), { type: "unlink", peer: 1, reason: "dropped" });
});

test("a linked joiner that says more fails, and the host is told", async () => {
	newAddress();
	const hostPage = await host();
	const page_ = await joiner(hostPage);
	await hostPage.next("link");
	page_.send({ type: "answer", sdp: "again" });
	await page_.error("protocol");
	assert.deepEqual(page_.closed, { code: 1000, reason: "failed" });
	assert.deepEqual(await hostPage.next("unlink"), { type: "unlink", peer: 1, reason: "failed" });
});

test("the host leaves: its joiners are told, and the room is gone", async () => {
	newAddress();
	const hostPage = await host();
	const page_ = await joiner(hostPage);
	sfu.calls.length = 0;
	hostPage.socket.close();
	await page_.error("closed");
	/* the links made keep working: this server leaves the host's channels
	open (the Worker's rooms close them, as for a joiner that leaves) */
	await sleep(200);
	assert.equal(called("PUT", /datachannels\/close$/).length, SERVER === "worker" ? 1 : 0);

	const late = await page(hostPage.welcome.room);
	late.send(hello("join", joinerId(2), { secret: hostPage.welcome.secret }));
	await late.error("not-found");
});

test("joins refused: no room, the secret, the versions, the id, a host not ready", async () => {
	newAddress();
	const hostPage = await host();
	const { room, secret } = hostPage.welcome;
	const refused = async (name, message, code) => {
		const page_ = await page(name);
		page_.send(message);
		await page_.error(code);
		assert.deepEqual(page_.closed, { code: 1000, reason: "failed" });
	};
	await refused("ZZZZZZZZ", hello("join", joinerId(1), { secret }), "not-found");
	await refused(room, hello("join", joinerId(1), { secret: "AAAAAAAAAAAAAAAAAAAAAA" }), "secret");
	await refused(room, hello("join", joinerId(1)), "secret");
	await refused(room, { ...hello("join", joinerId(1), { secret }), netVersion: 8 }, "version");
	await refused(room, { ...hello("join", joinerId(1), { secret }), version: 2 }, "version");
	await refused(room, hello("join", "not an id", { secret }), "protocol");
	await refused(room, { ...hello("join", joinerId(1), { secret }), netVersion: 0x10000 }, "protocol");
	await refused(room, hello("join", HOST_ID, { secret }), "duplicate");
	await joiner(hostPage, 1);
	await refused(room, hello("join", joinerId(1), { secret }), "duplicate");
	/* (a room's code in lowercase is the same room) */
	await refused(room.toLowerCase(), hello("join", joinerId(1), { secret }), "duplicate");

	newAddress();
	const connecting = await host({ answer: false });
	await refused(connecting.welcome.room, hello("join", joinerId(1), { secret: connecting.welcome.secret }), "not-ready");
});

test("messages out of order or malformed", async () => {
	newAddress();
	const refused = async (name, message) => {
		const page_ = await page(name);
		page_.send(message);
		await page_.error("protocol");
	};
	await refused("new", "not JSON");
	await refused("new", { no: "type" });
	await refused("new", hello("join", HOST_ID));
	await refused("new", { type: "answer", sdp: "early" });
	await refused("ZZZZZZZZ", hello("host", HOST_ID));

	const hostPage = await host({ answer: false });
	hostPage.send({ type: "answer" });
	await hostPage.error("protocol");
});

/* (the Worker's rooms, which no page uses any more, still take 15) */
test("a full room: 31 joiners", { skip: SERVER === "worker" }, async () => {
	newAddress();
	const hostPage = await host();
	/* (each joiner from an address of its own: an address joins 20 times a
	minute at most) */
	for (let number = 1; number <= 31; number++) {
		newAddress();
		assert.equal((await joiner(hostPage, number)).welcome.peer, number);
	}
	newAddress();
	const page_ = await page(hostPage.welcome.room);
	page_.send(hello("join", joinerId(32), { secret: hostPage.welcome.secret }));
	await page_.error("full");
});

test("the SFU fails", async () => {
	newAddress();
	sfu.fail = "/sessions/new";
	const page_ = await page("new");
	page_.send(hello("host", HOST_ID));
	await page_.next("welcome");
	await page_.error("sfu");

	sfu.fail = null;
	const hostPage = await host();
	sfu.fail = "/datachannels/new";
	const joining = await page(hostPage.welcome.room);
	joining.send(hello("join", joinerId(1), { secret: hostPage.welcome.secret }));
	await joining.next("welcome");
	await joining.next("offer");
	joining.send({ type: "answer", sdp: "a joiner's answer" });
	await joining.error("sfu");
	/* (it was never linked: the host hears nothing of it) */
	await sleep(200);
	assert.equal(hostPage.messages.length, hostPage.taken);
});

test("ping is answered pong", async () => {
	newAddress();
	const page_ = await page("new");
	page_.send("ping");
	await until(() => page_.texts.length);
	assert.deepEqual(page_.texts, ["pong"]);
	assert.equal(page_.messages.length, 0);
});

test("what is not a page of the site's, or not a WebSocket, is refused", async () => {
	newAddress();
	assert.equal((await page("new", { origin: "https://example.com" })).status, 403);
	assert.equal((await page("not-a-room")).status, 404);
	assert.equal((await fetch(`${ORIGIN}/net/rooms/new`, { headers: { Origin: ORIGIN } })).status, 426);
});

test("an address makes at most 5 rooms a minute", async () => {
	newAddress();
	for (let count = 0; count < 5; count++) {
		const page_ = await page("new");
		page_.send(hello("host", joinerId(count + 1)));
		await page_.next("welcome");
	}
	const page_ = await page("new");
	await page_.error("busy");
	assert.deepEqual(page_.closed, { code: 1008, reason: "busy" });
	/* (another address is not held to it) */
	newAddress();
	await host();
});

/* (the Worker's wait is 30 seconds, and it has no limit of pages at once) */
test("a page that does not answer the offer is closed", { skip: SERVER === "worker" }, async () => {
	newAddress();
	const page_ = await host({ answer: false });
	const started = Date.now();
	await page_.error("timeout");
	assert.ok(Date.now() - started >= ANSWER_TIMEOUT - 200);

	const silent = await page("new");
	await silent.error("timeout");
});

test("an address has only so many pages at once", { skip: SERVER === "worker" }, async () => {
	newAddress();
	/* (pages that have not said hello, within the address's 5 rooms and 20
	joins a minute) */
	for (let count = 0; count < PAGES_AT_ONCE; count++) {
		assert.ok((await page(count < 4 ? "new" : "ZZZZZZZZ")).opened);
	}
	const page_ = await page("ZZZZZZZZ");
	await page_.error("busy");
	assert.deepEqual(page_.closed, { code: 1008, reason: "busy" });
	/* one ends: there is room for another */
	opened[0].close();
	await sleep(100);
	const next = await page("ZZZZZZZZ");
	next.send("ping");
	await until(() => next.texts.length);
});

/* ---------- a host whose WebSocket is lost (the Worker's rooms know no rehost) */

const rehostOptions = { skip: SERVER === "worker" };

test("a host whose WebSocket is lost comes back to its room, and its joiners are not told", rehostOptions, async () => {
	newAddress();
	const hostPage = await host();
	assert.match(hostPage.welcome.hostKey, /^[A-Za-z0-9_-]{22}$/);
	assert.equal(hostPage.offer.session, hostPage.offer.sdp.slice("offer for ".length));
	const first = await joiner(hostPage, 1);
	await hostPage.next("link");

	/* (no close frame: as a network that drops) */
	hostPage.socket.terminate();
	await sleep(300);
	assert.equal(first.closed, null);
	assert.equal(first.messages.length, 2 + 1, JSON.stringify(first.messages));

	/* a joiner meanwhile is told to try again */
	const early = await page(hostPage.welcome.room);
	early.send(hello("join", joinerId(2), { secret: hostPage.welcome.secret }));
	await early.error("not-ready");

	const again = await rehost(hostPage, { peers: [{ peer: 1, id: joinerId(1) }] });
	assert.deepEqual(await again.next("welcome"),
		{ type: "welcome", room: hostPage.welcome.room, peer: 0, secret: hostPage.welcome.secret });

	/* the room takes joiners again, through the host's same session */
	again.welcome = hostPage.welcome;
	const second = await joiner(again, 2);
	assert.equal(second.welcome.peer, 2);
	assert.equal((await again.next("link")).peer, 2);
	/* and the page that came back hears of its first joiner's end */
	first.socket.close();
	assert.deepEqual(await again.next("unlink"), { type: "unlink", peer: 1, reason: "left" });
	await until(() => called("PUT", /datachannels\/close$/).some((call) => call.path === `/sessions/${hostPage.offer.session}/datachannels/close`));
});

test("a room waits for its host only so long", rehostOptions, async () => {
	newAddress();
	const hostPage = await host();
	const first = await joiner(hostPage, 1);
	hostPage.socket.terminate();
	await sleep(HOST_GRACE / 2);
	assert.equal(first.closed, null);
	await first.error("closed");
});

test("a host that leaves ends its room at once", rehostOptions, async () => {
	newAddress();
	const hostPage = await host();
	const first = await joiner(hostPage, 1);
	hostPage.socket.close();
	await first.error("closed");
	await until(() => first.closed, HOST_GRACE / 2);
});

test("a room the server no longer has is made again by its host, with its links", rehostOptions, async () => {
	newAddress();
	const hostPage = await host();
	await joiner(hostPage, 1);
	await joiner(hostPage, 2);
	hostPage.socket.terminate();
	/* (the room gone, as after a restart) */
	await sleep(HOST_GRACE + 300);

	const again = await rehost(hostPage, { peers: [{ peer: 1, id: joinerId(1) }, { peer: 2, id: joinerId(2) }] });
	assert.deepEqual(await again.next("welcome"),
		{ type: "welcome", room: hostPage.welcome.room, peer: 0, secret: hostPage.welcome.secret });
	again.welcome = hostPage.welcome;

	/* the host's links keep their numbers */
	const third = await joiner(again, 3);
	assert.equal(third.welcome.peer, 3);
	assert.equal((await again.next("link")).peer, 3);

	/* a machine that comes back takes its old link's place */
	const back = await joiner(again, 1);
	assert.deepEqual(await again.next("unlink"), { type: "unlink", peer: 1, reason: "left" });
	assert.equal(back.welcome.peer, 1);
	assert.equal((await again.next("link")).peer, 1);

	/* a link that ends on the host's side frees its number */
	again.send({ type: "drop", peer: 2 });
	assert.deepEqual(await again.next("unlink"), { type: "unlink", peer: 2, reason: "dropped" });
	const fourth = await joiner(again, 4);
	assert.equal(fourth.welcome.peer, 2);
});

test("only the host's key takes its room back", rehostOptions, async () => {
	newAddress();
	const hostPage = await host();
	hostPage.socket.terminate();
	await sleep(100);
	/* a joiner has the secret, not the key */
	const joinerTry = await rehost(hostPage, { hostKey: hostPage.welcome.secret });
	await joinerTry.error("secret");
	const otherMachine = await rehost(hostPage, { id: joinerId(9) });
	await otherMachine.error("secret");
	const malformed = await rehost(hostPage, { hostKey: "short" });
	await malformed.error("protocol");
	const again = await rehost(hostPage);
	await again.next("welcome");
});

test("a host's page that comes back replaces the one the server still has", rehostOptions, async () => {
	newAddress();
	const hostPage = await host();
	const again = await rehost(hostPage);
	await again.next("welcome");
	await hostPage.error("replaced");
	again.welcome = hostPage.welcome;
	await joiner(again, 1);
	assert.equal((await again.next("link")).peer, 1);
	/* the old page's end does not end the room */
	await sleep(200);
	assert.equal(again.closed, null);
});

/* ---------- the room's game (the Worker's rooms keep none) */

const gameOf = (extra = {}) => ({ type: "game", name: "New001", map: "bloodgulch", gametype: "Slayer",
	engine: "slayer", open: true, inProgress: false, teams: false, players: 1, maximumPlayers: 16, ...extra });

async function stats() {
	return (await fetch(`${ORIGIN}/stats`)).json();
}

test("a host's game is kept by its room, as /stats shows", { skip: SERVER !== "elixir" }, async () => {
	newAddress();
	const hostPage = await host();
	await joiner(hostPage, 1);
	await hostPage.next("link");
	const room = async () => (await stats()).rooms.find((entry) => entry.room === hostPage.welcome.room);

	let state = await room();
	assert.equal(state.game, null);
	assert.equal(state.host, "connected");
	assert.equal(state.machines, 2);
	assert.match(state.created_at, /^\d{4}-\d\d-\d\dT/);

	/* the lobby, then a match, then the lobby again, then the next match */
	hostPage.send(gameOf());
	await sleep(250);
	state = await room();
	assert.deepEqual(state.game, { name: "New001", map: "bloodgulch", gametype: "Slayer", engine: "slayer",
		open: true, in_progress: false, teams: false, players: 1, maximum_players: 16 });
	assert.equal(state.match_started_at, null);
	assert.equal(state.matches, 0);

	hostPage.send(gameOf({ inProgress: true, players: 2 }));
	await sleep(250);
	state = await room();
	assert.equal(state.game.players, 2);
	assert.match(state.match_started_at, /^\d{4}-/);
	assert.equal(state.matches, 1);
	const started = state.match_started_at;

	hostPage.send(gameOf({ inProgress: true, players: 3 }));
	await sleep(250);
	state = await room();
	assert.equal(state.match_started_at, started);
	assert.equal(state.matches, 1);

	hostPage.send(gameOf({ inProgress: false }));
	await sleep(250);
	assert.equal((await room()).match_started_at, null);
	hostPage.send(gameOf({ inProgress: true }));
	await sleep(250);
	assert.equal((await room()).matches, 2);

	/* the room ends with its host */
	hostPage.socket.close();
	await until(() => hostPage.closed);
	await sleep(200);
	assert.equal(await room(), undefined);
});

test("a game told too often is let go, and one malformed or not the host's refused", { skip: SERVER === "worker" }, async () => {
	newAddress();
	const hostPage = await host();
	const page_ = await joiner(hostPage, 1);
	await hostPage.next("link");
	page_.send(gameOf());
	await page_.error("protocol");
	await hostPage.next("unlink");

	hostPage.send(gameOf({ players: 300 }));
	await hostPage.error("protocol");

	const again = await host();
	again.send(gameOf({ name: "x".repeat(40) }));
	await again.error("protocol");

	const third = await host();
	third.send(gameOf({ players: 1 }));
	third.send(gameOf({ players: 2 }));
	await sleep(250);
	if (SERVER === "elixir") {
		const state = (await stats()).rooms.find((entry) => entry.room === third.welcome.room);
		assert.equal(state.game.players, 1);
	}
	assert.equal(third.closed, null);
});

test("/stats is not reachable through the relay", { skip: SERVER !== "machine" }, async () => {
	assert.equal((await fetch(`${ORIGIN}/stats`)).status, 404);
});
