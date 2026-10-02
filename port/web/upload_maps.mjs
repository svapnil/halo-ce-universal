// Uploads the game's maps to the R2 bucket that the browser build's worker
// reads them from (wrangler.toml; worker/worker.js).
//
// Usage: npm run upload-maps [-- --remote] [-- --data DIR]
//
// By default the maps go to the local bucket of `npm run dev` (in
// .wrangler/state); --remote uploads them to Cloudflare. The maps are read
// from <data>/maps (default: assets/maps, from the root of the repository;
// a relative --data is from the folder npm was run in); `python tools/extract_maps.py`
// copies them out of an Xbox disc image.

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const BUCKET = "open-halo-ce";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const { values } = parseArgs({
	options: {
		remote: { type: "boolean", default: false },
		data: { type: "string", default: join(REPO_ROOT, "assets") },
	},
});

const mapsDir = join(resolve(process.env.INIT_CWD ?? ".", values.data), "maps");
let names;
try {
	names = readdirSync(mapsDir).filter((name) => name.toLowerCase().endsWith(".map")).sort();
} catch {
	names = [];
}
if (names.length === 0) {
	console.error(`${mapsDir} has no maps: run \`python tools/extract_maps.py <disc image>\` first`);
	process.exit(1);
}

const where = values.remote ? "--remote" : "--local";
console.log(`uploading ${names.length} maps to ${BUCKET} (${values.remote ? "Cloudflare" : "local"})`);
for (const name of names) {
	const file = join(mapsDir, name);
	console.log(`  ${name} (${(statSync(file).size / 1e6).toFixed(0)} MB)`);
	const result = spawnSync(
		"npx",
		["--no-install", "wrangler", "r2", "object", "put", `${BUCKET}/maps/${name}`,
			"--file", file, "--content-type", "application/octet-stream", where],
		{ stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" },
	);
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}
