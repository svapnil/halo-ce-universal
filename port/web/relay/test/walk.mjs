/*
WALK.MJS

Walks the game's menus in a headless Chrome, as a player does: keys, clicks
and screenshots, with the page's console in a log. For the tests of the PC
menus' online screens (README.md here).

	node walk.mjs <url> <seconds to wait first> <step>...

Steps:
	a key's name       ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Enter,
	                   Space, Escape, Backspace, Tab, F11
	wait:<seconds>
	click:<x>,<y>      in the page (CSS pixels of a 1280x720 window)
	shot:<file.png>    a screenshot
	copy:<text>        puts text on the clipboard (for PASTE LINK)
	eval:<expression>  prints its value
	reload

WALK_LOG: the console's log (walk.log here); CHROME, CDP_PORT: as drive.mjs.
The page's ownership notice is confirmed first, in a profile made for the
run.
*/

import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, firstWait, ...steps] = process.argv.slice(2);
const port = Number(process.env.CDP_PORT || 9335);
const logFile = process.env.WALK_LOG || "walk.log";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => appendFileSync(logFile, `[${new Date().toISOString().slice(11, 23)}] ${line}\n`);
writeFileSync(logFile, "");

const chrome = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
	"--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "halo-walk-"))}`,
	"--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1280,720",
	"--disable-background-timer-throttling", "--disable-renderer-backgrounding",
], { stdio: "ignore" });

let address;
for (let attempt = 0; attempt < 50 && !address; attempt++) {
	try {
		const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
		address = list.find((entry) => entry.type === "page")?.webSocketDebuggerUrl;
	} catch {}
	await sleep(200);
}
const socket = new WebSocket(address);
await new Promise((resolve) => socket.addEventListener("open", resolve));
let nextId = 1;
const waiting = new Map();
socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id && waiting.has(message.id)) {
		waiting.get(message.id)(message.result);
		waiting.delete(message.id);
	} else if (message.method === "Runtime.consoleAPICalled") {
		log(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
	} else if (message.method === "Runtime.exceptionThrown") {
		log(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
	} else if (message.method === "Target.attachedToTarget") {
		/* (the game's workers log too) */
		const sessionId = message.params.sessionId;
		socket.send(JSON.stringify({ id: nextId++, method: "Runtime.enable", sessionId }));
		socket.send(JSON.stringify({ id: nextId++, method: "Target.setAutoAttach", sessionId,
			params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }));
	}
});
function send(method, params = {}) {
	return new Promise((resolve) => {
		const id = nextId++;
		waiting.set(id, resolve);
		socket.send(JSON.stringify({ id, method, params }));
	});
}

await send("Runtime.enable");
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
await send("Page.navigate", { url: new URL(url).origin + "/" });
await sleep(1500);
await send("Runtime.evaluate", { expression: `localStorage.setItem("halo-ownership-notice-v1", "confirmed")` });
await send("Page.navigate", { url: "about:blank" });
await send("Page.navigate", { url });
await sleep(Number(firstWait) * 1000);

const KEYS = {
	ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27, Backspace: 8, Tab: 9,
	Space: 32, F11: 122,
};
for (const step of steps) {
	log(`step: ${step}`);
	if (step.startsWith("wait:")) {
		await sleep(Number(step.slice(5)) * 1000);
	} else if (step.startsWith("shot:")) {
		const shot = await send("Page.captureScreenshot", { format: "png" });
		writeFileSync(step.slice(5), Buffer.from(shot.data, "base64"));
	} else if (step.startsWith("click:")) {
		const [x, y] = step.slice(6).split(",").map(Number);
		/* (the menus' pointer follows the mouse's moves) */
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 2, y: y - 2 });
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		await sleep(300);
		for (const type of ["mousePressed", "mouseReleased"]) {
			await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
			await sleep(100);
		}
		await sleep(700);
	} else if (step.startsWith("copy:")) {
		const result = await send("Runtime.evaluate", { awaitPromise: true,
			expression: `navigator.clipboard.writeText(${JSON.stringify(step.slice(5))}).then(() => "copied", (error) => error.message)` });
		console.log("clipboard:", result.result?.value);
	} else if (step.startsWith("eval:")) {
		const result = await send("Runtime.evaluate", { expression: step.slice(5) });
		console.log(step.slice(5), "=>", result.result?.value);
	} else if (step === "reload") {
		await send("Page.reload");
	} else if (KEYS[step]) {
		const key = { type: "rawKeyDown", key: step === "Space" ? " " : step, code: step, windowsVirtualKeyCode: KEYS[step] };
		await send("Input.dispatchKeyEvent", key);
		await sleep(120);
		await send("Input.dispatchKeyEvent", { ...key, type: "keyUp" });
		await sleep(900);
	} else {
		console.log(`unknown step: ${step}`);
	}
}
chrome.kill();
process.exit(0);
