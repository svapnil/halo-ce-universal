/*
MEMORY_WATCH.C

Write tracking for guest memory that the renderer caches.

Textures live in the Xbox contiguous window, where the game (or its
streaming threads) can rewrite them at any time. Instead of hashing their
contents every frame, the pages behind a cached texture are made read-only;
the first write faults, the handler records a new generation for the page,
makes it writable again and lets the write proceed. A cache entry is stale
when any of its pages has a generation newer than the entry.

Writes that the kernel performs on the game's behalf (read() into a
buffer) would fail with EFAULT instead of faulting, so the file layer reads
guest memory through a bounce buffer (xbox_files.c). Unprotecting ahead of
such a write (memory_watch_prepare_write) is not enough on its own: the
renderer can protect the pages again before the kernel writes them.
*/

#include "platform.h"

#ifdef __EMSCRIPTEN__
#include <string.h>

/* WebAssembly has no page protection, so no write faults to count. A range
is compared with its contents instead: its first and last 256 bytes and 512
words spread across the rest (texture data changes as a whole, when the game
loads a different bitmap there). The generation of a range changes only when
that sample does, so the renderer keeps what it built until then. Reporting
every range as written, instead, would rebuild each texture at each use. */
#define WATCH_SAMPLE_EDGE_BYTES 256UL
#define WATCH_SAMPLE_WORDS 512UL
#define WATCH_RANGE_SLOTS 8192

struct watched_range
{
	unsigned long address, size;
	unsigned long checksum;
	unsigned long generation;
};

static struct watched_range watched_ranges[WATCH_RANGE_SLOTS];
static unsigned long watch_generation = 1;
static unsigned long watch_serial = 1;
static pthread_mutex_t watch_lock = PTHREAD_MUTEX_INITIALIZER;

static unsigned long range_checksum(const unsigned char *bytes, unsigned long size)
{
	unsigned long hash = 2166136261UL, index, edge = size < WATCH_SAMPLE_EDGE_BYTES ? size : WATCH_SAMPLE_EDGE_BYTES;

	for (index = 0; index < edge; index++)
		hash = (hash ^ bytes[index]) * 16777619UL;
	for (index = size - edge; index < size; index++)
		hash = (hash ^ bytes[index]) * 16777619UL;
	if (size >= 4 * WATCH_SAMPLE_WORDS)
	{
		unsigned long step = (size / 4) / WATCH_SAMPLE_WORDS;
		const unsigned int *words = (const unsigned int *)((unsigned long)bytes & ~3UL);

		for (index = 0; index < WATCH_SAMPLE_WORDS; index++)
			hash = (hash ^ words[index * step]) * 16777619UL;
	}
	return hash;
}

void memory_watch_initialize(void)
{
}

void memory_watch_protect(unsigned long address, unsigned long size)
{
	(void)address;
	(void)size;
}

unsigned long memory_watch_generation(unsigned long address, unsigned long size)
{
	unsigned long slot, probe, checksum, generation = 0;

	if (!size || !platform_is_contiguous((void *)address))
		return 0;
	checksum = range_checksum((const unsigned char *)address, size);
	pthread_mutex_lock(&watch_lock);
	slot = ((address >> 7) ^ (size * 2654435761UL)) % WATCH_RANGE_SLOTS;
	for (probe = 0; probe < WATCH_RANGE_SLOTS; probe++)
	{
		struct watched_range *range = &watched_ranges[(slot + probe) % WATCH_RANGE_SLOTS];

		if (range->generation && (range->address != address || range->size != size))
			continue;
		if (!range->generation || range->checksum != checksum)
		{
			range->address = address;
			range->size = size;
			range->checksum = checksum;
			range->generation = ++watch_generation;
		}
		generation = range->generation;
		break;
	}
	if (probe == WATCH_RANGE_SLOTS)
	{
		/* the table is full: start again (everything reads as written) */
		memset(watched_ranges, 0, sizeof(watched_ranges));
		generation = ++watch_generation;
	}
	pthread_mutex_unlock(&watch_lock);
	return generation;
}

/* the texture cache reuses an entry without asking for its generation while
this stays the same: since nothing reports writes, it never does */
unsigned long memory_watch_serial(void)
{
	return __sync_add_and_fetch(&watch_serial, 1);
}

void memory_watch_prepare_write(void *address, unsigned long size)
{
	(void)address;
	(void)size;
}

void memory_watch_forget(void *address, unsigned long size)
{
	(void)address;
	(void)size;
}

#else

#include <execinfo.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <ucontext.h>
#include <sys/mman.h>
#include <unistd.h>

#define WATCH_PAGE_SIZE 0x1000UL
#define WATCH_PAGE_COUNT (PLATFORM_CONTIGUOUS_SIZE / WATCH_PAGE_SIZE)

static unsigned char page_protected[WATCH_PAGE_COUNT];
static unsigned long page_generation[WATCH_PAGE_COUNT];
static volatile unsigned long current_generation = 1;
static struct sigaction previous_segv_action;
static BOOL watch_active = FALSE;

static unsigned long page_index(unsigned long address)
{
	return (address - PLATFORM_CONTIGUOUS_BASE) / WATCH_PAGE_SIZE;
}

static void mark_written(unsigned long page)
{
	page_generation[page] = __sync_add_and_fetch(&current_generation, 1);
	page_protected[page] = 0;
	mprotect((void *)(PLATFORM_CONTIGUOUS_BASE + page * WATCH_PAGE_SIZE), WATCH_PAGE_SIZE, PROT_READ | PROT_WRITE);
}

/* errors.c's: debug.txt (a player sends it; the terminal's lines may be
gone) */
void write_to_error_file(char *string, unsigned char date);

/* a line of a crash report (ending in a newline) to debug.txt too, best
effort: the crash may be in the middle of writing it */
static void crash_debug_line(const char *line)
{
	char text[200];
	size_t length = strcspn(line, "\n");

	if (length > sizeof(text) - 3)
		length = sizeof(text) - 3;
	memcpy(text, line, length);
	memcpy(text + length, "\r\n", 3);
	write_to_error_file(text, 1);
}

static void segv_handler(int signal_number, siginfo_t *information, void *context)
{
	unsigned long address = (unsigned long)information->si_addr;

	if (platform_is_contiguous((void *)address))
	{
		unsigned long page = page_index(address);

		if (page_protected[page])
		{
			mark_written(page);
			return;
		}
	}
	/* a genuine crash: report it, then hand it to whatever handled SIGSEGV
	before */
	{
		ucontext_t *ucontext = context;
		char line[160];
		void *frames[48];
		int count, length;

		length = snprintf(line, sizeof(line), "halo-linux: segmentation fault at %p, eip %08x ebp %08x esp %08x\n",
			information->si_addr, (unsigned)ucontext->uc_mcontext.gregs[REG_EIP],
			(unsigned)ucontext->uc_mcontext.gregs[REG_EBP], (unsigned)ucontext->uc_mcontext.gregs[REG_ESP]);
		write(STDERR_FILENO, line, (size_t)length);
		crash_debug_line(line);
		{
			/* the return address a call through a bad pointer left behind */
			const unsigned *stack = (const unsigned *)ucontext->uc_mcontext.gregs[REG_ESP];

			length = snprintf(line, sizeof(line), "halo-linux: stack %08x %08x %08x %08x %08x %08x\n",
				stack[0], stack[1], stack[2], stack[3], stack[4], stack[5]);
			write(STDERR_FILENO, line, (size_t)length);
			crash_debug_line(line);
		}
		count = backtrace(frames, 48);
		backtrace_symbols_fd(frames, count, STDERR_FILENO);
		{
			int frame;

			for (frame = 0; frame < count; frame++)
			{
				snprintf(line, sizeof(line), "halo-linux: called from %p\n", frames[frame]);
				crash_debug_line(line);
			}
		}
	}
	sigaction(SIGSEGV, &previous_segv_action, NULL);
	if (previous_segv_action.sa_flags & SA_SIGINFO)
	{
		if (previous_segv_action.sa_sigaction)
			previous_segv_action.sa_sigaction(signal_number, information, context);
	}
	else if (previous_segv_action.sa_handler != SIG_DFL && previous_segv_action.sa_handler != SIG_IGN)
	{
		previous_segv_action.sa_handler(signal_number);
	}
	/* returning re-executes the faulting instruction under the old handler */
}

void memory_watch_initialize(void)
{
	struct sigaction action;

	if (watch_active)
		return;
	memset(&action, 0, sizeof(action));
	action.sa_sigaction = segv_handler;
	action.sa_flags = SA_SIGINFO | SA_NODEFER;
	sigemptyset(&action.sa_mask);
	if (sigaction(SIGSEGV, &action, &previous_segv_action) == 0)
		watch_active = TRUE;
}

void memory_watch_protect(unsigned long address, unsigned long size)
{
	unsigned long first, last, page;

	if (!watch_active || !size || !platform_is_contiguous((void *)address))
		return;
	first = page_index(address);
	last = page_index(address + size - 1);
	if (last >= WATCH_PAGE_COUNT)
		last = WATCH_PAGE_COUNT - 1;
	for (page = first; page <= last; page++)
	{
		if (!page_protected[page])
		{
			page_protected[page] = 1;
			mprotect((void *)(PLATFORM_CONTIGUOUS_BASE + page * WATCH_PAGE_SIZE), WATCH_PAGE_SIZE, PROT_READ);
		}
	}
}

unsigned long memory_watch_generation(unsigned long address, unsigned long size)
{
	unsigned long first, last, page, newest = 0;

	if (!size || !platform_is_contiguous((void *)address))
		return 0;
	first = page_index(address);
	last = page_index(address + size - 1);
	if (last >= WATCH_PAGE_COUNT)
		last = WATCH_PAGE_COUNT - 1;
	for (page = first; page <= last; page++)
	{
		if (page_generation[page] > newest)
			newest = page_generation[page];
	}
	return newest;
}

unsigned long memory_watch_serial(void)
{
	return current_generation;
}

void memory_watch_prepare_write(void *address, unsigned long size)
{
	unsigned long start = (unsigned long)address;
	unsigned long first, last, page;

	if (!watch_active || !size)
		return;
	if (start + size <= PLATFORM_CONTIGUOUS_BASE || start >= PLATFORM_CONTIGUOUS_BASE + PLATFORM_CONTIGUOUS_SIZE)
		return;
	if (start < PLATFORM_CONTIGUOUS_BASE)
		start = PLATFORM_CONTIGUOUS_BASE;
	first = page_index(start);
	last = page_index((unsigned long)address + size - 1);
	if (last >= WATCH_PAGE_COUNT)
		last = WATCH_PAGE_COUNT - 1;
	for (page = first; page <= last; page++)
	{
		if (page_protected[page])
			mark_written(page);
	}
}

void memory_watch_forget(void *address, unsigned long size)
{
	unsigned long start = (unsigned long)address;
	unsigned long first, last, page;

	if (!size || !platform_is_contiguous(address))
		return;
	first = page_index(start);
	last = page_index(start + size - 1);
	if (last >= WATCH_PAGE_COUNT)
		last = WATCH_PAGE_COUNT - 1;
	for (page = first; page <= last; page++)
	{
		page_protected[page] = 0;
		page_generation[page] = __sync_add_and_fetch(&current_generation, 1);
	}
}

#endif /* __EMSCRIPTEN__ */
