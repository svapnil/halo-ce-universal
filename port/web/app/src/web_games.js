/*
WEB_GAMES.JS

The browsers' games in the game's menus, Join Game > Server Browser
(NETWORK.md, "The browsers' games"). While the game browses (the bridge's
"browse" record: net_bridge.js), the page asks the signalling's server for
the live rooms (GET /net/games: each one's invite and game, as its host's
page told it), every 5 seconds and at Refresh, and writes those of this
build's network version to the game as its listings (struct web_listing,
web_p2p.c), which it lists first, as "[WEB] <name>", before desktop builds'
games. Joining one joins its invite, as Direct Link does.
*/

import { signallingAddress } from "./halo_net.js";
import { ENGINES } from "./net_bridge.js";

/* how often the page asks while the Server Browser is open */
const EVERY = 5000;
/* struct web_listing: as many as web_p2p.c keeps, and its layout */
const MOST = 64;
const LISTING_SIZE = 130;
const TEXTS = [["invite", 10, 32], ["name", 42, 32], ["map", 74, 32], ["gametype", 106, 24]];

/* a game's engine as game_engine_index has it ("slayer": 2; "engine-7": 7) */
function engineIndex(engine) {
	const index = ENGINES.indexOf(engine);
	if (index >= 0) {
		return index;
	}
	const match = /^engine-(\d+)$/.exec(engine || "");
	return match ? Math.min(255, Number(match[1])) : 0;
}

/* the games of /net/games that this build can join (its network version),
as the bytes of their listings */
export function encodeListings(games, netVersion) {
	const encoder = new TextEncoder();
	const listed = games.filter((game) => game.netVersion === netVersion && /^[0-9a-f]{12}$/i.test(game.hostId || ""))
		.slice(0, MOST);
	const bytes = new Uint8Array(listed.length * LISTING_SIZE);
	listed.forEach((game, index) => {
		const at = index * LISTING_SIZE;
		for (let byte = 0; byte < 6; byte++) {
			bytes[at + byte] = parseInt(game.hostId.substr(byte * 2, 2), 16);
		}
		bytes[at + 6] = Math.min(255, game.players | 0);
		bytes[at + 7] = Math.min(255, game.maximumPlayers | 0);
		bytes[at + 8] = engineIndex(game.engine);
		bytes[at + 9] = (game.open ? 1 : 0) | (game.inProgress ? 2 : 0) | (game.teams ? 4 : 0);
		for (const [name, offset, size] of TEXTS) {
			/* (NUL-padded: a text that fills its field has no NUL, as
			web_p2p.c expects) */
			bytes.set(encoder.encode(String(game[name] ?? "")).subarray(0, size), at + offset);
		}
	});
	return bytes;
}

/* the transport, with the Server Browser's browse (net_bridge.js): the
browsers' games are gathered while it is open */
export function withWebGames(transport) {
	let games = null;
	let netVersion = 0;
	let timer = null;
	/* (an answer to an earlier browsing is let go) */
	let generation = 0;

	async function ask() {
		const mine = generation;
		try {
			const base = await signallingAddress();
			const response = await fetch(`${base}/net/games`, { cache: "no-store" });
			if (!response.ok) {
				throw new Error(`${response.status}`);
			}
			const answer = await response.json();
			if (mine === generation && games) {
				games(encodeListings(answer.games || [], netVersion));
			}
		} catch (error) {
			if (mine === generation) {
				console.warn(`server browser: the browsers' games could not be read: ${error.message || error}`);
			}
		}
	}

	function stop() {
		generation++;
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	return {
		...transport,
		start(callbacks) {
			games = callbacks.games;
			netVersion = callbacks.netVersion;
			transport.start(callbacks);
		},
		browse(mode) {
			stop();
			if (mode) {
				ask();
				timer = setInterval(ask, EVERY);
			}
		},
	};
}
