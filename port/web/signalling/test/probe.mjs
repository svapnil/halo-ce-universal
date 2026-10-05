/*
PROBE.MJS

Checks a deployed signalling from the site's own pages, after a deploy
(NETWORK.md, "Moving the pages to it"): two tabs of a headless Chrome at the
site, with this folder's halo_net.js (not the site's copy), host and join a
room, send bytes both ways on both channels through the SFU, and the joiner
leaves.

	node port/web/signalling/test/probe.mjs https://openhaloce.com [signalling]

`signalling`: the server to check (https://halo-web-relay.fly.dev); without
one, the one the site's pages use (its GET /net/signalling, or the site's
own rooms). CHROME: the browser (default: Google Chrome's place on macOS).
*/
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [site, signalling = null] = process.argv.slice(2);
if (!site) {
	console.error("usage: node probe.mjs <site> [signalling]");
	process.exit(2);
}
const CDP_PORT = Number(process.env.CDP_PORT || 9344);
const source = readFileSync(new URL("../../app/src/halo_net.js", import.meta.url), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
	"--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "halo-probe-"))}`,
], { stdio: "ignore" });
let address;
for (let attempt = 0; attempt < 50 && !address; attempt++) {
	address = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((response) => response.json())
		.then((version) => version.webSocketDebuggerUrl, () => null);
	await sleep(200);
}
const socket = new WebSocket(address);
await new Promise((resolve) => socket.addEventListener("open", resolve));
let nextId = 1;
const waiting = new Map();
/* the WebSockets the tabs opened: where the signalling was */
const sockets = new Set();
socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id) {
		waiting.get(message.id)?.(message.result ?? message.error);
		waiting.delete(message.id);
	} else if (message.method === "Network.webSocketCreated") {
		sockets.add(new URL(message.params.url).origin);
	}
});
function send(method, params = {}, sessionId) {
	const id = nextId++;
	socket.send(JSON.stringify({ id, method, params, sessionId }));
	return new Promise((resolve) => waiting.set(id, resolve));
}

/* a tab at the site, with halo_net.js as `net`; run() evaluates in it */
async function tab() {
	const { targetId } = await send("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
	await send("Network.enable", {}, sessionId);
	await send("Page.enable", {}, sessionId);
	/* (the site's page starts the game: only its origin is wanted, so its
	scripts are not let run) */
	await send("Emulation.setScriptExecutionDisabled", { value: true }, sessionId);
	await send("Page.navigate", { url: site }, sessionId);
	await sleep(3000);
	await send("Emulation.setScriptExecutionDisabled", { value: false }, sessionId);
	async function run(expression) {
		const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
		}
		return result.result.value;
	}
	await run(`(async () => {
		window.net = await import(URL.createObjectURL(new Blob([${JSON.stringify(source)}], { type: "text/javascript" })));
		window.got = [];
		window.unlinked = [];
		window.options = (id) => ({
			id, netVersion: 7, ${signalling ? `signalling: ${JSON.stringify(signalling)},` : ""}
			onLink: (link) => {
				window.link = link;
				for (const name of ["reliable", "unreliable"]) {
					link[name].addEventListener("message", (event) => window.got.push(name + ":" + new Uint8Array(event.data).join(",")));
				}
			},
			onUnlink: (peer, reason) => window.unlinked.push(peer + ":" + reason),
		});
	})()`);
	return { targetId, run };
}
const sendBytes = (first) => `(async () => {
	link.reliable.send(new Uint8Array([${first}, 2, 3]));
	for (let count = 0; count < 5; count++) {
		link.unreliable.send(new Uint8Array([${first}, count]));
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
})()`;

let ok = false;
try {
	const host = await tab();
	const invite = await host.run(`(async () => { window.session = await net.hostGame(options("0123456789ab")); return session.invite; })()`);
	console.log(`hosting: ${invite.replace(/\.[\w-]+$/, ".<secret>")}`);
	const joiner = await tab();
	const joined = await joiner.run(`(async () => { window.session = await net.joinGame(${JSON.stringify(invite)}, options("0000000000aa"));
		return { peer: session.peer, host: session.links.get(0).id }; })()`);
	console.log(`joined: peer ${joined.peer}, linked to ${joined.host}`);
	await joiner.run(sendBytes(1));
	await sleep(1500);
	await host.run(sendBytes(4));
	await sleep(1500);
	const hostGot = await host.run("got");
	const joinerGot = await joiner.run("got");
	console.log(`the host got ${hostGot.join(" ")}`);
	console.log(`the joiner got ${joinerGot.join(" ")}`);
	await send("Target.closeTarget", { targetId: joiner.targetId });
	await sleep(3000);
	const after = await host.run("({ unlinked, links: session.links.size })");
	console.log(`the joiner left: the host was told ${after.unlinked.join(" ") || "nothing"}, and has ${after.links} links`);
	ok = hostGot.includes("reliable:1,2,3") && hostGot.some((entry) => entry.startsWith("unreliable:1,")) &&
		joinerGot.includes("reliable:4,2,3") && joinerGot.some((entry) => entry.startsWith("unreliable:4,")) &&
		after.unlinked.length === 1 && after.links === 0;
} catch (error) {
	console.log(`failed: ${error.message}`);
}
console.log(`the signalling was at ${[...sockets].join(", ") || "(none)"}`);
console.log(ok ? "OK" : "NOT OK");
chrome.kill();
process.exit(ok ? 0 : 1);
