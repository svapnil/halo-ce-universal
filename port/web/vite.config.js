/*
VITE.CONFIG.JS

Builds the page (app/, React) into build/web, next to halo.js and halo.wasm,
which `ninja web` writes there. build/web is the Worker's static assets
(wrangler.toml), so Vite must not empty it: it replaces only its own files,
index.html, the files of app/public (the icons, _headers) and ui/ (the
scripts and styles, with hashed names, which it removes first so that old
ones do not pile up), and program/: halo.js and halo.wasm copied under names
that carry their content's hash, which the page loads (game.js) and a
browser keeps for good (_headers). The game's 16 threads each load the
runtime: as halo.js, served to be revalidated each time, that was 17
requests a visit.
*/

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const outDir = fileURLToPath(new URL("../../build/web", import.meta.url));
const assetsDir = "ui";
const programDir = "program";

/* the build a crash report names (app/src/crash.js): the commit, with a +
if the tree had changes */
function buildName() {
	try {
		const run = (command) => execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
		return run("git rev-parse --short HEAD") + (run("git status --porcelain") ? "+" : "");
	} catch {
		return "unknown";
	}
}

/* halo.wasm's size, for the loading panel's percentage (app/src/game.js):
the server sends it compressed, without its length. 0 before `ninja web`. */
function programSize() {
	try {
		return statSync(`${outDir}/halo.wasm`).size;
	} catch {
		return 0;
	}
}

/* halo.js and halo.wasm copied to program/halo-<hash>.js and .wasm (the old
copies removed first); their paths for the page, or the plain ones before
`ninja web` */
function programFiles() {
	const paths = {};

	rmSync(`${outDir}/${programDir}`, { recursive: true, force: true });
	for (const file of ["halo.js", "halo.wasm"]) {
		try {
			const data = readFileSync(`${outDir}/${file}`);
			const hash = createHash("sha256").update(data).digest("hex").slice(0, 12);
			const name = `halo-${hash}${file.slice(file.indexOf("."))}`;

			mkdirSync(`${outDir}/${programDir}`, { recursive: true });
			writeFileSync(`${outDir}/${programDir}/${name}`, data);
			paths[file] = `/${programDir}/${name}`;
		} catch {
			paths[file] = `/${file}`;
		}
	}
	return paths;
}

const program = programFiles();

export default defineConfig({
	root: "app",
	define: {
		__BUILD__: JSON.stringify(buildName()),
		__PROGRAM_SIZE__: programSize(),
		__PROGRAM_JS__: JSON.stringify(program["halo.js"]),
		__PROGRAM_WASM__: JSON.stringify(program["halo.wasm"]),
	},
	plugins: [
		react(),
		{
			name: "remove-old-ui",
			apply: "build",
			buildStart() {
				rmSync(`${outDir}/${assetsDir}`, { recursive: true, force: true });
			},
		},
	],
	build: {
		outDir,
		assetsDir,
		emptyOutDir: false,
	},
});
