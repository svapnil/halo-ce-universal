/*
CRASH.JS

Tells when the game stops, and reports why (port/web/CRASHES.md). A game in
a page fails in ways that leave nothing behind: its thread traps and the
picture freezes, or the browser ends the page's process (out of memory) and
the page is simply gone. This keeps what was known just before, and sends
it to the site (worker/crash.js) with what stopped the game.

What it keeps, as the game runs:
- the log: the latest lines the game printed (all of them with ?debug);
- marks: what the page saw happen (the network's states, joins);
- the game's own state, read from its memory (src/web_crash.c): its frame
  count, its heap, and the end of its debug.txt.

What it reports:
- "exception": an error in the page or a trap in the game (an abort, an
  unreachable, memory out of bounds), with its stack;
- "hang": the game's frames stopped while the page was in view;
- "context-lost": the browser took the game's WebGL context away (its GPU
  process or the graphics driver failed);
- "killed": found at the next visit. A journal of the session is kept in
  localStorage every few seconds; a page that ends in the usual way marks
  it ended (pagehide). A journal not so marked is a page that the browser
  ended, or that crashed with the browser: it is reported then, with what
  the journal last held;
- and the browser's own crash reports (Chrome's Reporting API), which the
  site's Reporting-Endpoints header asks for and which say "oom" or
  "unresponsive", go to the site by themselves.

A report holds no name and no invite: addresses and invites in the log are
cut short (redact). ?debug keeps the whole log and shows Save log, which
saves all of this as a file instead.
*/

const MAGIC = 0x43525348;
const VERSION = 1;
/* struct web_crash_state (web_crash.c) */
const FRAMES = 8;
const EXITED = 12;
const EXIT_CODE = 16;
const HEAP_SIZE = 20;
const HEAP_MAXIMUM = 24;
const MALLOC_USED = 28;
const MALLOC_FREE = 32;
const TEST = 36;
const CONTEXT_LOST = 40;
const LOG_WRITTEN = 44;
const LOG = 48;
const LOG_SIZE = 32 * 1024;
const TESTS = { abort: 1, trap: 2, hang: 3, oom: 4 };

const JOURNAL_KEY = "halo-crash-journal-v1";
const JOURNAL_INTERVAL = 3000;
/* the game's frames standing still this long, in view, is a hang. (But
while a map comes from the server, which can take longer: loading.js says
so, gameAlive) */
const HANG_TIME = 30 * 1000;
const MAXIMUM_REPORTS = 3;

export const debugMode = new URLSearchParams(location.search).has("debug");
const LOG_LINES = debugMode ? 20000 : 400;
const JOURNAL_LINES = debugMode ? 400 : 80;

const session = {
	id: Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
	started: Date.now(),
};
const lines = [];
const marks = [];
let game = null;
let previous = null;
let reports = 0;
let stopped = null;
/* when the game last gave a sign of life: a frame, or gameAlive */
let lastMoved = Date.now();

/* what stopped the game ({ kind, message }), or null: the page's panel */
export function stoppedState() {
	return stopped;
}

/* addresses and invites, cut short: a report need not say who played */
function redact(text) {
	return String(text)
		.replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.x.x")
		.replace(/(halo:\/\/join\/[0-9a-f]{12})[0-9a-f]+/gi, "$1…")
		.replace(/([#?&]join=[0-9A-Za-z]{8})\.[A-Za-z0-9_-]+/g, "$1.…")
		.replace(/([#?&]native=)[^\s&]+/g, "$1…");
}

function stamp() {
	return ((Date.now() - session.started) / 1000).toFixed(1).padStart(7);
}

/* a line the game printed (game.js's print and printErr) */
export function logLine(text) {
	lines.push(`${stamp()} ${text}`);
	if (lines.length > LOG_LINES) {
		lines.splice(0, lines.length - LOG_LINES);
	}
}

/* something the page saw happen */
export function mark(text) {
	const line = `${stamp()} ${text}`;
	if (marks[marks.length - 1]?.slice(8) !== line.slice(8)) {
		marks.push(line);
		if (marks.length > 60) {
			marks.shift();
		}
	}
}

/* the frames the game has run; null before the game has started */
export function frameCount() {
	return game ? game.view.getUint32(game.base + FRAMES, true) : null;
}

/* the game does something other than its frames (loading.js: a map it
waits for is coming): it does not hang */
export function gameAlive() {
	lastMoved = Date.now();
}

/* the game's state, from its memory; null before the game has started */
function gameState() {
	if (!game) {
		return null;
	}
	const { view, bytes, base } = game;
	const megabytes = (offset) => Math.round(view.getUint32(base + offset, true) / 1024);
	const written = view.getUint32(base + LOG_WRITTEN, true);
	const size = Math.min(written, LOG_SIZE);
	const tail = new Uint8Array(size);
	for (let index = 0; index < size; index++) {
		tail[index] = bytes[base + LOG + ((written - size + index) % LOG_SIZE)];
	}
	return {
		frames: view.getUint32(base + FRAMES, true),
		exited: view.getUint32(base + EXITED, true) !== 0,
		exitCode: view.getInt32(base + EXIT_CODE, true),
		contextLost: view.getUint32(base + CONTEXT_LOST, true) !== 0,
		heapMB: megabytes(HEAP_SIZE),
		heapMaximumMB: megabytes(HEAP_MAXIMUM),
		mallocUsedMB: megabytes(MALLOC_USED),
		mallocFreeMB: megabytes(MALLOC_FREE),
		debugLog: new TextDecoder().decode(tail),
	};
}

function context() {
	const state = gameState();
	return {
		session: session.id,
		build: typeof __BUILD__ === "undefined" ? "dev" : __BUILD__,
		page: redact(location.pathname + location.search + location.hash),
		userAgent: navigator.userAgent,
		deviceMemoryGB: navigator.deviceMemory ?? null,
		threads: navigator.hardwareConcurrency ?? null,
		uptimeSeconds: Math.round((Date.now() - session.started) / 1000),
		visible: document.visibilityState === "visible",
		jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
		game: state && { ...state, debugLog: undefined },
		debugLog: state ? redact(state.debugLog).slice(-8000) : "",
		marks: marks.map(redact),
	};
}

function send(report) {
	if (reports >= MAXIMUM_REPORTS) {
		return;
	}
	reports++;
	const body = JSON.stringify(report);
	try {
		/* (a beacon is sent even as the page goes) */
		if (!navigator.sendBeacon("/net/crash", new Blob([body], { type: "application/json" }))) {
			fetch("/net/crash", { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => {});
		}
	} catch {}
}

/* the stack of the error that ended a thread of the game's, which the
thread left in the game's memory (src/web_pre.js); "" if none */
function threadStack() {
	if (!game) {
		return "";
	}
	let end = game.stack;
	while (game.bytes[end] && end < game.stack + 8192) {
		end++;
	}
	return new TextDecoder().decode(game.bytes.slice(game.stack, end));
}

/* the game stopped: reported, once, and the page is told (its panel) */
function stop(kind, message, stack = "") {
	stack = threadStack() || stack;
	writeJournal();
	if (stopped) {
		return;
	}
	stopped = { kind, message };
	mark(`${kind}: ${message}`);
	if (kind !== "exit") {
		send({ version: 1, kind, message: redact(message).slice(0, 500), stack: redact(stack).slice(0, 6000),
			time: new Date().toISOString(), ...context(), log: lines.slice(-200).map(redact) });
	}
	writeJournal();
	/* (CrashPanel.jsx shows it) */
	window.dispatchEvent(new CustomEvent("halo-stopped", { detail: stopped }));
}

/* an error of the page's that is not the game stopping: reported, and the
page goes on */
function reportError(message, stack) {
	/* (after the game's own end, what its listeners left behind fails) */
	if (stopped?.kind === "exit" || /pointer lock/i.test(message)) {
		return;
	}
	mark(`error: ${message}`);
	send({ version: 1, kind: "error", message: redact(message).slice(0, 500), stack: redact(stack).slice(0, 6000),
		time: new Date().toISOString(), ...context(), log: lines.slice(-100).map(redact) });
}

/* whether an error is the game's end: a trap or an abort in the game (their
names, or the game's files in the stack) */
function isGameError(message, stack) {
	return /RuntimeError|Aborted|unreachable|out of bounds|null function|halo\.(js|wasm)/.test(`${message}\n${stack}`);
}

/* ---------- the journal: what a later visit finds of a page that was ended */

function writeJournal(ended = null) {
	try {
		const state = gameState();
		localStorage.setItem(JOURNAL_KEY, JSON.stringify({
			session: session.id,
			started: session.started,
			lastSeen: Date.now(),
			ended: ended ?? (stopped ? `stopped: ${stopped.kind}` : null),
			...context(),
			game: state && { ...state, debugLog: undefined },
			log: lines.slice(-JOURNAL_LINES).map(redact),
		}));
	} catch {}
}

function takePreviousJournal() {
	try {
		const text = localStorage.getItem(JOURNAL_KEY);
		localStorage.removeItem(JOURNAL_KEY);
		return text ? JSON.parse(text) : null;
	} catch {
		return null;
	}
}

/* ---------- the page's */

/* before the game loads: the errors, and the visit before this one */
/* the game's end: its main returned (web_crash.c's exited, above), or it
called exit(), as its Quit does (xbox_xapi.c's XLaunchNewImage, or the SDL
quit event), which the runtime passes to the page's thread, where it throws
an ExitStatus (the error listener below). SDL's listeners on the page's
events are removed: each event would be passed to the game's thread, which
is gone, and the runtime aborts on that ("emscripten_proxy_async failed",
14 s after a Quit: the launch day's 113 reports of a crash that was a
Quit). */
function gameExited(code) {
	stop("exit", `The game ended (${code})`);
	try {
		window.JSEvents?.removeAllEventListeners?.();
	} catch {}
}

export function startCrashWatch() {
	previous = takePreviousJournal();
	if (previous && !previous.ended && previous.game) {
		/* (a page ended without its pagehide: the browser ended it, or both
		went. Reported now, as it could not be then) */
		send({ version: 1, kind: "killed", time: new Date().toISOString(),
			message: `The page ended without warning after ${previous.uptimeSeconds} s` +
				(previous.visible ? "" : " (it was not in view)"),
			...previous, reportedBy: session.id });
	}
	window.addEventListener("error", (event) => {
		const error = event.error;
		const message = error?.message || event.message || "error";
		const stack = error?.stack || `${event.filename}:${event.lineno}`;
		/* (the game's exit(): the runtime's ExitStatus, "Program terminated
		with exit(0)") */
		if (error?.name === "ExitStatus" || /^Program terminated with exit\(/.test(message)) {
			gameExited(error?.status ?? Number((/exit\((\d+)\)/.exec(message) || [])[1] ?? 0));
			return;
		}
		/* (the browser's own notes, and other sites' scripts, are no one's
		failing) */
		if (/ResizeObserver|^Script error/.test(message)) {
			return;
		}
		if (stopped?.kind === "exit") {
			return;
		}
		if (isGameError(message, stack)) {
			stop("exception", message, stack);
		} else {
			reportError(message, stack);
		}
	});
	window.addEventListener("unhandledrejection", (event) => {
		const reason = event.reason;
		/* (the browser's refusals of a pointer lock or fullscreen are not the
		game's failing) */
		if (reason?.name === "WrongDocumentError" || reason?.name === "NotAllowedError" || reason?.name === "AbortError") {
			return;
		}
		const message = reason?.message || String(reason);
		if (stopped?.kind === "exit") {
			return;
		}
		if (isGameError(message, reason?.stack || "")) {
			stop("exception", message, reason?.stack || "");
		} else {
			reportError(message, reason?.stack || "");
		}
	});
	window.addEventListener("pagehide", () => writeJournal("pagehide"));
	/* (a page restored from the back-forward cache lives again) */
	window.addEventListener("pageshow", (event) => event.persisted && writeJournal());
	document.addEventListener("visibilitychange", () => {
		mark(document.visibilityState);
		writeJournal();
	});
	setInterval(writeJournal, JOURNAL_INTERVAL);
}

/* once the game's memory is there (game.js's onRuntimeInitialized) */
export function watchGame(module) {
	const base = module._web_crash_state();
	const view = new DataView(module.HEAPU8.buffer);
	if (view.getUint32(base, true) !== MAGIC || view.getUint32(base + 4, true) !== VERSION) {
		console.warn("crash.js does not match this build of web_crash.c");
		return;
	}
	game = { base, view, bytes: new Uint8Array(module.HEAPU8.buffer), stack: module._web_crash_stack() };
	module.onAbort = (what) => stop("exception", `abort: ${what}`, new Error().stack);

	/* the frames: standing still, in view, the game hangs (or its thread
	died without a word) */
	let lastFrames = 0;
	lastMoved = Date.now();
	setInterval(() => {
		const state = gameState();
		if (stopped) {
			return;
		}
		if (state.exited) {
			gameExited(state.exitCode);
		} else if (state.contextLost) {
			stop("context-lost", "The browser took the game's graphics away (WebGL context lost)");
		} else if (state.frames !== lastFrames || document.visibilityState !== "visible") {
			lastFrames = state.frames;
			lastMoved = Date.now();
		} else if (state.frames > 0 && Date.now() - lastMoved > HANG_TIME) {
			stop("hang", `The game's frames stopped for ${HANG_TIME / 1000} s`);
		}
	}, 1000);
	if (debugMode) {
		/* (the heap's course, in the log) */
		setInterval(() => {
			const state = gameState();
			const line = `memory: heap ${state.heapMB} of ${state.heapMaximumMB} MB, malloc ${state.mallocUsedMB} MB used, ` +
				`${state.mallocFreeMB} MB free`;
			logLine(line);
			console.log(line);
		}, 10000);
	}
	/* ?crashtest=abort, trap, hang or oom: a failure made, 15 seconds in,
	to see it reported */
	const test = TESTS[new URLSearchParams(location.search).get("crashtest")];
	if (test) {
		setTimeout(() => {
			mark(`crash test ${test}`);
			view.setUint32(base + TEST, test, true);
		}, 15000);
	}
}

/* everything kept, as text: Save log's file */
export function logText() {
	const parts = [
		`Halo in the browser: log of ${new Date().toISOString()}`,
		JSON.stringify({ ...context(), debugLog: undefined, marks: undefined }, null, 1),
		"", "---- what the page saw", ...marks.map(redact),
		"", "---- the game's debug.txt (its end)", context().debugLog,
		"", "---- the game's log", ...lines.map(redact),
	];
	if (previous) {
		parts.push("", `---- the visit before this one (${previous.ended ? `ended: ${previous.ended}` : "ENDED WITHOUT WARNING"})`,
			JSON.stringify({ ...previous, log: undefined, debugLog: undefined }, null, 1),
			previous.debugLog || "", ...(previous.log || []));
	}
	return parts.join("\n");
}

export function saveLog() {
	const link = document.createElement("a");
	link.href = URL.createObjectURL(new Blob([logText()], { type: "text/plain" }));
	link.download = `halo-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}
