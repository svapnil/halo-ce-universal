/*
CRASHES.MJS

Reads the crash reports the site keeps (worker/crash.js; CRASHES.md).

	npm run crashes                 the reports, the newest last
	npm run crashes -- 3            the third of that list, in full
	npm run crashes -- --local      those of `npm run dev` (and -- --local 3)
	npm run crashes -- --json 3     one, as the JSON kept

It reads the KV namespace CRASHES through wrangler (`npx wrangler login`
first, for the site's).
*/

import { execFileSync } from "node:child_process";

const options = process.argv.slice(2);
const where = options.includes("--local") ? "--local" : "--remote";
const json = options.includes("--json");
const chosen = options.find((option) => /^\d+$/.test(option));

function wrangler(...parts) {
	return execFileSync("npx", ["wrangler", "kv", "key", ...parts, "--binding", "CRASHES", where],
		{ stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).toString();
}

const output = wrangler("list");
const keys = JSON.parse(output.slice(output.indexOf("["))).sort((a, b) => a.name.localeCompare(b.name));

if (!chosen) {
	if (!keys.length) {
		console.log("No crash reports.");
	}
	keys.forEach((key, index) => {
		const data = key.metadata || {};
		console.log(`${String(index + 1).padStart(3)}  ${key.name.slice(0, 19).replace("T", " ")}  ` +
			`${(data.kind || "?").padEnd(13)} ${(data.browser || "").padEnd(22)} ${(data.country || "").padEnd(3)} ` +
			`${(data.build || "").padEnd(9)} ${data.message || ""}`);
	});
	process.exit(0);
}

const key = keys[Number(chosen) - 1];
if (!key) {
	console.error(`There is no report ${chosen} (of ${keys.length}).`);
	process.exit(1);
}
const text = wrangler("get", key.name);
const report = JSON.parse(text.slice(text.indexOf("{")));
if (json) {
	console.log(JSON.stringify(report, null, 1));
	process.exit(0);
}
const { log, marks, debugLog, stack, game, ...rest } = report;
console.log(`${key.name}\n`);
console.log(Object.entries(rest).map(([name, value]) => `${name.padEnd(16)} ${typeof value === "object" ? JSON.stringify(value) : value}`).join("\n"));
if (game) {
	console.log(`\nThe game: frame ${game.frames}; heap ${game.heapMB} of ${game.heapMaximumMB} MB; ` +
		`malloc ${game.mallocUsedMB} MB used, ${game.mallocFreeMB} MB free` + (game.exited ? `; exited (${game.exitCode})` : ""));
}
const section = (title, body) => body && body.length && console.log(`\n---- ${title}\n${Array.isArray(body) ? body.join("\n") : body}`);
section("stack", stack);
section("what the page saw", marks);
section("the game's debug.txt (its end)", debugLog);
section("the game's log (its end)", log);
