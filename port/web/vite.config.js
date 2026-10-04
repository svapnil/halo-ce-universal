/*
VITE.CONFIG.JS

Builds the page (app/, React) into build/web, next to halo.js and halo.wasm,
which `ninja web` writes there. build/web is the Worker's static assets
(wrangler.toml), so Vite must not empty it: it replaces only its own files,
index.html, the files of app/public (the icons) and ui/ (the scripts and
styles, with hashed names, which it removes first so that old ones do not
pile up).
*/

import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const outDir = fileURLToPath(new URL("../../build/web", import.meta.url));
const assetsDir = "ui";

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

export default defineConfig({
	root: "app",
	define: { __BUILD__: JSON.stringify(buildName()) },
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
