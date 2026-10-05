/*
WEB_LOADING.C

What the page needs to show how much of a map has come from the server
(app/src/loading.js): a block of the game's memory (struct
web_loading_state) that the page reads by itself.

The game reads a map from the server a range at a time (web_main.c), and
waits for each range whole. The thread that asks for the ranges writes here
as their bytes come (src/web_pre.js): the game itself knows only that a
read has not returned yet.

- requests: the requests for a map's bytes that the server has not finished
  answering.
- size, received: the size of the map last asked for, and how far into it
  the bytes received reach.
*/

#include <emscripten/emscripten.h>

enum
{
	LOADING_MAGIC = 0x4C4F4144,
	LOADING_VERSION = 1,
};

struct web_loading_state
{
	unsigned int magic;
	unsigned int version;
	unsigned int requests;
	/* (bytes) */
	unsigned int size;
	unsigned int received;
};

static struct web_loading_state state = { LOADING_MAGIC, LOADING_VERSION };

/* the page's and the threads': where the state is */
EMSCRIPTEN_KEEPALIVE struct web_loading_state *web_loading_state(void)
{
	return &state;
}
