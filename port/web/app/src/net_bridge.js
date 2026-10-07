/*
NET_BRIDGE.JS

Joins the game's internet play (port/web/src/web_p2p.c, on the game's
worker) to a transport on the page's main thread, which links this machine
to others: the page's other tabs (tab_transport.js), or other browsers
through Cloudflare Realtime SFU (halo_net.js). NETWORK.md, "The bridge".

web_p2p.c keeps two rings in the game's shared memory, one each way, of
records: a little-endian 16-bit size, a link number, a type, then that many
bytes. The page reads the ring from the game when web_p2p.c notifies
out_sequence (Atomics.waitAsync: no polling, and not slowed in a tab in the
background), and writes the ring to the game, then calls web_p2p_wake.

A transport has:
	start({ identifier, netVersion, linkUp(link, identifier), linkDown(link),
		receive(link, channel, bytes) })
	send(link, channel, bytes)    channel: "reliable" or "unreliable"
	hosting(isHosting)            optional: the game started or stopped hosting
	join(text)                    optional: join the room of a browser's invite
	                              (the game's menus' Direct Link)
	game(state)                   optional: the hosted game as it is now
	                              (readGame), as it changes
Links are numbered 0 to 127 by the transport; identifiers are the 6 bytes
the machines' XNADDRs carry.
*/

const MAGIC = 0x48414c4f;
const VERSION = 1;
const RING_SIZE = 1 << 20;
const HEADER_SIZE = 4;
/* struct web_bridge (web_p2p.c) */
const OUT_SEQUENCE = 8;
const IN_SEQUENCE = 12;
const IDENTIFIER = 16;
const OUT_RING = 24;
const IN_RING = OUT_RING + 16 + RING_SIZE;
/* struct web_ring: head, tail, size, reserved, then the data */
const RING_DATA = 16;

/* the records each way */
const OUT_TYPES = ["reliable", "unreliable", "hosting", "not-hosting", "join", "game"];
/* struct web_game_state (web_p2p.c): engine, flags, players, maximum
players, then the name, map and game type, each NUL-padded */
const GAME_TEXTS = [["name", 4, 32], ["map", 36, 32], ["gametype", 68, 48]];
const GAME_SIZE = 116;
/* the game engines, by index (game_engine_index: 0 is co-op's) */
const ENGINES = ["coop", "ctf", "slayer", "oddball", "king", "race"];

/* the hosted game, from a "game" record: { name, map, gametype, engine,
open, inProgress, teams, players, maximumPlayers } */
export function readGame(body) {
	if (body.length < GAME_SIZE) {
		return null;
	}
	const decoder = new TextDecoder();
	const game = {
		engine: ENGINES[body[0]] || `engine-${body[0]}`,
		open: (body[1] & 1) !== 0,
		inProgress: (body[1] & 2) !== 0,
		teams: (body[1] & 4) !== 0,
		players: body[2],
		maximumPlayers: body[3],
	};
	for (const [name, offset, size] of GAME_TEXTS) {
		const bytes = body.subarray(offset, offset + size);
		const end = bytes.indexOf(0);
		game[name] = decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
	}
	return game;
}
const IN_TYPES = { "link-up": 0, "link-down": 1, reliable: 2, unreliable: 3 };
/* records from the transport held while the ring to the game is full;
past this many, unreliable ones are lost */
const MAXIMUM_HELD = 1024;

export function startNetBridge(module, transport) {
	const base = module._web_p2p_bridge();
	/* (the bridge is in the game's static memory, which a view made before
	the memory grows still covers) */
	const bytes = new Uint8Array(module.HEAPU8.buffer);
	const words = new Int32Array(module.HEAPU8.buffer);
	const view = new DataView(module.HEAPU8.buffer);
	if (view.getUint32(base, true) !== MAGIC || view.getUint32(base + 4, true) !== VERSION) {
		throw new Error("net_bridge.js does not match this build of web_p2p.c");
	}
	const identifier = bytes.slice(base + IDENTIFIER, base + IDENTIFIER + 6);
	const netVersion = view.getUint16(base + IDENTIFIER + 6, true);
	const outRing = ring(base + OUT_RING);
	const inRing = ring(base + IN_RING);
	const held = [];
	let wakeQueued = false;
	let waitingForRoom = false;

	function ring(address) {
		return { head: (address >> 2), tail: (address >> 2) + 1, data: address + RING_DATA };
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

	/* the records from the game */
	function drain() {
		const head = Atomics.load(words, outRing.head) >>> 0;
		let tail = Atomics.load(words, outRing.tail) >>> 0;
		const header = new Uint8Array(HEADER_SIZE);
		while (((head - tail) >>> 0) >= HEADER_SIZE) {
			copyOut(tail, header);
			const size = header[0] | (header[1] << 8);
			/* (a copy: the transport may keep it, and shared memory cannot be
			posted) */
			const body = new Uint8Array(size);
			copyOut(tail + HEADER_SIZE, body);
			tail = (tail + HEADER_SIZE + size) >>> 0;
			Atomics.store(words, outRing.tail, tail | 0);
			const type = OUT_TYPES[header[3]];
			if (type === "reliable" || type === "unreliable") {
				transport.send(header[2], type, body);
			} else if (type === "join") {
				/* (a browser's invite, from the game's menus: Direct Link) */
				transport.join?.(new TextDecoder().decode(body));
			} else if (type === "game") {
				const game = readGame(body);
				if (game) {
					transport.game?.(game);
				}
			} else if (type) {
				transport.hosting?.(type === "hosting");
			}
		}
	}

	async function readLoop() {
		for (;;) {
			const sequence = Atomics.load(words, (base + OUT_SEQUENCE) >> 2);
			try {
				drain();
			} catch (error) {
				console.error("net bridge:", error);
			}
			const wait = Atomics.waitAsync(words, (base + OUT_SEQUENCE) >> 2, sequence);
			if (wait.async) {
				await wait.value;
			}
		}
	}

	/* writes what is held while the ring to the game has room */
	function flush() {
		let head = Atomics.load(words, inRing.head) >>> 0;
		const tail = Atomics.load(words, inRing.tail) >>> 0;
		let wrote = false;
		while (held.length) {
			const record = held[0];
			if (RING_SIZE - ((head - tail) >>> 0) < HEADER_SIZE + record.length) {
				break;
			}
			copyIn(head, record);
			head = (head + record.length) >>> 0;
			held.shift();
			wrote = true;
		}
		if (wrote) {
			Atomics.store(words, inRing.head, head | 0);
			if (!wakeQueued) {
				wakeQueued = true;
				queueMicrotask(() => {
					wakeQueued = false;
					module._web_p2p_wake();
				});
			}
		}
		if (held.length && !waitingForRoom) {
			waitingForRoom = true;
			const sequence = Atomics.load(words, (base + IN_SEQUENCE) >> 2);
			const wait = Atomics.waitAsync(words, (base + IN_SEQUENCE) >> 2, sequence, 100);
			Promise.resolve(wait.value).then(() => {
				waitingForRoom = false;
				flush();
			});
		}
	}

	function write(link, type, body = new Uint8Array(0)) {
		if (type === "unreliable" && held.length > MAXIMUM_HELD) {
			return;
		}
		const record = new Uint8Array(HEADER_SIZE + body.length);
		record[0] = body.length & 255;
		record[1] = body.length >> 8;
		record[2] = link;
		record[3] = IN_TYPES[type];
		record.set(body, HEADER_SIZE);
		held.push(record);
		flush();
	}

	readLoop();
	transport.start({
		identifier,
		netVersion,
		linkUp: (link, peer) => write(link, "link-up", peer),
		linkDown: (link) => write(link, "link-down"),
		receive: (link, channel, body) => write(link, channel, body),
	});
	return { identifier, netVersion };
}
