/*
RELAY.JS

Tokens for the relay of native games (NETWORK.md, "Native games"): the page
asks POST /net/relay before each WebSocket to the relay (port/web/relay),
and gets where the relay is and a token for it:

	{ "relay": "wss://...", "token": "<expiry>.<nonce>.<signature>" }

A token lasts TOKEN_LIFE seconds, the relay takes it once, and its
signature is the HMAC-SHA256 (base64url) of "relay1.<expiry>.<nonce>" with
the secret the Worker and the relay share (RELAY_TOKEN_SECRET: `npx
wrangler secret put` here, `fly secrets set` for the relay). Only the
site's own pages get one, and an address gets at most RELAY_LIMIT's a
minute (wrangler.toml), so the relay serves only what comes through here.

RELAY_URL (wrangler.toml's vars) is the relay's address. Without a secret
(`npm run dev` with no .dev.vars entry) there is no token, and no address:
the page then uses a relay of its own host's (port 8790), run with
RELAY_INSECURE=1, which takes none.
*/

const TOKEN_LIFE = 60;

function base64url(bytes) {
	let text = "";
	for (const byte of new Uint8Array(bytes)) {
		text += String.fromCharCode(byte);
	}
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret, text) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

export async function makeRelayToken(secret, now = Date.now()) {
	const expiry = Math.floor(now / 1000) + TOKEN_LIFE;
	const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)));
	return `${expiry}.${nonce}.${await sign(secret, `relay1.${expiry}.${nonce}`)}`;
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

/* POST /net/relay */
export async function handleRelay(request, env, url) {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
	}
	/* only the site's own pages */
	if (request.headers.get("Origin") !== url.origin) {
		return new Response("Forbidden", { status: 403 });
	}
	const address = request.headers.get("CF-Connecting-IP") || "local";
	if (env.RELAY_LIMIT && !(await env.RELAY_LIMIT.limit({ key: address })).success) {
		return json({ error: "busy", message: "Too many connections to the relay from this address: try again in a minute" }, 429);
	}
	if (!env.RELAY_TOKEN_SECRET) {
		return json({ relay: null, token: "" });
	}
	return json({ relay: env.RELAY_URL || null, token: await makeRelayToken(env.RELAY_TOKEN_SECRET) });
}
