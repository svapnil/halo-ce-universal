/*
TAB_TRANSPORT.JS

A transport for net_bridge.js that links this page to the game's other
pages in the same browser (BroadcastChannel), as machines on one LAN: each
page's system link games show in the others'. It tests internet play
without a server or WebRTC (NETWORK.md, "Testing"); ?net=tabs turns it on
(game.js).

Every page links to every other. A page says hello when it starts, and the
others answer it; each says it is alive every second, and bye when it
closes. A BroadcastChannel is reliable and ordered, so both of a link's
channels are.

A page in the background runs its timers slowly, and the game stops
drawing (and so playing) in one: test with each page in a window of its
own.
*/

const CHANNEL_NAME = "halo-tabs";
const ALIVE_INTERVAL = 1000;
/* (long: a page in the background may run its timers once a minute) */
const SILENT_TIMEOUT = 90 * 1000;
const MAXIMUM_LINKS = 128;

function hex(bytes) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(text) {
	return new Uint8Array(text.match(/../g).map((pair) => parseInt(pair, 16)));
}

export function tabTransport() {
	const peers = new Map(); // identifier → { link, heard }
	const links = new Map(); // link → identifier
	let channel;
	let me;
	let bridge;

	function post(message) {
		channel.postMessage({ ...message, from: me });
	}

	function linkTo(peer) {
		let entry = peers.get(peer);
		if (!entry) {
			let link = 0;
			while (links.has(link)) {
				link++;
			}
			if (link >= MAXIMUM_LINKS) {
				return null;
			}
			entry = { link, heard: 0 };
			peers.set(peer, entry);
			links.set(link, peer);
			bridge.linkUp(link, unhex(peer));
			console.log(`tabs: linked to ${peer} (link ${link})`);
		}
		entry.heard = Date.now();
		return entry;
	}

	function unlink(peer) {
		const entry = peers.get(peer);
		if (entry) {
			peers.delete(peer);
			links.delete(entry.link);
			bridge.linkDown(entry.link);
			console.log(`tabs: lost ${peer}`);
		}
	}

	return {
		start(options) {
			bridge = options;
			me = hex(options.identifier);
			channel = new BroadcastChannel(CHANNEL_NAME);
			channel.onmessage = ({ data: message }) => {
				if (!message || message.from === me || (message.to && message.to !== me)) {
					return;
				}
				switch (message.type) {
					case "hello":
						linkTo(message.from);
						if (!message.to) {
							post({ type: "hello", to: message.from });
						}
						break;
					case "alive":
						if (!peers.has(message.from)) {
							post({ type: "hello", to: message.from });
						}
						linkTo(message.from);
						break;
					case "bye":
						unlink(message.from);
						break;
					case "data": {
						const entry = peers.get(message.from);
						if (entry) {
							entry.heard = Date.now();
							bridge.receive(entry.link, message.channel, message.data);
						}
						break;
					}
				}
			};
			post({ type: "hello" });
			setInterval(() => {
				post({ type: "alive" });
				const now = Date.now();
				for (const [peer, entry] of peers) {
					if (now - entry.heard > SILENT_TIMEOUT) {
						unlink(peer);
					}
				}
			}, ALIVE_INTERVAL);
			addEventListener("pagehide", () => post({ type: "bye" }));
			console.log(`tabs: this page is ${me}`);
		},
		send(link, channelName, bytes) {
			const peer = links.get(link);
			if (peer) {
				post({ type: "data", to: peer, channel: channelName, data: bytes });
			}
		},
		hosting(isHosting) {
			console.log(`tabs: ${isHosting ? "hosting" : "no longer hosting"}`);
		},
	};
}
