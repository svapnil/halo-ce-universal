/*
WEB_STATS.C

Where the browser build's frames go (debug.frame_stats, HALO_FRAME_STATS=1
on the page's address): once a second, in the console, how long the game's
thread worked on each frame and waited for the browser's next, the ticks it
ran, and what the slow frames held: shaders compiled and linked, textures
uploaded, waits for the sound mixer's lock (the mixer runs on the page's
main thread: dsound_sdl.c), and the network's records each way. The
frames' own times come from platform_video_swap (sdl_platform.c): a
frame's work ends as it swaps, and the next's begins as the wait for the
browser's frame ends.

The counters are raised from any thread (the mixer's from the page's main
thread), so they are atomic; the frame's accounting is the game's
thread's alone.
*/

#include "cseries.h"
#include "game/game.h"

#include <emscripten/emscripten.h>
#include <emscripten/html5_webgl.h>
#include <stdio.h>
#include <string.h>

/* port_config.c's, and network_distributed.c's */
int config_boolean(const char *name);
void network_distributed_statistics(long *sent, long *received, long *corrections);
void network_distributed_own_corrections(long *count, long *near_count, real *distance, boolean *predicted, real *round_trip);

/* a frame whose work took this long is reported on its own (milliseconds:
a tick is 33) */
#define LONG_FRAME_MS 25.0
/* ... at most this many a second */
#define LONG_FRAMES_REPORTED 4

/* -1 before the setting is read */
int web_stats_on = -1;

/* the counters, in microseconds and counts, raised from any thread */
static struct
{
	unsigned long mixer_wait_us, mixer_waits;
	unsigned long main_mixer_wait_us, main_mixer_waits;
	unsigned long audio_us, audio_calls, audio_max_us;
	unsigned long shaders, shader_us;
	unsigned long textures, texture_bytes, texture_us;
	unsigned long net_in, net_out, relay_in, relay_out;
	unsigned long heap_walk_max_us;
} counters;

static unsigned long microseconds(double ms)
{
	return ms > 0.0 ? (unsigned long)(ms * 1000.0) : 0;
}

#define COUNT(field, amount) __atomic_fetch_add(&counters.field, (unsigned long)(amount), __ATOMIC_RELAXED)

static void count_maximum(unsigned long *field, unsigned long value)
{
	unsigned long seen = __atomic_load_n(field, __ATOMIC_RELAXED);

	while (value > seen && !__atomic_compare_exchange_n(field, &seen, value, 1, __ATOMIC_RELAXED, __ATOMIC_RELAXED))
		;
}

/* ---------- the counters the other units raise */

void web_stats_mixer_wait(double ms, int main_thread)
{
	if (main_thread)
	{
		COUNT(main_mixer_wait_us, microseconds(ms));
		COUNT(main_mixer_waits, 1);
	}
	else
	{
		COUNT(mixer_wait_us, microseconds(ms));
		COUNT(mixer_waits, 1);
	}
}

void web_stats_audio(double ms)
{
	COUNT(audio_us, microseconds(ms));
	COUNT(audio_calls, 1);
	count_maximum(&counters.audio_max_us, microseconds(ms));
}

void web_stats_shader(double ms)
{
	COUNT(shaders, 1);
	COUNT(shader_us, microseconds(ms));
}

void web_stats_texture(unsigned long bytes, double ms)
{
	COUNT(textures, 1);
	COUNT(texture_bytes, bytes);
	COUNT(texture_us, microseconds(ms));
}

void web_stats_net(int in, int out)
{
	if (in)
		COUNT(net_in, in);
	if (out)
		COUNT(net_out, out);
}

void web_stats_relay(int in, int out)
{
	if (in)
		COUNT(relay_in, in);
	if (out)
		COUNT(relay_out, out);
}

void web_stats_heap_walk(double ms)
{
	count_maximum(&counters.heap_walk_max_us, microseconds(ms));
}

/* ---------- the frames */

static struct
{
	/* when the last frame's wait ended (its work began), and when its work
	ended; 0 before the first */
	double work_began, work_ended;
	/* the counters as the frame's work began */
	unsigned long shaders, shader_us, textures, texture_bytes, texture_us, mixer_wait_us, net_in, net_out;
	long tick;
	long corrections, own_corrections;
	/* the second being summed */
	double period_began;
	unsigned long frames, timer_frames, long_frames;
	double work_ms, work_max_ms, swap_ms, swap_max_ms, wait_ms, wait_max_ms;
	long ticks;
	char long_lines[LONG_FRAMES_REPORTED][256];
	unsigned long long_lines_count;
	int last_width, last_height;
} frame;

static long current_tick(void)
{
	return game_in_progress() ? game_time_get() : 0;
}

static long corrections_now(void)
{
	long sent, received, corrections;

	network_distributed_statistics(&sent, &received, &corrections);
	return corrections;
}

/* a client's own players' units put where the host had them: the count,
and the last one in text */
static long own_corrections_now(char *text, int size)
{
	long count, near_count;
	real distance, round_trip;
	boolean predicted;

	network_distributed_own_corrections(&count, &near_count, &distance, &predicted, &round_trip);
	if (text)
	{
		if (count)
			snprintf(text, (size_t)size, " (%ld near; last %.1f wu, %s, round trip %.0f ticks)", near_count, distance,
				predicted ? "from the echo" : "unpredicted", round_trip);
		else
			text[0] = 0;
	}
	return count;
}

static void snapshot(void)
{
	frame.shaders = counters.shaders;
	frame.shader_us = counters.shader_us;
	frame.textures = counters.textures;
	frame.texture_bytes = counters.texture_bytes;
	frame.texture_us = counters.texture_us;
	frame.mixer_wait_us = __atomic_load_n(&counters.mixer_wait_us, __ATOMIC_RELAXED);
	frame.net_in = __atomic_load_n(&counters.net_in, __ATOMIC_RELAXED);
	frame.net_out = __atomic_load_n(&counters.net_out, __ATOMIC_RELAXED);
	frame.tick = current_tick();
	frame.corrections = corrections_now();
	frame.own_corrections = own_corrections_now(NULL, 0);
}

static void report_period(double now)
{
	unsigned long count = frame.frames ? frame.frames : 1;
	unsigned long index;
	int width = 0, height = 0;
	char own_text[96];
	EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context = emscripten_webgl_get_current_context();

	if (context)
		emscripten_webgl_get_drawing_buffer_size(context, &width, &height);
	printf("web stats: %lu frames in %.0f ms: work avg %.1f max %.1f, swap avg %.1f max %.1f, wait avg %.1f max %.1f ms; "
		"%ld ticks; %lu long, %lu on the timer; %dx%d\n",
		frame.frames, now - frame.period_began, frame.work_ms / count, frame.work_max_ms, frame.swap_ms / count,
		frame.swap_max_ms, frame.wait_ms / count, frame.wait_max_ms, frame.ticks, frame.long_frames,
		frame.timer_frames, width, height);
	printf("web stats: shaders %lu (%.1f ms), textures %lu (%lu KB, %.1f ms), mixer waits %lu (%.1f ms; main thread's %lu, %.1f ms), "
		"audio %lu calls (avg %.2f, max %.2f ms), net in %lu out %lu, relay in %lu out %lu, heap walk max %.1f ms, "
		"corrections %ld, own %ld%s\n",
		counters.shaders, counters.shader_us / 1000.0, counters.textures, counters.texture_bytes >> 10,
		counters.texture_us / 1000.0, counters.mixer_waits, counters.mixer_wait_us / 1000.0,
		counters.main_mixer_waits, counters.main_mixer_wait_us / 1000.0, counters.audio_calls,
		counters.audio_calls ? counters.audio_us / 1000.0 / (double)counters.audio_calls : 0.0,
		counters.audio_max_us / 1000.0, counters.net_in, counters.net_out, counters.relay_in, counters.relay_out,
		counters.heap_walk_max_us / 1000.0, corrections_now(), own_corrections_now(own_text, sizeof(own_text)), own_text);
	for (index = 0; index < frame.long_lines_count && index < LONG_FRAMES_REPORTED; index++)
		printf("web stats: %s\n", frame.long_lines[index]);
	if (frame.long_lines_count > LONG_FRAMES_REPORTED)
		printf("web stats: ... and %lu more long frames\n", frame.long_lines_count - LONG_FRAMES_REPORTED);
	memset(&counters, 0, sizeof(counters));
	frame.period_began = now;
	frame.frames = frame.timer_frames = frame.long_frames = 0;
	frame.work_ms = frame.work_max_ms = frame.swap_ms = frame.swap_max_ms = frame.wait_ms = frame.wait_max_ms = 0.0;
	frame.ticks = 0;
	frame.long_lines_count = 0;
}

static int stats_on(void)
{
	if (web_stats_on < 0)
		web_stats_on = config_boolean("debug.frame_stats");
	return web_stats_on > 0;
}

/* sdl_platform.c's: the frame's work is done, and it is about to swap */
void web_stats_swap_begin(void)
{
	double now = emscripten_get_now();
	double work;
	long ticks;

	if (!stats_on())
		return;
	if (!frame.work_began)
	{
		frame.work_began = now;
		frame.period_began = now;
		snapshot();
	}
	work = now - frame.work_began;
	ticks = current_tick() - frame.tick;
	if (ticks < 0)
		ticks = 0;
	frame.frames++;
	frame.work_ms += work;
	if (work > frame.work_max_ms)
		frame.work_max_ms = work;
	frame.ticks += ticks;
	if (work > LONG_FRAME_MS)
	{
		frame.long_frames++;
		if (frame.long_lines_count < LONG_FRAMES_REPORTED)
		{
			snprintf(frame.long_lines[frame.long_lines_count], sizeof(frame.long_lines[0]),
				"long frame: %.1f ms of work at +%.0f ms: %ld ticks, shaders %lu (%.1f ms), textures %lu (%lu KB, %.1f ms), "
				"mixer wait %.1f ms, net in %lu out %lu, corrections %ld, own %ld",
				work, now - frame.period_began, ticks, counters.shaders - frame.shaders,
				(counters.shader_us - frame.shader_us) / 1000.0, counters.textures - frame.textures,
				(counters.texture_bytes - frame.texture_bytes) >> 10, (counters.texture_us - frame.texture_us) / 1000.0,
				(__atomic_load_n(&counters.mixer_wait_us, __ATOMIC_RELAXED) - frame.mixer_wait_us) / 1000.0,
				__atomic_load_n(&counters.net_in, __ATOMIC_RELAXED) - frame.net_in,
				__atomic_load_n(&counters.net_out, __ATOMIC_RELAXED) - frame.net_out,
				corrections_now() - frame.corrections, own_corrections_now(NULL, 0) - frame.own_corrections);
		}
		frame.long_lines_count++;
	}
	frame.work_ended = now;
}

/* sdl_platform.c's: swapped; the wait for the browser's frame begins */
void web_stats_wait_begin(void)
{
	double now, swap;

	if (!stats_on() || !frame.work_ended)
		return;
	now = emscripten_get_now();
	swap = now - frame.work_ended;
	frame.swap_ms += swap;
	if (swap > frame.swap_max_ms)
		frame.swap_max_ms = swap;
	frame.work_ended = now;
}

/* sdl_platform.c's: the browser's frame came (or the timer, in a hidden
page); the next frame's work begins */
void web_stats_wait_end(int timer)
{
	double now, wait;

	if (!stats_on() || !frame.work_ended)
		return;
	now = emscripten_get_now();
	wait = now - frame.work_ended;
	frame.wait_ms += wait;
	if (wait > frame.wait_max_ms)
		frame.wait_max_ms = wait;
	if (timer)
		frame.timer_frames++;
	if (now - frame.period_began >= 1000.0)
		report_period(now);
	frame.work_began = now;
	snapshot();
}
