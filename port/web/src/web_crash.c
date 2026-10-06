/*
WEB_CRASH.C

What the page needs to tell that the game has stopped, and to report why
(app/src/crash.js; port/web/CRASHES.md): a block of the game's memory
(struct web_crash_state) that the page reads by itself, with no call into
the game, since the game may be the thing that died.

- frames: raised once a frame by the game's thread (web_frame_update). A
  count that stands still is a game that hangs, or whose thread trapped.
- exited: the game's main returned (its Quit).
- context_lost: the browser took the WebGL context away. Where a desktop
  build's graphics driver failing takes the machine with it, a browser's
  takes only its GPU process, and the page's context.
- the heap: its size and limit, and what malloc holds and has free. The
  heap cannot grow past 4 GB (wasm32), and starts past the Xbox window
  (xbox_memory.c), so what is left to grow into is the memory the game
  has left; a report says how near the end it was.
- the stack of the error that ended a thread of the game's (web_crash_stack,
  which src/web_pre.js fills in from the thread).
- log: the latest bytes of the game's own log, debug.txt, where a release
  build notes the assertions it carries on past (cseries.c), and which a
  browser shows nowhere else.

A thread of its own keeps the heap's numbers and the log up to date, once a
second, so they are there whatever the game's thread does.

test: the page's, to make a failure and see it reported (?crashtest=, for
tests: it only stops the visitor's own game).
*/

#include <emscripten/emscripten.h>
#include <emscripten/heap.h>
#include <emscripten/html5_webgl.h>
#include <malloc.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum
{
	CRASH_MAGIC = 0x43525348,
	CRASH_VERSION = 1,
	LOG_SIZE = 32 * 1024,
	STACK_SIZE = 8192,
};

/* the page's tests */
enum
{
	_test_none = 0,
	_test_abort,
	_test_trap,
	_test_hang,
	/* takes memory until malloc has no more, and logs how much it got */
	_test_out_of_memory,
};

struct web_crash_state
{
	unsigned int magic;
	unsigned int version;
	unsigned int frames;
	/* 1 and the code, once the game's main returned */
	unsigned int exited;
	int exit_code;
	/* KiB: the heap's size and the most it can be, and malloc's bytes in
	use and free */
	unsigned int heap_size;
	unsigned int heap_maximum;
	unsigned int malloc_used;
	unsigned int malloc_free;
	unsigned int test;
	/* the browser took the game's WebGL context away (its GPU process
	crashed, or the driver was reset): nothing is drawn from then on */
	unsigned int context_lost;
	/* the bytes of debug.txt ever copied to log (a ring: the latest are at
	log_written % LOG_SIZE, going back) */
	unsigned int log_written;
	char log[LOG_SIZE];
};

static struct web_crash_state state = { CRASH_MAGIC, CRASH_VERSION };

/* the stack of the error that ended one of the game's threads, as text:
the thread writes it here as it goes (src/web_pre.js), for the page */
static char stack[STACK_SIZE];

EMSCRIPTEN_KEEPALIVE char *web_crash_stack(void)
{
	return stack;
}

/* the page's: where the state is */
EMSCRIPTEN_KEEPALIVE struct web_crash_state *web_crash_state(void)
{
	return &state;
}

static void update_heap(void)
{
	struct mallinfo info = mallinfo();

	__atomic_store_n(&state.heap_size, (unsigned int)(emscripten_get_heap_size() >> 10), __ATOMIC_RELAXED);
	__atomic_store_n(&state.heap_maximum, (unsigned int)(emscripten_get_heap_max() >> 10), __ATOMIC_RELAXED);
	__atomic_store_n(&state.malloc_used, (unsigned int)((size_t)info.uordblks >> 10), __ATOMIC_RELAXED);
	__atomic_store_n(&state.malloc_free, (unsigned int)((size_t)info.fordblks >> 10), __ATOMIC_RELAXED);
}

/* copies what debug.txt has gained since the last time into the ring */
static void update_log(void)
{
	static FILE *file;
	char buffer[4096];
	size_t size;

	/* (the data root is the current directory: web_main.c) */
	if (!file && !(file = fopen("debug.txt", "rb")))
		return;
	clearerr(file);
	while ((size = fread(buffer, 1, sizeof(buffer), file)) > 0)
	{
		size_t index;

		for (index = 0; index < size; index++)
			state.log[(state.log_written + index) % LOG_SIZE] = buffer[index];
		__atomic_store_n(&state.log_written, state.log_written + (unsigned int)size, __ATOMIC_RELEASE);
	}
}

static void *crash_thread(void *unused)
{
	(void)unused;
	for (;;)
	{
		update_heap();
		update_log();
		sleep(1);
	}
	return NULL;
}

static void run_test(unsigned int test)
{
	switch (test)
	{
	case _test_abort:
		printf("crash test: abort\n");
		abort();
	case _test_trap:
		printf("crash test: trap\n");
		__builtin_trap();
	case _test_hang:
		printf("crash test: hang\n");
		for (;;)
			;
	case _test_out_of_memory:
	{
		/* in blocks ever smaller, until none is left; then one is given
		back, as with none even printf has no buffer */
		size_t taken = 0;
		size_t size;
		void *last = NULL;

		for (size = 16 << 20; size >= 4096; size >>= 2)
		{
			void *block;

			while ((block = malloc(size)) != NULL)
			{
				/* (touched, as memory in use is) */
				memset(block, 1, size);
				taken += size;
				last = block;
			}
		}
		free(last);
		update_heap();
		printf("crash test: malloc had no more after %zu MB (the heap is %u of %u MB); the game goes on without\n",
			taken >> 20, state.heap_size >> 10, state.heap_maximum >> 10);
		break;
	}
	}
}

/* the game's thread's, once a frame (web_lobby.c's web_frame_update) */
void web_crash_frame(void)
{
	static int started;
	unsigned int test;

	if (!started)
	{
		pthread_t thread;

		started = 1;
		if (pthread_create(&thread, NULL, crash_thread, NULL) == 0)
			pthread_detach(thread);
	}
	/* (once a second or so: the context is this thread's) */
	if ((__atomic_add_fetch(&state.frames, 1, __ATOMIC_RELAXED) & 63) == 0 && !state.context_lost)
	{
		EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context = emscripten_webgl_get_current_context();

		if (context && emscripten_is_webgl_context_lost(context))
			__atomic_store_n(&state.context_lost, 1, __ATOMIC_RELEASE);
	}
	test = __atomic_exchange_n(&state.test, _test_none, __ATOMIC_ACQ_REL);
	if (test)
		run_test(test);
}

/* web_main.c's: the game's main returned */
void web_crash_exited(int code);

/* The game's exit() (its Quit: xbox_xapi.c's XLaunchNewImage, or the SDL
quit event; tools/web_build.py renames those units' exit to this), on the
game's thread. SDL's listeners on the page's events are removed first, on
the page's thread: each event would be passed to this thread, which is
about to be gone, and the runtime aborts on that ("emscripten_proxy_async
failed": the launch day's 113 reports of a crash that was a Quit, and the
page showed the player a crash). The page is told of the end too, as of a
return from the game's main (web_main.c). */
_Noreturn void web_exit(int code)
{
	MAIN_THREAD_EM_ASM({
		try { JSEvents.removeAllEventListeners(); } catch (e) {}
	});
	web_crash_exited(code);
	exit(code);
}

void web_crash_exited(int code)
{
	state.exit_code = code;
	__atomic_store_n(&state.exited, 1, __ATOMIC_RELEASE);
}
