/*
RELAY_BRIDGE.JS

Native games (NETWORK.md, "Native games"): joins the game's sockets to the
internet (port/web/src/web_net.c, "The relay") to the relay
(port/web/relay), a server with real sockets, over one WebSocket.

web_net.c keeps two rings in the game's shared memory, one each way, of
records: a little-endian 16-bit size of the body, the record's type, a 0,
then the body. This passes each record to the relay as one binary message
(its type, then its body), and each of the relay's messages back as a
record; it knows nothing of what they hold, but for the relay's pings,
which it answers itself (so the relay measures the way to the page).

It connects only when the game first sends the relay something (the
desktop's internet play starts only when a desktop build's game is joined
or browsed for: web_p2p_select.c), so a page that never does takes no
relay session. Before each connection it asks the site's Worker
(worker/relay.js) where the relay is and for a token, which the relay
takes once.
*/

const MAGIC = 0x524c4159;
const VERSION = 1;
const RING_SIZE = 1 << 20;
const HEADER_SIZE = 4;
/* struct web_relay_bridge (web_net.c) */
const OUT_SEQUENCE = 8;
const IN_SEQUENCE = 12;
const IN_TAKEN = 16;
const OUT_LOST = 20;
const OUT_RING = 24;
const IN_RING = OUT_RING + 16 + RING_SIZE;
/* struct web_relay_ring: head, tail, size, reserved, then the data */
const RING_DATA = 16;
/* the relay's ping, which the page answers with the same message */
const PING = 0x7f;
/* records held while the WebSocket opens or the ring to the game is full;
past this many, the newest are lost */
const MAXIMUM_HELD = 4096;
const RECONNECT_TIME = 2000;

const RETRY_TIME = 10 * 1000;

/* where the relay is, and a token for it, from the Worker: { address,
token }. ?relay=<ws URL> gives another relay; without one from either, port
8790 of this host (npm run dev) */
export async function relayTicket() {
	const response = await fetch("/net/relay", { method: "POST" });
	const answer = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(answer.message || `The site refused a connection to the relay (${response.status})`);
	}
	const address = new URLSearchParams(location.search).get("relay") || answer.relay ||
		`${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8790/`;
	return { address, token: answer.token || "" };
}

export function startRelayBridge(module, { onStatus = () => {} } = {}) {
	const base = module._web_relay_bridge();
	const bytes = new Uint8Array(module.HEAPU8.buffer);
	const words = new Int32Array(module.HEAPU8.buffer);
	const view = new DataView(module.HEAPU8.buffer);
	if (view.getUint32(base, true) !== MAGIC || view.getUint32(base + 4, true) !== VERSION) {
		throw new Error("relay_bridge.js does not match this build of web_net.c");
	}
	const outRing = ring(base + OUT_RING);
	const inRing = ring(base + IN_RING);
	/* records to the relay while the WebSocket is not open */
	const unsent = [];
	/* records to the game while its ring is full */
	const held = [];
	let socket = null;
	let connecting = false;
	let waitingForRoom = false;
	let lostToRelay = 0;
	let lostToGame = 0;

	function ring(address) {
		return { head: address >> 2, tail: (address >> 2) + 1, data: address + RING_DATA };
	}

	function copyOut(position, target) {
		const offset = position % RING_SIZE;
		const first = Math.min(target.length, RING_SIZE - offset);
		target.set(bytes.subarray(outRing.data + offset, outRing.data + offset + first));
		target.set(bytes.subarray(outRing.data, outRing.data + target.length - first), first);
	}

	function copyIn(position, source) {
		const offset = position % RING_SIZE;
		const first = Math.min(source.length, RING_SIZE - offset);
		bytes.set(source.subarray(0, first), inRing.data + offset);
		bytes.set(source.subarray(first), inRing.data);
	}

	function toRelay(message) {
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(message);
			return;
		}
		if (unsent.length < MAXIMUM_HELD) {
			unsent.push(message);
		} else {
			lostToRelay++;
		}
		/* (the game's first record: the relay is needed now) */
		if (!socket && !connecting) {
			connect();
		}
	}

	/* the records from the game, each a message to the relay: its type, then
	its body */
	function drain() {
		const head = Atomics.load(words, outRing.head) >>> 0;
		let tail = Atomics.load(words, outRing.tail) >>> 0;
		const header = new Uint8Array(HEADER_SIZE);
		while (((head - tail) >>> 0) >= HEADER_SIZE) {
			copyOut(tail, header);
			const size = header[0] | (header[1] << 8);
			const message = new Uint8Array(1 + size);
			message[0] = header[2];
			copyOut(tail + HEADER_SIZE, message.subarray(1));
			tail = (tail + HEADER_SIZE + size) >>> 0;
			Atomics.store(words, outRing.tail, tail | 0);
			toRelay(message);
		}
	}

	async function readLoop() {
		for (;;) {
			const sequence = Atomics.load(words, (base + OUT_SEQUENCE) >> 2);
			try {
				drain();
			} catch (error) {
				console.error("relay bridge:", error);
			}
			const wait = Atomics.waitAsync(words, (base + OUT_SEQUENCE) >> 2, sequence);
			if (wait.async) {
				await wait.value;
			}
		}
	}

	/* writes what is held while the ring to the game has room, then wakes
	web_net.c's pump */
	function flush() {
		let head = Atomics.load(words, inRing.head) >>> 0;
		const tail = Atomics.load(words, inRing.tail) >>> 0;
		let wrote = false;
		while (held.length) {
			const record = held[0];
			if (RING_SIZE - ((head - tail) >>> 0) < record.length) {
				break;
			}
			copyIn(head, record);
			head = (head + record.length) >>> 0;
			held.shift();
			wrote = true;
		}
		if (wrote) {
			Atomics.store(words, inRing.head, head | 0);
			Atomics.add(words, (base + IN_SEQUENCE) >> 2, 1);
			Atomics.notify(words, (base + IN_SEQUENCE) >> 2);
		}
		if (held.length && !waitingForRoom) {
			waitingForRoom = true;
			const sequence = Atomics.load(words, (base + IN_TAKEN) >> 2);
			const wait = Atomics.waitAsync(words, (base + IN_TAKEN) >> 2, sequence, 100);
			Promise.resolve(wait.value).then(() => {
				waitingForRoom = false;
				flush();
			});
		}
	}

	/* a message from the relay, as a record to the game */
	function toGame(message) {
		if (message[0] === PING) {
			socket.send(message);
			return;
		}
		if (held.length >= MAXIMUM_HELD) {
			lostToGame++;
			return;
		}
		const size = message.length - 1;
		const record = new Uint8Array(HEADER_SIZE + size);
		record[0] = size & 255;
		record[1] = size >> 8;
		record[2] = message[0];
		record.set(message.subarray(1), HEADER_SIZE);
		held.push(record);
		flush();
	}

	async function connect() {
		connecting = true;
		onStatus({ state: "connecting" });
		let address;
		try {
			const ticket = await relayTicket();
			address = ticket.address;
			const url = new URL(address);
			if (ticket.token) {
				url.searchParams.set("token", ticket.token);
			}
			socket = new WebSocket(url);
		} catch (error) {
			onStatus({ state: "error", error: error.message });
			console.warn(`relay: ${error.message}; again in ${RETRY_TIME / 1000} s`);
			setTimeout(connect, RETRY_TIME);
			return;
		}
		connecting = false;
		socket.binaryType = "arraybuffer";
		socket.onopen = () => {
			onStatus({ state: "connected", address });
			console.log(`relay: connected to ${address}`);
			for (const message of unsent.splice(0)) {
				socket.send(message);
			}
		};
		socket.onmessage = (event) => toGame(new Uint8Array(event.data));
		socket.onclose = () => {
			/* (the relay's sockets are gone with it: the game's internet play
			finds that its brokers and tunnel went quiet, and starts again) */
			onStatus({ state: "disconnected", address });
			console.warn(`relay: disconnected from ${address}; again in ${RECONNECT_TIME / 1000} s`);
			setTimeout(connect, RECONNECT_TIME);
		};
	}

	/* (the spike's numbers: what was lost on the page's side) */
	setInterval(() => {
		const lostInGame = view.getUint32(base + OUT_LOST, true);
		if (lostInGame || lostToRelay || lostToGame) {
			console.warn(`relay: records lost: ${lostInGame} in the game's full ring, ` +
				`${lostToRelay} waiting for the relay, ${lostToGame} waiting for the game`);
		}
	}, 10 * 1000);

	readLoop();
}
