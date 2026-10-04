/*
WORKER.JS

Serves the browser build: the page (npm run build), halo.js and halo.wasm
(ninja web) from the Worker's static assets (build/web), and the maps from an
R2 bucket. Network play's signalling, at /net/, is rooms.js's, and the
relay's tokens, at /net/relay, relay.js's (NETWORK.md).

Every response gets two things a plain file server does not give:

- cross-origin isolation (the COOP and COEP headers), without which the
  browser gives a page no shared memory and so no threads;
- for the maps, HTTP range requests, with which the game reads a map a chunk
  at a time (WasmFS fetch backend; port/web/src/web_main.c). The backend
  first asks for the size with HEAD and `Range: bytes=0-`, and reads in
  chunks only when the answer has Content-Length and `Accept-Ranges: bytes`.
*/

import { handleRelay } from "./relay.js";
import { handleRooms } from "./rooms.js";

export { GameRoom } from "./rooms.js";

const ISOLATION_HEADERS = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
};

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		// the fetch backend asks for maps//<name>
		url.pathname = url.pathname.replace(/\/{2,}/g, "/");
		let response;

		// a WebSocket's answer (101) goes as it is, without the headers below
		if (url.pathname === "/net/relay") {
			return handleRelay(request, env, url);
		}
		if (url.pathname.startsWith("/net/")) {
			return handleRooms(request, env, url);
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			response = new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
		} else if (url.pathname.startsWith("/maps/")) {
			response = await serveMap(request, env, url.pathname.slice(1));
		} else {
			if (url.pathname === "/") {
				url.pathname = "/index.html";
				request = new Request(url, request);
			}
			response = await env.ASSETS.fetch(request);
		}

		response = new Response(response.body, response);
		for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
			response.headers.set(name, value);
		}
		return response;
	},
};

/* answers GET and HEAD for maps/<name>, whole or as one byte range */
async function serveMap(request, env, key) {
	if (key.includes("..")) {
		return new Response("Not found", { status: 404 });
	}
	const info = await env.MAPS.head(key);
	if (!info) {
		return new Response("Not found", { status: 404 });
	}

	const size = info.size;
	const headers = new Headers();
	info.writeHttpMetadata(headers);
	headers.set("Content-Type", "application/octet-stream");
	headers.set("ETag", info.httpEtag);
	headers.set("Accept-Ranges", "bytes");

	let start = 0;
	let end = size - 1;
	let status = 200;
	const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") || "");
	if (range && (range[1] || range[2])) {
		if (range[1]) {
			start = Number(range[1]);
			end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		} else {
			start = Math.max(size - Number(range[2]), 0);
		}
		if (start >= size || start > end) {
			headers.set("Content-Range", `bytes */${size}`);
			return new Response(null, { status: 416, headers });
		}
		status = 206;
		headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
	}
	const length = end - start + 1;
	headers.set("Content-Length", String(length));

	if (request.method === "HEAD" || length === 0) {
		return new Response(null, { status, headers });
	}
	const object = await env.MAPS.get(key, { range: { offset: start, length } });
	if (!object) {
		return new Response("Not found", { status: 404 });
	}
	return new Response(object.body, { status, headers });
}
