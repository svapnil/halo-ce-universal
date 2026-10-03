/*
VITE.CONFIG.JS

Builds the page (app/, React) into build/web, next to halo.js and halo.wasm,
which `ninja web` writes there. build/web is the Worker's static assets
(wrangler.toml), so Vite must not empty it: it replaces only its own files,
index.html, the files of app/public (the icons) and ui/ (the scripts and
styles, with hashed names, which it removes first so that old ones do not
pile up).
*/

import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const outDir = fileURLToPath(new URL("../../build/web", import.meta.url));
const assetsDir = "ui";

export default defineConfig({
	root: "app",
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
