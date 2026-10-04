/*
WEB_PRE.JS

Linked into halo.js before Emscripten's own code (tools/web_build.py's
--pre-js), so it runs in the page and in each of the game's threads.

In the game's threads: an error that ends a thread (a trap in the game: an
abort, an unreachable, memory out of bounds) reaches the page as a worker's
error, without its stack. The stack, which names the game's functions, is
only here: it is written into the game's memory (src/web_crash.c's
web_crash_stack), which the page reads for its report (app/src/crash.js).
*/
if (typeof importScripts == "function") {
	var haloKeepStack = (error) => {
		try {
			var text = String(error && error.stack || error && error.message || error);
			var bytes = new TextEncoder().encode(text).subarray(0, 8191);
			var address = _web_crash_stack();
			HEAPU8.set(bytes, address);
			HEAPU8[address + bytes.length] = 0;
		} catch (e) {}
	};
	self.addEventListener("unhandledrejection", (event) => haloKeepStack(event.reason));
	self.addEventListener("error", (event) => haloKeepStack(event.error || event.message));
}
