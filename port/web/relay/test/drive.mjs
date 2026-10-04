/*
DRIVE.MJS

Opens pages in a headless Chrome and logs their consoles (the game's
workers' too), for the network tests (README.md here). Several pages are
tabs of one browser, as ?net=tabs needs.

	node drive.mjs <url[|url...]> <seconds> <log file>

CHROME: the browser (default: Google Chrome's place on macOS); CDP_PORT: its
debugging port (9333: another for two runs at once); SCREENSHOT:
a PNG file to save the first page as, at the end. The page's
ownership notice is confirmed first, in the profile (a new one each run).
*/
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [urlList, seconds = "240", logFile = "page.log"] = process.argv.slice(2);
const urls = urlList.split("|");
const port = Number(process.env.CDP_PORT || 9333);
const profile = mkdtempSync(join(tmpdir(), "halo-drive-"));
writeFileSync(logFile, "");
const log = (line) => appendFileSync(logFile, `[${new Date().toISOString().slice(11, 23)}] ${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
	"--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
	"--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
	"--disable-background-timer-throttling", "--disable-renderer-backgrounding",
	"--disable-backgrounding-occluded-windows", "--autoplay-policy=no-user-gesture-required",
	"--window-size=1280,720",
], { stdio: "ignore" });

async function browserAddress() {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			return (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
		} catch {}
		await sleep(200);
	}
	throw new Error("no Chrome");
}

const socket = new WebSocket(await browserAddress());
await new Promise((resolve) => socket.addEventListener("open", resolve));
let nextId = 1;
const waiting = new Map();
/* each session's label: its tab's ("page N"), its workers' too */
const labels = new Map();
/* the tabs' sessions, by target id */
const tabSessions = new Map();
let tabCount = 0;

function send(method, params = {}, sessionId) {
	const id = nextId++;
	socket.send(JSON.stringify({ id, method, params, sessionId }));
	return new Promise((resolve) => waiting.set(id, resolve));
}

socket.addEventListener("message", async (event) => {
	const message = JSON.parse(event.data);
	const label = labels.get(message.sessionId) ?? "browser";
	if (message.id && waiting.has(message.id)) {
		waiting.get(message.id)(message.result ?? message.error);
		waiting.delete(message.id);
	} else if (message.method === "Runtime.consoleAPICalled") {
		const text = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
		log(`${label} ${message.params.type}: ${text}`);
	} else if (message.method === "Runtime.exceptionThrown") {
		const details = message.params.exceptionDetails;
		log(`${label} exception: ${details.exception?.description ?? details.text}`);
	} else if (message.method === "Log.entryAdded") {
		log(`${label} log ${message.params.entry.level}: ${message.params.entry.text}`);
	} else if (message.method === "Target.attachedToTarget") {
		const { sessionId, targetInfo } = message.params;
		if (targetInfo.type === "page") {
			labels.set(sessionId, `page ${++tabCount}`);
			tabSessions.set(targetInfo.targetId, sessionId);
			await send("Log.enable", {}, sessionId);
		} else {
			labels.set(sessionId, label);
		}
		await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
		await send("Runtime.enable", {}, sessionId);
		await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
	}
});

await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
async function openTab(address) {
	const { targetId } = await send("Target.createTarget", { url: "about:blank", newWindow: true });
	for (let attempt = 0; attempt < 50 && !tabSessions.has(targetId); attempt++) {
		await sleep(100);
	}
	return tabSessions.get(targetId);
}

/* the page asks the player to confirm they own the game: confirmed */
const first = await openTab();
await send("Page.navigate", { url: new URL(urls[0]).origin + "/" }, first);
await sleep(1500);
await send("Runtime.evaluate", { expression: `localStorage.setItem("halo-ownership-notice-v1", "confirmed")` }, first);
for (const [index, url] of urls.entries()) {
	const session = index === 0 ? first : await openTab();
	/* (from another page: an address that differs in its fragment alone
	would not load) */
	await send("Page.navigate", { url: "about:blank" }, session);
	await send("Page.navigate", { url }, session);
	log(`opened page ${index + 1}: ${url}`);
	await sleep(3000);
}
await sleep(Number(seconds) * 1000);
if (process.env.SCREENSHOT) {
	const shot = await send("Page.captureScreenshot", { format: "png" }, first);
	writeFileSync(process.env.SCREENSHOT, Buffer.from(shot.data, "base64"));
}
log("done");
chrome.kill();
process.exit(0);
