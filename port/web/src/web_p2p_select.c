/*
WEB_P2P_SELECT.C

p2p.h for the game, from the browser build's two internet plays together
(NETWORK.md, "Native games"):

- web_p2p.c (p2p_web_*): links to other browsers, through the page
  (Cloudflare Realtime SFU, or the page's other tabs). It runs from the
  start, and is the one a game hosted here is reached by (a room's invite).
- the desktop's own p2p.c (p2p_native_*, with p2p_signal.c, p2p_lobby.c,
  p2p_crypto.c and p2p_discord.c): desktop builds' games, joined with their
  invite (halo://join/...) or from the PC menus' server browser, through
  its MQTT signalling and its tunnel, whose sockets to the internet
  web_net.c carries through the relay (app/src/relay_bridge.js). It starts
  only when first needed, so that a page that never joins a desktop
  build's game never reaches the relay; and it never hosts (a page hosts
  for browsers).

tools/web_build.py compiles each with p2p.h's functions renamed. The game
sees one machine: one identifier (the desktop's, which its tunnel proves,
and the rooms are told too), and each peer is the one's that has it. The
two give their peers addresses of 100.64.0.0/10 each its own way; that two
peers of one game get the same is too unlikely to guard against.
*/

#include "platform.h"
#include "posix.h"
#include "p2p.h"

#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define P2P_BACKEND(prefix) \
	void prefix##_initialize(unsigned long local_address); \
	int prefix##_hand_off_invite(void); \
	int prefix##_join_invite(const char *text); \
	const unsigned char *prefix##_identifier(void); \
	int prefix##_peer_address(const unsigned char *identifier, unsigned long *address); \
	int prefix##_outgoing(int stream, int socket, unsigned long *address, unsigned short *port); \
	int prefix##_incoming(int stream, unsigned long *address, unsigned short *port); \
	int prefix##_broadcast_targets(unsigned short port, unsigned long *addresses, unsigned short *ports, \
		int maximum_count); \
	int prefix##_send_datagram(unsigned short source_port, unsigned long address, unsigned short port, \
		const void *data, int size); \
	int prefix##_broadcast_datagram(unsigned short source_port, unsigned short port, const void *data, int size); \
	void prefix##_socket_port(int socket, int stream, int listening, unsigned short port); \
	void prefix##_port_taken(int stream, unsigned short port); \
	void prefix##_socket_closed(int socket, unsigned short datagram_port); \
	const char *prefix##_take_clipboard_text(void); \
	void prefix##_set_game_player_counts(int count, int maximum); \
	void prefix##_discord_sanitize(char *destination, int size, const char *source, int name); \
	void prefix##_discord_identity(char *id, int id_size, char *name, int name_size); \
	void prefix##_hardware_id(char *hex, int size); \
	void prefix##_hardware_id_sanitize(char *destination, int size, const char *source); \
	unsigned long prefix##_peer_endpoint_address(unsigned long virtual_address); \
	void prefix##_set_hosting_allowed(int allowed); \
	int prefix##_invite_link(char *link, int size); \
	void prefix##_set_hosting_public(int public); \
	void prefix##_set_hosting_password(const char *password); \
	void prefix##_set_game_listing(const char *name, const char *map, const char *gametype, int engine_type, \
		int open, int in_progress, int has_teams); \
	void prefix##_lobby_browse(int on); \
	void prefix##_lobby_refresh(void); \
	int prefix##_lobby_games(struct p2p_listing *games, int maximum_count); \
	void prefix##_lobby_mark_failed(const unsigned char *identifier); \
	int prefix##_listing_unlock(struct p2p_listing *listing, const char *password);

P2P_BACKEND(p2p_web)
P2P_BACKEND(p2p_native)

enum
{
	/* the game's sockets' ports told before the desktop's started, told
	it as it starts (p2p_socket_port, p2p_port_taken) */
	MAXIMUM_PORTS = 64,
};

static pthread_mutex_t select_lock = PTHREAD_MUTEX_INITIALIZER;

static struct
{
	int initialized;
	unsigned long local_address;
	/* the desktop's internet play: started (nonzero), when first needed */
	int native;
	struct
	{
		int socket;
		int stream;
		int listening;
		unsigned short port;
		/* 0: p2p_socket_port's; 1: p2p_port_taken's */
		int taken;
	} ports[MAXIMUM_PORTS];
	int port_count;
} select_state;

static int native_running(void)
{
	return __atomic_load_n(&select_state.native, __ATOMIC_ACQUIRE);
}

/* the desktop's internet play, from now on: started, told the game's ports,
never to host */
static void start_native(void)
{
	int index;

	pthread_mutex_lock(&select_lock);
	if (select_state.native || !select_state.initialized)
	{
		pthread_mutex_unlock(&select_lock);
		return;
	}
	p2p_native_initialize(select_state.local_address);
	p2p_native_set_hosting_allowed(0);
	p2p_native_set_hosting_public(0);
	for (index = 0; index < select_state.port_count; index++)
	{
		if (select_state.ports[index].taken)
			p2p_native_port_taken(select_state.ports[index].stream, select_state.ports[index].port);
		else
			p2p_native_socket_port(select_state.ports[index].socket, select_state.ports[index].stream,
				select_state.ports[index].listening, select_state.ports[index].port);
	}
	__atomic_store_n(&select_state.native, 1, __ATOMIC_RELEASE);
	pthread_mutex_unlock(&select_lock);
	platform_log("Internet play: desktop builds' games are reached now (through the relay)");
}

/* keeps a port told while the desktop's has not started; 0 if it has (tell
it then) */
static int keep_port(int socket, int stream, int listening, unsigned short port, int taken)
{
	int index;

	pthread_mutex_lock(&select_lock);
	if (select_state.native)
	{
		pthread_mutex_unlock(&select_lock);
		return 0;
	}
	for (index = 0; index < select_state.port_count; index++)
	{
		if (select_state.ports[index].port == port && select_state.ports[index].stream == stream &&
			select_state.ports[index].taken == taken)
		{
			break;
		}
	}
	if (index == select_state.port_count && select_state.port_count < MAXIMUM_PORTS)
	{
		memset(&select_state.ports[index], 0, sizeof(select_state.ports[index]));
		select_state.port_count++;
	}
	if (index < select_state.port_count)
	{
		select_state.ports[index].socket = socket;
		select_state.ports[index].stream = stream;
		select_state.ports[index].listening |= listening;
		select_state.ports[index].port = port;
		select_state.ports[index].taken = taken;
	}
	pthread_mutex_unlock(&select_lock);
	return 1;
}

/* web_p2p.c's: this machine's identifier, the desktop's (its key is made
when first asked, before its internet play starts) */
const unsigned char *web_p2p_shared_identifier(void)
{
	return p2p_native_identifier();
}

/* whether text holds a desktop build's invite link */
static int has_native_invite(const char *text)
{
	const char *at;

	for (at = text; at && *at; at++)
	{
		if (!strncasecmp(at, "halo://join/", 12))
			return 1;
	}
	return 0;
}

/* ---------- p2p.h */

/* (a page opened with a desktop build's invite, #native=, has it in
HALO_NET_NATIVE_INVITE: app/src/game.js) */
void p2p_initialize(unsigned long local_address)
{
	const char *invite = getenv("HALO_NET_NATIVE_INVITE");

	pthread_mutex_lock(&select_lock);
	select_state.local_address = local_address;
	select_state.initialized = 1;
	pthread_mutex_unlock(&select_lock);
	p2p_web_initialize(local_address);
	if (invite && *invite && !p2p_join_invite(invite))
		platform_log("Internet play: HALO_NET_NATIVE_INVITE holds no invite");
}

int p2p_hand_off_invite(void)
{
	return 0;
}

/* a desktop build's invite (the desktop's, started for it), or a
browser's (a room, which the page joins) */
int p2p_join_invite(const char *text)
{
	if (has_native_invite(text))
	{
		start_native();
		return p2p_native_join_invite(text);
	}
	return p2p_web_join_invite(text);
}

const unsigned char *p2p_identifier(void)
{
	return p2p_native_identifier();
}

int p2p_peer_address(const unsigned char *identifier, unsigned long *address)
{
	return (native_running() && p2p_native_peer_address(identifier, address)) ||
		p2p_web_peer_address(identifier, address);
}

/* the one that has the peer rewrites the destination; the desktop's is
asked first, on a copy (it is changed only if the peer is its) */
int p2p_outgoing(int stream, int socket, unsigned long *address, unsigned short *port)
{
	int native = 0;
	int web;

	if (native_running())
	{
		unsigned long native_address = *address;
		unsigned short native_port = *port;

		native = p2p_native_outgoing(stream, socket, &native_address, &native_port);
		if (native > 0)
		{
			*address = native_address;
			*port = native_port;
			return native;
		}
	}
	web = p2p_web_outgoing(stream, socket, address, port);
	return web ? web : native;
}

/* (their stand-ins are web_net.c's sockets: no two have one port) */
int p2p_incoming(int stream, unsigned long *address, unsigned short *port)
{
	return (native_running() && p2p_native_incoming(stream, address, port)) ||
		p2p_web_incoming(stream, address, port);
}

int p2p_broadcast_targets(unsigned short port, unsigned long *addresses, unsigned short *ports, int maximum_count)
{
	int count = native_running() ? p2p_native_broadcast_targets(port, addresses, ports, maximum_count) : 0;

	return count + p2p_web_broadcast_targets(port, addresses + count, ports + count, maximum_count - count);
}

int p2p_send_datagram(unsigned short source_port, unsigned long address, unsigned short port, const void *data,
	int size)
{
	int native = native_running() ? p2p_native_send_datagram(source_port, address, port, data, size) : 0;
	int web;

	if (native > 0)
		return native;
	web = p2p_web_send_datagram(source_port, address, port, data, size);
	return web ? web : native;
}

int p2p_broadcast_datagram(unsigned short source_port, unsigned short port, const void *data, int size)
{
	return (native_running() ? p2p_native_broadcast_datagram(source_port, port, data, size) : 0) +
		p2p_web_broadcast_datagram(source_port, port, data, size);
}

void p2p_socket_port(int socket, int stream, int listening, unsigned short port)
{
	if (!keep_port(socket, stream, listening, port, 0))
		p2p_native_socket_port(socket, stream, listening, port);
	p2p_web_socket_port(socket, stream, listening, port);
}

void p2p_port_taken(int stream, unsigned short port)
{
	if (!keep_port(-1, stream, 0, port, 1))
		p2p_native_port_taken(stream, port);
	p2p_web_port_taken(stream, port);
}

void p2p_socket_closed(int socket, unsigned short datagram_port)
{
	int index;

	pthread_mutex_lock(&select_lock);
	for (index = 0; index < select_state.port_count; index++)
	{
		if (!select_state.ports[index].taken && select_state.ports[index].socket == socket)
		{
			select_state.ports[index] = select_state.ports[--select_state.port_count];
			break;
		}
	}
	pthread_mutex_unlock(&select_lock);
	if (native_running())
		p2p_native_socket_closed(socket, datagram_port);
	p2p_web_socket_closed(socket, datagram_port);
}

const char *p2p_take_clipboard_text(void)
{
	/* (the desktop's makes none: it never hosts) */
	if (native_running())
		p2p_native_take_clipboard_text();
	return p2p_web_take_clipboard_text();
}

void p2p_set_game_player_counts(int count, int maximum)
{
	if (native_running())
		p2p_native_set_game_player_counts(count, maximum);
	p2p_web_set_game_player_counts(count, maximum);
}

void p2p_discord_sanitize(char *destination, int size, const char *source, int name)
{
	p2p_native_discord_sanitize(destination, size, source, name);
}

/* (a browser has neither) */
void p2p_discord_identity(char *id, int id_size, char *name, int name_size)
{
	p2p_web_discord_identity(id, id_size, name, name_size);
}

void p2p_hardware_id(char *hex, int size)
{
	p2p_web_hardware_id(hex, size);
}

void p2p_hardware_id_sanitize(char *destination, int size, const char *source)
{
	p2p_native_hardware_id_sanitize(destination, size, source);
}

unsigned long p2p_peer_endpoint_address(unsigned long virtual_address)
{
	unsigned long address = native_running() ? p2p_native_peer_endpoint_address(virtual_address) : 0;

	return address ? address : p2p_web_peer_endpoint_address(virtual_address);
}

/* ---- the PC menus' internet games: hosted for browsers (a room) */

void p2p_set_hosting_allowed(int allowed)
{
	p2p_web_set_hosting_allowed(allowed);
}

int p2p_invite_link(char *link, int size)
{
	return p2p_web_invite_link(link, size);
}

void p2p_set_hosting_public(int public)
{
	p2p_web_set_hosting_public(public);
}

void p2p_set_hosting_password(const char *password)
{
	p2p_web_set_hosting_password(password);
}

void p2p_set_game_listing(const char *name, const char *map, const char *gametype, int engine_type, int open,
	int in_progress, int has_teams)
{
	p2p_web_set_game_listing(name, map, gametype, engine_type, open, in_progress, has_teams);
}

/* ---- the server browser: the browsers' games (the rooms', named [WEB]:
web_p2p.c), then desktop builds' public games */

void p2p_lobby_browse(int on)
{
	if (on)
		start_native();
	if (native_running())
		p2p_native_lobby_browse(on);
}

void p2p_lobby_refresh(void)
{
	if (native_running())
		p2p_native_lobby_refresh();
}

int p2p_lobby_games(struct p2p_listing *games, int maximum_count)
{
	int count = p2p_web_lobby_games(games, maximum_count);

	if (native_running())
		count += p2p_native_lobby_games(games + count, maximum_count - count);
	return count;
}

void p2p_lobby_mark_failed(const unsigned char *identifier)
{
	if (native_running())
		p2p_native_lobby_mark_failed(identifier);
}

/* (a listing's own work, the password's key: the desktop's need not have
started) */
int p2p_listing_unlock(struct p2p_listing *listing, const char *password)
{
	return p2p_native_listing_unlock(listing, password);
}
