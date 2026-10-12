/*
FRAME_STATS.JS

The page's side of the game's frame statistics (?HALO_FRAME_STATS=1:
port/web/src/web_stats.c logs the game's thread's frames in the console).
Here, what the game's thread cannot see: the page's main thread, which
carries the network's records each way and mixes the sound (SDL's
ScriptProcessorNode), held up by a long task; the GPU the browser draws
with; and the display's pixel ratio, which sets the canvas's size.
*/

export function startFrameStats() {
	if (!new URLSearchParams(location.search).has("HALO_FRAME_STATS")) {
		return;
	}
	try {
		const canvas = document.createElement("canvas");
		const gl = canvas.getContext("webgl2");
		const info = gl?.getExtension("WEBGL_debug_renderer_info");
		const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
		console.log(`page stats: renderer ${renderer}, ${navigator.hardwareConcurrency} cores, ` +
			`pixel ratio ${devicePixelRatio}, ${screen.width}x${screen.height} screen`);
		gl?.getExtension("WEBGL_lose_context")?.loseContext();
	} catch (error) {
		console.log(`page stats: no renderer info (${error.message})`);
	}
	try {
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				console.log(`page stats: main thread long task ${entry.duration.toFixed(0)} ms at ${entry.startTime.toFixed(0)}`);
			}
		});
		observer.observe({ type: "longtask", buffered: true });
	} catch (error) {
		console.log(`page stats: no long task observer (${error.message})`);
	}
	/* ?HALO_FRAME_STATS_LOAD=<ms>: the main thread kept busy that long
	every 100 ms, to see what a slow page does to the game (the network's
	records and the sound's mixing go through it) */
	const load = Number(new URLSearchParams(location.search).get("HALO_FRAME_STATS_LOAD")) || 0;
	if (load > 0) {
		console.log(`page stats: loading the main thread ${load} ms in every 100`);
		setInterval(() => {
			const until = performance.now() + load;
			while (performance.now() < until) {}
		}, 100);
	}
	/* (the main thread's own pace: a timer late by much is a main thread
	held up, whether or not a task of the page's was the long one) */
	let last = performance.now();
	setInterval(() => {
		const now = performance.now();
		if (now - last > 250) {
			console.log(`page stats: main thread timer late by ${(now - last - 100).toFixed(0)} ms at ${now.toFixed(0)}`);
		}
		last = now;
	}, 100);
}
