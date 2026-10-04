/*
WEB_P2P_SELECT.C

p2p.h for the game, from one of the browser build's two internet plays
(NETWORK.md, "Native games"):

- web_p2p.c (p2p_web_*): links to other browsers, through the page
  (Cloudflare Realtime SFU, or the page's other tabs). The default.
- the desktop's own p2p.c (p2p_native_*, with p2p_signal.c, p2p_crypto.c
  and p2p_discord.c): to join a desktop build's game with its invite
  (halo://join/...), through its MQTT signalling and its tunnel, whose
  sockets to the internet web_net.c carries through the relay. (A page
  joins desktop builds' games; it hosts for browsers only.)

tools/web_build.py compiles each with p2p.h's functions renamed. The page
chooses before the game starts: HALO_NET_NATIVE (set, with a #native=
invite: app/src/game.js) takes the desktop's, and HALO_NET_NATIVE_INVITE is
the invite it joins once it starts. A choice holds
for the visit: the machine's identifier, which its XNADDR carries, is the
chosen one's.
*/

#include "platform.h"
#include "posix.h"
#include "p2p.h"

#include <emscripten/emscripten.h>
#include <stdlib.h>

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
	unsigned long prefix##_peer_endpoint_address(unsigned long virtual_address);

P2P_BACKEND(p2p_web)
P2P_BACKEND(p2p_native)

/* whichever the page chose */
#define CHOSEN(function, ...) (native() ? p2p_native_##function(__VA_ARGS__) : p2p_web_##function(__VA_ARGS__))

static int native(void)
{
	/* (the environment is the page's from before main: it does not change) */
	static int chosen = -1;

	if (chosen < 0)
		chosen = getenv("HALO_NET_NATIVE") != NULL;
	return chosen;
}

/* the page's: whether the desktop's internet play is the one (it starts
the relay's bridge then: app/src/relay_bridge.js) */
EMSCRIPTEN_KEEPALIVE int web_p2p_native(void)
{
	return native();
}

/* the page's: joins a desktop build's invite (internet play must be the
desktop's); nonzero if it held one */
EMSCRIPTEN_KEEPALIVE int web_p2p_join_native(const char *text)
{
	return native() && p2p_native_join_invite(text);
}

void p2p_initialize(unsigned long local_address)
{
	const char *invite;

	if (!native())
	{
		p2p_web_initialize(local_address);
		return;
	}
	p2p_native_initialize(local_address);
	invite = getenv("HALO_NET_NATIVE_INVITE");
	if (invite && *invite && !p2p_native_join_invite(invite))
		platform_log("Internet play: HALO_NET_NATIVE_INVITE holds no invite");
}

int p2p_hand_off_invite(void)
{
	return CHOSEN(hand_off_invite);
}

int p2p_join_invite(const char *text)
{
	return CHOSEN(join_invite, text);
}

const unsigned char *p2p_identifier(void)
{
	return CHOSEN(identifier);
}

int p2p_peer_address(const unsigned char *identifier, unsigned long *address)
{
	return CHOSEN(peer_address, identifier, address);
}

int p2p_outgoing(int stream, int socket, unsigned long *address, unsigned short *port)
{
	return CHOSEN(outgoing, stream, socket, address, port);
}

int p2p_incoming(int stream, unsigned long *address, unsigned short *port)
{
	return CHOSEN(incoming, stream, address, port);
}

int p2p_broadcast_targets(unsigned short port, unsigned long *addresses, unsigned short *ports, int maximum_count)
{
	return CHOSEN(broadcast_targets, port, addresses, ports, maximum_count);
}

int p2p_send_datagram(unsigned short source_port, unsigned long address, unsigned short port, const void *data,
	int size)
{
	return CHOSEN(send_datagram, source_port, address, port, data, size);
}

int p2p_broadcast_datagram(unsigned short source_port, unsigned short port, const void *data, int size)
{
	return CHOSEN(broadcast_datagram, source_port, port, data, size);
}

void p2p_socket_port(int socket, int stream, int listening, unsigned short port)
{
	CHOSEN(socket_port, socket, stream, listening, port);
}

void p2p_port_taken(int stream, unsigned short port)
{
	CHOSEN(port_taken, stream, port);
}

void p2p_socket_closed(int socket, unsigned short datagram_port)
{
	CHOSEN(socket_closed, socket, datagram_port);
}

const char *p2p_take_clipboard_text(void)
{
	if (!native())
		return p2p_web_take_clipboard_text();
	/* (an invite of the desktop's, should the game's own menus host: a
	worker's clipboard is no one's, and the page hosts for browsers only) */
	p2p_native_take_clipboard_text();
	return NULL;
}

void p2p_set_game_player_counts(int count, int maximum)
{
	CHOSEN(set_game_player_counts, count, maximum);
}

void p2p_discord_sanitize(char *destination, int size, const char *source, int name)
{
	CHOSEN(discord_sanitize, destination, size, source, name);
}

void p2p_discord_identity(char *id, int id_size, char *name, int name_size)
{
	CHOSEN(discord_identity, id, id_size, name, name_size);
}

void p2p_hardware_id(char *hex, int size)
{
	CHOSEN(hardware_id, hex, size);
}

void p2p_hardware_id_sanitize(char *destination, int size, const char *source)
{
	CHOSEN(hardware_id_sanitize, destination, size, source);
}

unsigned long p2p_peer_endpoint_address(unsigned long virtual_address)
{
	return CHOSEN(peer_endpoint_address, virtual_address);
}
