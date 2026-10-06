/*
WEB_PRE.JS

Linked into halo.js before Emscripten's own code (tools/web_build.py's
--pre-js), so it runs in the page and in each of the game's threads.

In the game's threads: an error that ends a thread (a trap in the game: an
abort, an unreachable, memory out of bounds) reaches the page as a worker's
error, without its stack. The stack, which names the game's functions, is
only here: it is written into the game's memory (src/web_crash.c's
web_crash_stack), which the page reads for its report (app/src/crash.js).

In the game's threads too: how much of a map has come from the server, for
the page's loading panel (app/src/loading.js). The file system asks for a
map with fetch, a range at a time, and takes each answer whole
(web_main.c). Here an answer's body goes on through a stream that tells the
page of its bytes as they come, in the game's memory (src/web_loading.c's
struct web_loading_state).

A read across two chunks asks for both, though the file system has the
first already, so more bytes come than the map has. They are not added up:
what is told is how far into the map the bytes received reach.
*/
if (typeof importScripts == "function") {
	/* The game's threads have no Gamepad API (a worker's navigator lacks
	getGamepads), but SDL's gamepad code asks it from the game's thread when a
	gamepad is opened (its rumble: EM_ASM in SDL_emscriptenjoystick.c), which
	ended the game of anyone with a gamepad plugged in. None here, then; the
	gamepads themselves are read through the page's thread. */
	if (typeof navigator != "undefined" && typeof navigator.getGamepads != "function") {
		navigator.getGamepads = () => [];
	}
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

	var haloFetch = self.fetch;
	/* how far into each map the bytes received reach, by its address */
	var haloMapReached = {};
	self.fetch = (resource, options) => {
		var answer = haloFetch(resource, options);
		var address = String(resource);
		if (!/\/maps\//.test(address)) {
			return answer;
		}
		/* struct web_loading_state, in words: requests, size, received */
		var state = _web_loading_state() >> 2;
		var pending = true;
		var finish = () => {
			if (pending) {
				pending = false;
				Atomics.sub(HEAPU32, state + 2, 1);
			}
		};
		Atomics.add(HEAPU32, state + 2, 1);
		return answer.then((response) => {
			/* (a range's answer says where it starts and the map's size; a
			whole map's, its size) */
			var range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
			var position = range ? Number(range[1]) : 0;
			var size = range ? Number(range[2]) : Number(response.headers.get("Content-Length")) || 0;
			if (!response.ok || !response.body) {
				finish();
				return response;
			}
			var tell = () => {
				haloMapReached[address] = Math.max(haloMapReached[address] || 0, position);
				Atomics.store(HEAPU32, state + 3, size);
				Atomics.store(HEAPU32, state + 4, haloMapReached[address]);
			};
			var reader = response.body.getReader();
			tell();
			return new Response(new ReadableStream({
				pull: (controller) => reader.read().then((part) => {
					if (part.done) {
						finish();
						controller.close();
					} else {
						position += part.value.byteLength;
						tell();
						controller.enqueue(part.value);
					}
				}, (error) => {
					finish();
					controller.error(error);
				}),
				cancel: (reason) => {
					finish();
					return reader.cancel(reason);
				},
			}), response);
		}, (error) => {
			finish();
			throw error;
		});
	};
}
