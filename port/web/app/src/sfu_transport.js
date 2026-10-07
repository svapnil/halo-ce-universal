/*
SFU_TRANSPORT.JS

The transport of net_bridge.js between browsers anywhere: links through
Cloudflare Realtime SFU, set up by the Worker's rooms (halo_net.js,
worker/rooms.js; NETWORK.md).

- When the game starts hosting (web_p2p.c tells the bridge), the page makes
  a room, whose invite onStatus gives (the page shows it, to copy); when it
  stops, the room ends.
- An invite (the page's #join=, or join()) joins its room: the link to the
  host comes up, and the host's game shows in the game's system link list.

A link's number is the peer's in the room (the host is 0, joiners 1 to
15), so a host has a link to each joiner, and a joiner one, to the host.

onStatus gets { state, invite, players, error, reconnecting }: state is
"idle", "connecting", "hosting", "joined" or "error"; reconnecting is true
while a host's signalling is lost and it connects again (halo_net.js: its
game, links and invite go on meanwhile).
*/

import { hostGame, joinGame } from "./halo_net.js";

/* past this much waiting to go on a link's unreliable channel, its
datagrams are dropped (as a congested network would), not queued */
const MAXIMUM_UNRELIABLE_BUFFERED = 64 * 1024;

function hex(bytes) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(text) {
	return new Uint8Array(text.match(/../g).map((pair) => parseInt(pair, 16)));
}

export function sfuTransport({ invite = null, onStatus = () => {} } = {}) {
	const links = new Map(); // link (the peer's number) → its halo_net link
	let bridge;
	let session = null;
	let role = null;
	let reconnecting = false;
	/* each new session; one that ended before it connected is let go */
	let generation = 0;

	function status(state, extra = {}) {
		onStatus({ state, invite: session?.invite || null, players: links.size + 1, error: null, reconnecting, ...extra });
	}

	function attach(link) {
		links.set(link.peer, link);
		for (const name of ["reliable", "unreliable"]) {
			link[name].addEventListener("message", (event) => {
				/* (text is the SFU's acknowledgement, never the game's) */
				if (typeof event.data !== "string") {
					bridge.receive(link.peer, name, new Uint8Array(event.data));
				}
			});
		}
		bridge.linkUp(link.peer, unhex(link.id));
		status(role === "host" ? "hosting" : "joined");
	}

	function detach(peer) {
		if (links.delete(peer)) {
			bridge.linkDown(peer);
			if (session) {
				status(role === "host" ? "hosting" : "joined");
			}
		}
	}

	function leave() {
		generation++;
		session?.close();
		session = null;
		role = null;
		reconnecting = false;
		for (const peer of [...links.keys()]) {
			detach(peer);
		}
	}

	async function connect(newRole, start) {
		leave();
		role = newRole;
		const mine = generation;
		status("connecting");
		const callbacks = {
			id: hex(bridge.identifier),
			netVersion: bridge.netVersion,
			onLink: (link) => mine === generation && attach(link),
			onUnlink: (peer) => mine === generation && detach(peer),
			/* the signalling ended: links stay, but no one else joins. (A
			joiner's room that ends, "closed", is no error: its link to the
			host goes on, and the game sees for itself if the host is gone) */
			onClose: (error) => {
				reconnecting = false;
				if (error && mine === generation && !(role === "join" && error.code === "closed")) {
					status("error", { error: error.message });
				}
			},
			/* a host's signalling lost, and back (halo_net.js) */
			onSignalling: (up) => {
				if (mine === generation) {
					reconnecting = !up;
					status(role === "host" ? "hosting" : "joined");
				}
			},
		};
		try {
			const started = await start(callbacks);
			if (mine !== generation) {
				started.close();
				return;
			}
			session = started;
			status(newRole === "host" ? "hosting" : "joined");
		} catch (error) {
			if (mine === generation) {
				role = null;
				status("error", { error: error.message });
			}
		}
	}

	const transport = {
		start(options) {
			bridge = options;
			status("idle");
			if (invite) {
				transport.join(invite);
			}
		},
		send(link, channel, bytes) {
			const entry = links.get(link);
			const dataChannel = entry?.[channel];
			if (!dataChannel || dataChannel.readyState !== "open") {
				return;
			}
			if (channel === "unreliable" && dataChannel.bufferedAmount > MAXIMUM_UNRELIABLE_BUFFERED) {
				return;
			}
			dataChannel.send(bytes);
		},
		/* the game hosts: a room for it (leaving one it joined) */
		hosting(isHosting) {
			if (isHosting && role !== "host") {
				connect("host", (callbacks) => hostGame(callbacks));
			} else if (!isHosting && role === "host") {
				leave();
				status("idle");
			}
		},
		/* joins the room of an invite (a link, or <room>.<secret>) */
		join(text) {
			connect("join", (callbacks) => joinGame(text, callbacks));
		},
		leave() {
			leave();
			status("idle");
		},
	};
	return transport;
}
