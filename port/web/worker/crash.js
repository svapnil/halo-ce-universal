/*
CRASH.JS

Takes the page's crash reports and keeps them (CRASHES.md):

- POST /net/crash: a report of the page's own (app/src/crash.js): the game
  trapped or hung, or the visit before ended without warning.
- POST /net/reports: the browser's own reports (the Reporting API, which
  the Reporting-Endpoints header on the site's pages asks for). Of them
  only "crash" is kept: Chrome's word that it ended a page, and why ("oom",
  "unresponsive").

Each is kept for KEEP_DAYS in the KV namespace CRASHES (wrangler.toml), under
a key that starts with its time, with its kind, message and build in the
key's metadata, so that a listing reads as a summary (`npm run crashes`).
Nothing of who sent it is kept but the country and the browser. Only the
site's own pages send them, each address at most CRASH_LIMIT's a minute,
and none larger than MAXIMUM_SIZE.
*/

const MAXIMUM_SIZE = 256 * 1024;
const KEEP_DAYS = 30;

function answer(status, text = "") {
	return new Response(text, { status, headers: { "Cache-Control": "no-store" } });
}

async function limited(request, env) {
	const address = request.headers.get("CF-Connecting-IP") || "local";
	return env.CRASH_LIMIT && !(await env.CRASH_LIMIT.limit({ key: address })).success;
}

async function readBody(request) {
	const length = Number(request.headers.get("Content-Length") || 0);
	if (length > MAXIMUM_SIZE) {
		return null;
	}
	const text = await request.text();
	return text.length > MAXIMUM_SIZE ? null : text;
}

function short(text, size) {
	return String(text ?? "").replace(/\s+/g, " ").slice(0, size);
}

/* "Chrome 154 / macOS" from a user agent, for the listing */
function browserName(userAgent = "") {
	const browser = /(Edg|OPR|Firefox|Chrome|Safari)\/(\d+)/.exec(userAgent.replace(/Chrome\/\d+ Mobile/, "Chrome/"));
	const system = /(Windows|Android|iPhone|iPad|Mac OS X|Linux|CrOS)/.exec(userAgent);
	return `${browser ? `${browser[1]} ${browser[2]}` : "?"} / ${system ? system[1] : "?"}`;
}

async function keep(env, request, report) {
	const time = new Date().toISOString();
	const name = `${time} ${report.kind} ${crypto.randomUUID().slice(0, 8)}`;
	const metadata = {
		kind: short(report.kind, 24),
		message: short(report.message, 160),
		build: short(report.build, 16),
		browser: browserName(report.userAgent),
		country: request.cf?.country || "",
	};
	console.log(`crash report: ${JSON.stringify(metadata)}`);
	if (env.CRASHES) {
		await env.CRASHES.put(name, JSON.stringify({ ...report, received: time, country: metadata.country }), {
			expirationTtl: KEEP_DAYS * 24 * 3600,
			metadata,
		});
	}
}

/* POST /net/crash */
export async function handleCrash(request, env, url) {
	if (request.method !== "POST") {
		return answer(405);
	}
	/* only the site's own pages */
	if (request.headers.get("Origin") !== url.origin) {
		return answer(403);
	}
	if (await limited(request, env)) {
		return answer(429);
	}
	const text = await readBody(request);
	let report;
	try {
		report = JSON.parse(text);
	} catch {}
	if (!report || typeof report !== "object" || typeof report.kind !== "string") {
		return answer(400);
	}
	await keep(env, request, report);
	return answer(204);
}

/* POST /net/reports: the browser's reports, an array of { type, url,
user_agent, age, body } */
export async function handleBrowserReports(request, env) {
	if (request.method !== "POST") {
		return answer(405);
	}
	if (await limited(request, env)) {
		return answer(429);
	}
	const text = await readBody(request);
	let reports;
	try {
		reports = JSON.parse(text);
	} catch {}
	if (!Array.isArray(reports)) {
		return answer(400);
	}
	for (const report of reports.slice(0, 4)) {
		if (report?.type !== "crash") {
			continue;
		}
		await keep(env, request, {
			version: 1,
			kind: "browser-crash",
			message: `The browser ended the page: ${report.body?.reason || "no reason given"}`,
			reason: report.body?.reason || null,
			/* (no invite: the address without its fragment and query) */
			page: short(String(report.url || "").split(/[?#]/)[0], 200),
			userAgent: short(report.user_agent, 300),
			ageSeconds: Math.round((report.age || 0) / 1000),
		});
	}
	return answer(204);
}
