/*
WEB_P2P.C

The browser build's internet play: all of p2p.h, in place of the desktop's
p2p.c (with p2p_signal.c, p2p_crypto.c, p2p_discord.c and posix_upnp.c,
which tools/web_build.py leaves out). The game and xnet.c call p2p.h as on
the desktop and are not changed (NETWORK.md, "The game's side").

As in p2p.c, machines this one has a link to reach each other's system
link games as if on one LAN:

- Each peer gets a virtual address in 100.64.0.0/10 from its identifier,
  which the game sees (XNetXnAddrToInAddr maps the peer's XNADDR to it).
- The game's datagrams to a peer go onto its link at once
  (p2p_send_datagram); otherwise xnet.c rewrites the game's destinations
  there to local stand-ins: a UDP socket here per peer and port, and a TCP
  listener per peer and port, whose connections go over the link as
  streams. Traffic arriving from a peer leaves these stand-ins, and xnet.c
  reports it as coming from the peer's address (p2p_incoming). The
  stand-ins are web_net.c's sockets, as p2p.c's are the system's.
- Broadcasts also go to every peer, so a host's game shows up in its
  peers' system link lists, and joining works as on a LAN. A peer reaches
  only the game's own ports.

What differs from p2p.c is the tunnel. The links are the page's
(app/src/net_bridge.js): data channels through Cloudflare Realtime SFU, or,
to test, the page's other tabs. Here are two rings in shared memory
(struct web_bridge), one each way, of records that NETWORK.md describes
(the link's channels' framing inside them); the page is woken by an atomic
notify on out_sequence, this thread by a datagram on its wake socket
(web_p2p_wake, which the page calls). A link is reliable and ordered, or
not, and encrypted, so KCP and p2p.c's sealing are not needed; signalling,
STUN and UPnP are the page's (or the SFU's) concern.

The work happens on a thread of its own, under p2p_lock; the game's threads
only look up and create stand-ins, and queue datagrams.
*/

#include "platform.h"
#include "posix.h"
#include "p2p.h"
#include "halo_port_limits.h"

#include <emscripten/emscripten.h>
#include <ctype.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum
{
	IDENTIFIER_SIZE = 6,
	/* the page's link numbers: 0 to MAXIMUM_LINKS - 1 */
	MAXIMUM_LINKS = 128,

	/* a host needs a UDP stand-in for two or three ports of every other
	machine, and a stream for each one's connection; one peer can have no
	more than these (as p2p.c) */
	MAXIMUM_PROXIES = 512,
	MAXIMUM_PEER_PROXIES = 4,
	MAXIMUM_LISTENERS = 64,
	MAXIMUM_STREAMS = 160,
	MAXIMUM_PEER_STREAMS = 4,
	MAXIMUM_GAME_PORTS = 64,
	MAXIMUM_SENT_PORTS = 16,
	MAXIMUM_CLOSED_PORTS = 128,
	MAXIMUM_RETIRED_ADDRESSES = 32,
	CLOSED_PORT_TIME = 5000,
	PROXY_REPLACE_TIME = 1000,
	PROXY_IDLE_TIME = 60000,

	/* the largest datagram the game sends (WSAStartup's iMaxUdpDg) fits */
	MAXIMUM_DATAGRAM_SIZE = 1400,
	/* a stream's data message (NETWORK.md) */
	STREAM_CHUNK_SIZE = 16 * 1024,
	/* what a stream holds for the game that it has not read: past this,
	the stream ends */
	MAXIMUM_STREAM_PENDING = 256 * 1024,

	/* the bridge's rings, each way */
	RING_SIZE = 1 << 20,
	RECORD_HEADER_SIZE = 4,
	BRIDGE_MAGIC = 0x48414C4F,
	BRIDGE_VERSION = 1,

	/* milliseconds the thread sleeps at most */
	LOOP_INTERVAL = 100,
	/* while the ring to the page is too full to read the game's streams */
	FULL_RING_INTERVAL = 5,
};

/* the records of the ring to the page (NETWORK.md, "The bridge") */
enum
{
	_out_reliable = 0,
	_out_unreliable,
	/* the game hosts (it listens for connections), or no longer */
	_out_hosting,
	_out_not_hosting,
	/* the page is to join the room of this invite (the menus' Direct Link) */
	_out_join,
};

/* the records of the ring from the page */
enum
{
	/* a link is up: its peer's identifier */
	_in_link_up = 0,
	_in_link_down,
	_in_reliable,
	_in_unreliable,
};

/* a stream's messages on the reliable channel (NETWORK.md) */
enum
{
	_stream_open = 0,
	_stream_data,
	_stream_close,
	_stream_refused,
};

/* (the stream number's top bit: the stream is the receiver's own) */
#define STREAM_RECEIVER_OPENED 0x8000

/* one way between this thread and the page: bytes head - tail in data
(the counts run on and wrap), whole records of RECORD_HEADER_SIZE bytes (a
little-endian 16-bit size of what follows, the link, the record's type)
then that many bytes */
struct web_ring
{
	unsigned int head;
	unsigned int tail;
	unsigned int size;
	unsigned int reserved;
	unsigned char data[RING_SIZE];
};

/* what the page finds through web_p2p_bridge() */
struct web_bridge
{
	unsigned int magic;
	unsigned int version;
	/* raised, and notified, with each record to the page */
	unsigned int out_sequence;
	/* raised, and notified, as records from the page are taken */
	unsigned int in_sequence;
	/* this machine's identifier (6 bytes), then the game's network version
	(HALO_PORT_NETWORK_VERSION, little-endian), which a room checks */
	unsigned char identifier[8];
	struct web_ring out;
	struct web_ring in;
};

struct peer
{
	int used;
	unsigned char identifier[IDENTIFIER_SIZE];
	char name[2 * IDENTIFIER_SIZE + 1];
	unsigned long virtual_address;
	short proxies[MAXIMUM_PEER_PROXIES];
	int proxy_count;
	/* the number of the next stream this machine opens to it */
	unsigned short next_stream;
};

/* a UDP stand-in for one port of a peer */
struct proxy
{
	int socket;
	int peer;
	unsigned short remote_port;
	unsigned short local_port;
	unsigned long used_time;
	/* the game's socket connected to it, or -1: while there is one, it
	stays */
	int pinned_socket;
};

/* a TCP stand-in for one port of a peer: takes the game's connections */
struct listener
{
	int socket;
	int peer;
	unsigned short remote_port;
	unsigned short local_port;
};

/* one of the game's TCP connections, carried over a link */
struct stream
{
	int used;
	int peer;
	/* its number, and whether this machine opened it */
	unsigned short number;
	int own;
	/* the local end: the game's connection to a listener, or a connection
	to the game made for a peer's (whose port stands for the peer's) */
	int socket;
	int connecting;
	unsigned short local_port;
	unsigned short remote_port;
	/* the peer closed it: once what it sent is with the game, close */
	int remote_closed;
	unsigned char *pending;
	int pending_size;
};

struct game_port
{
	int socket;
	/* 0: none */
	unsigned short port;
	unsigned char stream;
	unsigned char listening;
};

/* a stand-in closed lately (p2p_incoming) */
struct closed_port
{
	unsigned short local_port;
	unsigned short remote_port;
	int stream;
	unsigned long virtual_address;
	unsigned long time;
};

static struct web_bridge bridge = { BRIDGE_MAGIC, BRIDGE_VERSION };

static pthread_mutex_t p2p_lock = PTHREAD_MUTEX_INITIALIZER;

static struct
{
	int running;
	unsigned long local_address;
	int wake_socket;
	int wake_sender;
	unsigned short wake_port;

	struct peer peers[MAXIMUM_LINKS];
	struct proxy proxies[MAXIMUM_PROXIES];
	struct listener listeners[MAXIMUM_LISTENERS];
	struct stream streams[MAXIMUM_STREAMS];
	struct closed_port closed[MAXIMUM_CLOSED_PORTS];
	int closed_next;
	unsigned long retired[MAXIMUM_RETIRED_ADDRESSES];
	int retired_next;
	struct game_port game_ports[MAXIMUM_GAME_PORTS];
	unsigned short sent_ports[MAXIMUM_SENT_PORTS];
	int sent_port_next;
	int hosting_socket;
	int told_hosting;
	/* the menus' Create Game: for the internet (a room), not LAN */
	int hosting_allowed;
} p2p = { .wake_socket = -1, .wake_sender = -1, .hosting_socket = -1, .hosting_allowed = 1 };

/* the invite of the room the page made for the game hosted, which the page
writes here (app/src/game.js), for the menus to show and copy; empty if none */
static char room_invite[256];

/* ---------- helpers */

static unsigned long now(void)
{
	return GetTickCount();
}

static int elapsed(unsigned long since, unsigned long time)
{
	return (unsigned int)(now() - since) >= (unsigned int)time;
}

static unsigned long network_long(unsigned long value)
{
	return __builtin_bswap32(value);
}

static void put_short(unsigned char *bytes, unsigned short value)
{
	/* value is in network byte order already */
	memcpy(bytes, &value, 2);
}

static unsigned short get_short(const unsigned char *bytes)
{
	unsigned short value;

	memcpy(&value, bytes, 2);
	return value;
}

/* a stream number on the wire, big-endian */
static void put_number(unsigned char *bytes, unsigned short value)
{
	bytes[0] = (unsigned char)(value >> 8);
	bytes[1] = (unsigned char)value;
}

static unsigned short get_number(const unsigned char *bytes)
{
	return (unsigned short)(bytes[0] << 8 | bytes[1]);
}

static void make_address(struct sockaddr_in *address, unsigned long ip, unsigned short port)
{
	memset(address, 0, sizeof(*address));
	address->sin_family = AF_INET;
	address->sin_port = port;
	address->sin_addr.s_addr = ip;
}

/* a UDP or TCP socket bound to ip:port (0 for any), not blocking; its port
through bound_port; -1 on failure */
static int open_socket(int type, unsigned long ip, unsigned short port, unsigned short *bound_port)
{
	struct sockaddr_in address;
	int length = sizeof(address);
	int result = posix_socket(AF_INET, type, 0);

	if (result < 0)
		return -1;
	make_address(&address, ip, port);
	if (posix_socket_bind(result, &address, sizeof(address)) < 0 ||
		posix_socket_getsockname(result, &address, &length) < 0 ||
		posix_socket_set_nonblocking(result, 1) < 0)
	{
		posix_socket_close(result);
		return -1;
	}
	if (bound_port)
		*bound_port = address.sin_port;
	return result;
}

static void close_socket(int *socket)
{
	if (*socket >= 0)
		posix_socket_close(*socket);
	*socket = -1;
}

static int would_block(void)
{
	int error = posix_socket_last_error();

	return error == WSAEWOULDBLOCK || error == WSAEINPROGRESS;
}

static void hex(const unsigned char *bytes, int size, char *text)
{
	static const char digits[] = "0123456789abcdef";
	int index;

	for (index = 0; index < size; index++)
	{
		text[index * 2] = digits[bytes[index] >> 4];
		text[index * 2 + 1] = digits[bytes[index] & 15];
	}
	text[size * 2] = 0;
}

/* ---------- the bridge's rings */

static unsigned int ring_used(struct web_ring *ring)
{
	return __atomic_load_n(&ring->head, __ATOMIC_ACQUIRE) - __atomic_load_n(&ring->tail, __ATOMIC_ACQUIRE);
}

static void ring_copy_in(struct web_ring *ring, unsigned int position, const void *data, int size)
{
	unsigned int offset = position % RING_SIZE;
	unsigned int first = (unsigned int)size < RING_SIZE - offset ? (unsigned int)size : RING_SIZE - offset;

	memcpy(ring->data + offset, data, first);
	memcpy(ring->data, (const unsigned char *)data + first, (size_t)size - first);
}

static void ring_copy_out(struct web_ring *ring, unsigned int position, void *data, int size)
{
	unsigned int offset = position % RING_SIZE;
	unsigned int first = (unsigned int)size < RING_SIZE - offset ? (unsigned int)size : RING_SIZE - offset;

	memcpy(data, ring->data + offset, first);
	memcpy((unsigned char *)data + first, ring->data, (size_t)size - first);
}

/* room in the ring to the page for a record of size bytes */
static int out_room(int size)
{
	return RING_SIZE - ring_used(&bridge.out) >= (unsigned int)(RECORD_HEADER_SIZE + size);
}

/* a record to the page, of a header and a body (either may be empty); 0 if
the ring is full (an unreliable one is lost then; a reliable one's sender
checks out_room first). Under p2p_lock, which keeps the game's threads
and this one from writing at once */
static int out_record(int link, int type, const void *header, int header_size, const void *body, int body_size)
{
	unsigned char record[RECORD_HEADER_SIZE];
	unsigned int head = bridge.out.head;
	int size = header_size + body_size;

	if (size > 0xFFFF || !out_room(size))
		return 0;
	record[0] = (unsigned char)size;
	record[1] = (unsigned char)(size >> 8);
	record[2] = (unsigned char)link;
	record[3] = (unsigned char)type;
	ring_copy_in(&bridge.out, head, record, RECORD_HEADER_SIZE);
	ring_copy_in(&bridge.out, head + RECORD_HEADER_SIZE, header, header_size);
	ring_copy_in(&bridge.out, head + RECORD_HEADER_SIZE + header_size, body, body_size);
	__atomic_store_n(&bridge.out.head, head + RECORD_HEADER_SIZE + size, __ATOMIC_RELEASE);
	__atomic_add_fetch(&bridge.out_sequence, 1, __ATOMIC_SEQ_CST);
	__builtin_wasm_memory_atomic_notify((int *)&bridge.out_sequence, ~0u);
	return 1;
}

/* the page's: where the bridge is (and this machine's identifier in it) */
EMSCRIPTEN_KEEPALIVE struct web_bridge *web_p2p_bridge(void)
{
	memcpy(bridge.identifier, p2p_identifier(), IDENTIFIER_SIZE);
	bridge.identifier[6] = (unsigned char)HALO_PORT_NETWORK_VERSION;
	bridge.identifier[7] = (unsigned char)(HALO_PORT_NETWORK_VERSION >> 8);
	bridge.out.size = RING_SIZE;
	bridge.in.size = RING_SIZE;
	return &bridge;
}

/* the page's, after it writes records: wakes the thread (from the page's
main thread: a short wait for web_net.c's lock, no more) */
EMSCRIPTEN_KEEPALIVE void web_p2p_wake(void)
{
	unsigned short port = __atomic_load_n(&p2p.wake_port, __ATOMIC_ACQUIRE);
	int sender = __atomic_load_n(&p2p.wake_sender, __ATOMIC_ACQUIRE);
	struct sockaddr_in to;
	unsigned char byte = 0;

	if (!port || sender < 0)
		return;
	make_address(&to, network_long(0x7F000001), port);
	posix_socket_sendto(sender, &byte, 1, 0, &to, sizeof(to));
}

/* ---------- this machine */

/* this machine's identifier when the desktop's internet play runs beside
this (web_p2p_select.c): one for both, as the game's XNADDR has one */
const unsigned char *web_p2p_shared_identifier(void);

const unsigned char *p2p_identifier(void)
{
	return web_p2p_shared_identifier();
}

/* ---------- peers */

static int is_virtual_address(unsigned long address)
{
	/* 100.64.0.0/10 */
	return (network_long(address) & 0xFFC00000) == 0x64400000;
}

static struct peer *find_peer(const unsigned char *identifier)
{
	int index;

	for (index = 0; index < MAXIMUM_LINKS; index++)
	{
		if (p2p.peers[index].used && !memcmp(p2p.peers[index].identifier, identifier, IDENTIFIER_SIZE))
			return &p2p.peers[index];
	}
	return NULL;
}

static struct peer *find_peer_by_address(unsigned long address)
{
	int index;

	for (index = 0; index < MAXIMUM_LINKS; index++)
	{
		if (p2p.peers[index].used && p2p.peers[index].virtual_address == address)
			return &p2p.peers[index];
	}
	return NULL;
}

static int peer_index(const struct peer *peer)
{
	return (int)(peer - p2p.peers);
}

/* an address in 100.64.0.0/10 from the identifier, not one another peer
has. Only this machine sees it (each machine gives its peers their own),
so any hash will do: FNV-1a */
static unsigned long virtual_address_for(const unsigned char *identifier)
{
	unsigned long value = 2166136261u;
	int index;

	for (index = 0; index < IDENTIFIER_SIZE; index++)
		value = (value ^ identifier[index]) * 16777619u;
	for (;;)
	{
		unsigned long address = 0x64400000 | (value & 0x3FFFFF);

		/* no .0 or .255, which look like network and broadcast addresses */
		if ((address & 255) != 0 && (address & 255) != 255 && !find_peer_by_address(network_long(address)))
			return network_long(address);
		value++;
	}
}

/* a peer's address that it had, which is never to be sent to itself */
static int address_retired(unsigned long address)
{
	int index;

	for (index = 0; index < MAXIMUM_RETIRED_ADDRESSES; index++)
	{
		if (p2p.retired[index] == address)
			return 1;
	}
	return 0;
}

/* ---------- stand-ins (as p2p.c's) */

/* a stand-in of a peer's port closes: traffic from it that the game has not
read yet still comes from the peer (p2p_incoming) */
static void remember_closed(int stream, unsigned short local_port, int peer, unsigned short remote_port)
{
	struct closed_port *closed = &p2p.closed[p2p.closed_next++ % MAXIMUM_CLOSED_PORTS];

	closed->stream = stream;
	closed->local_port = local_port;
	closed->virtual_address = p2p.peers[peer].virtual_address;
	closed->remote_port = remote_port;
	closed->time = now();
}

static int find_closed(int stream, unsigned long *address, unsigned short *port)
{
	int index;

	for (index = 0; index < MAXIMUM_CLOSED_PORTS; index++)
	{
		struct closed_port const *closed = &p2p.closed[index];

		if (closed->local_port == *port && closed->stream == stream && closed->virtual_address &&
			!elapsed(closed->time, CLOSED_PORT_TIME))
		{
			*address = closed->virtual_address;
			*port = closed->remote_port;
			return 1;
		}
	}
	return 0;
}

static void forget_closed(int stream, unsigned short local_port)
{
	int index;

	for (index = 0; index < MAXIMUM_CLOSED_PORTS; index++)
	{
		if (p2p.closed[index].local_port == local_port && p2p.closed[index].stream == stream)
			p2p.closed[index].virtual_address = 0;
	}
}

static void proxy_close(struct proxy *proxy)
{
	struct peer *peer = &p2p.peers[proxy->peer];
	int index = (int)(proxy - p2p.proxies);
	int entry;

	if (proxy->socket < 0)
		return;
	close_socket(&proxy->socket);
	remember_closed(0, proxy->local_port, proxy->peer, proxy->remote_port);
	for (entry = 0; entry < peer->proxy_count; entry++)
	{
		if (peer->proxies[entry] == index)
		{
			peer->proxies[entry] = peer->proxies[--peer->proxy_count];
			break;
		}
	}
}

static void listener_close(struct listener *listener)
{
	if (listener->socket < 0)
		return;
	close_socket(&listener->socket);
	remember_closed(1, listener->local_port, listener->peer, listener->remote_port);
}

static struct proxy *find_proxy(int peer, unsigned short remote_port, int create)
{
	struct peer *entry = &p2p.peers[peer];
	struct proxy *free_proxy = NULL;
	struct proxy *oldest = NULL;
	int index;

	for (index = 0; index < entry->proxy_count; index++)
	{
		struct proxy *proxy = &p2p.proxies[entry->proxies[index]];

		if (proxy->remote_port == remote_port)
		{
			proxy->used_time = now();
			return proxy;
		}
		if (proxy->pinned_socket < 0 && (!oldest || (long)(proxy->used_time - oldest->used_time) < 0))
			oldest = proxy;
	}
	if (!create)
		return NULL;
	/* past a peer's few, its least used goes: no peer takes them all */
	if (entry->proxy_count >= MAXIMUM_PEER_PROXIES)
	{
		if (!oldest || !elapsed(oldest->used_time, PROXY_REPLACE_TIME))
			return NULL;
		proxy_close(oldest);
		free_proxy = oldest;
	}
	for (index = 0; index < MAXIMUM_PROXIES && !free_proxy; index++)
	{
		if (p2p.proxies[index].socket < 0)
			free_proxy = &p2p.proxies[index];
	}
	if (!free_proxy)
		return NULL;
	free_proxy->socket = open_socket(SOCK_DGRAM, p2p.local_address, 0, &free_proxy->local_port);
	if (free_proxy->socket < 0)
		return NULL;
	free_proxy->peer = peer;
	free_proxy->remote_port = remote_port;
	free_proxy->used_time = now();
	free_proxy->pinned_socket = -1;
	entry->proxies[entry->proxy_count++] = (short)(free_proxy - p2p.proxies);
	forget_closed(0, free_proxy->local_port);
	return free_proxy;
}

static struct proxy *find_proxy_by_port(unsigned short local_port)
{
	int index;

	for (index = 0; index < MAXIMUM_PROXIES; index++)
	{
		if (p2p.proxies[index].socket >= 0 && p2p.proxies[index].local_port == local_port)
			return &p2p.proxies[index];
	}
	return NULL;
}

static void expire_proxies(void)
{
	int index;

	for (index = 0; index < MAXIMUM_PROXIES; index++)
	{
		struct proxy *proxy = &p2p.proxies[index];

		if (proxy->socket >= 0 && proxy->pinned_socket < 0 && elapsed(proxy->used_time, PROXY_IDLE_TIME))
			proxy_close(proxy);
	}
}

static struct listener *find_listener(int peer, unsigned short remote_port)
{
	struct listener *free_listener = NULL;
	int index;

	for (index = 0; index < MAXIMUM_LISTENERS; index++)
	{
		struct listener *listener = &p2p.listeners[index];

		if (listener->socket < 0)
		{
			if (!free_listener)
				free_listener = listener;
		}
		else if (listener->peer == peer && listener->remote_port == remote_port)
			return listener;
	}
	if (!free_listener)
		return NULL;
	free_listener->socket = open_socket(SOCK_STREAM, p2p.local_address, 0, &free_listener->local_port);
	if (free_listener->socket < 0)
		return NULL;
	if (posix_socket_listen(free_listener->socket, 8) < 0)
	{
		close_socket(&free_listener->socket);
		return NULL;
	}
	free_listener->peer = peer;
	free_listener->remote_port = remote_port;
	forget_closed(1, free_listener->local_port);
	return free_listener;
}

/* whether a peer may reach this port of the game's: one a socket of the
game's listens on (stream), or a datagram socket's, bound or sent from to a
peer */
static int game_port_open(int stream, unsigned short port)
{
	int index;

	for (index = 0; index < MAXIMUM_GAME_PORTS; index++)
	{
		struct game_port const *entry = &p2p.game_ports[index];

		if (entry->port == port && entry->stream == (stream != 0) && (!stream || entry->listening))
			return 1;
	}
	for (index = 0; index < MAXIMUM_SENT_PORTS && !stream; index++)
	{
		if (port && p2p.sent_ports[index] == port)
			return 1;
	}
	return 0;
}

/* ---------- datagrams */

/* a datagram from the game's port source_port to the peer's port: lost if
the ring to the page is full, as a datagram may be */
static void datagram_send(struct peer *peer, unsigned short source_port, unsigned short port, const void *data,
	int size)
{
	unsigned char header[4];

	if (size < 0 || size > MAXIMUM_DATAGRAM_SIZE)
		return;
	/* (the peer answers to that port) */
	if (!game_port_open(0, source_port))
		p2p.sent_ports[p2p.sent_port_next++ % MAXIMUM_SENT_PORTS] = source_port;
	put_short(header, source_port);
	put_short(header + 2, port);
	out_record(peer_index(peer), _out_unreliable, header, sizeof(header), data, size);
}

/* a datagram from the game to a peer, through its stand-in (from a socket
connected to it, or not bound yet: p2p_send_datagram sends the rest) */
static void proxy_readable(struct proxy *proxy)
{
	unsigned char data[MAXIMUM_DATAGRAM_SIZE];
	int count;

	for (count = 0; count < 64; count++)
	{
		struct sockaddr_in from;
		int from_length = sizeof(from);
		int size = posix_socket_recvfrom(proxy->socket, data, sizeof(data), 0, &from, &from_length);

		if (size < 0)
		{
			/* (one too large for a link is dropped; the rest stay) */
			if (posix_socket_last_error() == WSAEMSGSIZE)
				continue;
			break;
		}
		/* only the game's own sockets use a stand-in */
		if (from.sin_addr.s_addr != p2p.local_address && from.sin_addr.s_addr != network_long(0x7F000001))
			continue;
		proxy->used_time = now();
		datagram_send(&p2p.peers[proxy->peer], from.sin_port, proxy->remote_port, data, size);
	}
}

/* a datagram from a peer to the game */
static void datagram_received(int peer, const unsigned char *data, int size)
{
	struct proxy *proxy;
	struct sockaddr_in to;

	/* only to the game */
	if (size < 4 || !game_port_open(0, get_short(data + 2)))
		return;
	proxy = find_proxy(peer, get_short(data), 1);
	if (!proxy)
		return;
	make_address(&to, p2p.local_address, get_short(data + 2));
	posix_socket_sendto(proxy->socket, data + 4, size - 4, 0, &to, sizeof(to));
}

/* ---------- streams */

/* a stream's message to its peer (a data message's checks out_room first) */
static int stream_message(struct stream *stream, int kind, const void *data, int size)
{
	unsigned char header[3];

	header[0] = (unsigned char)kind;
	/* (to the peer, a stream it opened has the bit) */
	put_number(header + 1, (unsigned short)(stream->number | (stream->own ? 0 : STREAM_RECEIVER_OPENED)));
	return out_record(stream->peer, _out_reliable, header, sizeof(header), data, size);
}

static struct stream *stream_new(int peer, unsigned short number, int own)
{
	int index;

	for (index = 0; index < MAXIMUM_STREAMS; index++)
	{
		struct stream *stream = &p2p.streams[index];

		if (!stream->used)
		{
			memset(stream, 0, sizeof(*stream));
			stream->used = 1;
			stream->peer = peer;
			stream->number = number;
			stream->own = own;
			stream->socket = -1;
			return stream;
		}
	}
	return NULL;
}

static struct stream *find_stream(int peer, unsigned short number, int own)
{
	int index;

	for (index = 0; index < MAXIMUM_STREAMS; index++)
	{
		struct stream *stream = &p2p.streams[index];

		if (stream->used && stream->peer == peer && stream->number == number && stream->own == own)
			return stream;
	}
	return NULL;
}

static void stream_free(struct stream *stream)
{
	/* (the game may not have taken the connection made for it yet) */
	if (stream->local_port)
		remember_closed(1, stream->local_port, stream->peer, stream->remote_port);
	close_socket(&stream->socket);
	free(stream->pending);
	memset(stream, 0, sizeof(*stream));
	stream->socket = -1;
}

/* the game's end closed (or failed): the peer's closes too */
static void stream_local_closed(struct stream *stream)
{
	if (!stream->remote_closed)
		stream_message(stream, _stream_close, NULL, 0);
	stream_free(stream);
}

/* the game connected to a stand-in listener */
static void listener_readable(struct listener *listener)
{
	for (;;)
	{
		struct sockaddr_in from;
		int from_length = sizeof(from);
		int socket = posix_socket_accept(listener->socket, &from, &from_length);
		struct peer *peer = &p2p.peers[listener->peer];
		struct stream *stream;
		unsigned char open[4];

		if (socket < 0)
			return;
		if (from.sin_addr.s_addr != p2p.local_address && from.sin_addr.s_addr != network_long(0x7F000001))
		{
			posix_socket_close(socket);
			continue;
		}
		posix_socket_set_nonblocking(socket, 1);
		peer->next_stream = (unsigned short)((peer->next_stream + 1) & 0x7FFF);
		if (!peer->next_stream)
			peer->next_stream = 1;
		stream = stream_new(listener->peer, peer->next_stream, 1);
		if (!stream)
		{
			posix_socket_close(socket);
			continue;
		}
		stream->socket = socket;
		stream->remote_port = listener->remote_port;
		put_short(open, listener->remote_port);
		put_short(open + 2, from.sin_port);
		stream_message(stream, _stream_open, open, sizeof(open));
	}
}

/* a peer's connection opens: connect to the game for it */
static void stream_opened(int peer, unsigned short number, const unsigned char *data, int size)
{
	struct stream *stream;
	struct sockaddr_in to;
	int count = 0;
	int index;

	if (size < 4 || find_stream(peer, number, 0))
		return;
	for (index = 0; index < MAXIMUM_STREAMS; index++)
		count += p2p.streams[index].used && p2p.streams[index].peer == peer && !p2p.streams[index].own;
	stream = count < MAXIMUM_PEER_STREAMS ? stream_new(peer, number, 0) : NULL;
	if (stream)
	{
		stream->remote_port = get_short(data + 2);
		/* only to where the game listens: nothing else here is the peer's to
		reach */
		if (game_port_open(1, get_short(data)))
		{
			stream->socket = open_socket(SOCK_STREAM, p2p.local_address, 0, &stream->local_port);
			if (stream->socket >= 0)
				forget_closed(1, stream->local_port);
		}
		make_address(&to, p2p.local_address, get_short(data));
		if (stream->socket >= 0 && posix_socket_connect(stream->socket, &to, sizeof(to)) == 0)
			return;
		if (stream->socket >= 0 && would_block())
		{
			stream->connecting = 1;
			return;
		}
		stream->local_port = 0;
		stream_free(stream);
	}
	/* (refused: the opener's connection ends) */
	{
		unsigned char header[3];

		header[0] = _stream_refused;
		put_number(header + 1, (unsigned short)(number | STREAM_RECEIVER_OPENED));
		out_record(peer, _out_reliable, header, sizeof(header), NULL, 0);
	}
}

static void stream_flush_pending(struct stream *stream)
{
	while (stream->pending_size > 0 && stream->socket >= 0 && !stream->connecting)
	{
		int sent = posix_socket_send(stream->socket, stream->pending, stream->pending_size, 0);

		if (sent < 0)
		{
			if (!would_block())
				stream_local_closed(stream);
			return;
		}
		memmove(stream->pending, stream->pending + sent, (size_t)(stream->pending_size - sent));
		stream->pending_size -= sent;
	}
	if (stream->used && stream->remote_closed && !stream->pending_size)
		stream_free(stream);
}

static void stream_data(struct stream *stream, const unsigned char *data, int size)
{
	unsigned char *pending;

	if (stream->pending_size + size > MAXIMUM_STREAM_PENDING)
	{
		/* (the game does not read it: it ends) */
		platform_log("Internet play: a connection from %s ended (the game did not read it)",
			p2p.peers[stream->peer].name);
		stream_local_closed(stream);
		return;
	}
	pending = realloc(stream->pending, (size_t)(stream->pending_size + size));
	if (!pending)
	{
		stream_local_closed(stream);
		return;
	}
	stream->pending = pending;
	memcpy(stream->pending + stream->pending_size, data, (size_t)size);
	stream->pending_size += size;
	stream_flush_pending(stream);
}

/* a message on a link's reliable channel */
static void reliable_received(int peer, const unsigned char *data, int size)
{
	unsigned short wire;
	unsigned short number;
	int own;
	struct stream *stream;

	if (size < 3)
		return;
	wire = get_number(data + 1);
	number = wire & 0x7FFF;
	own = (wire & STREAM_RECEIVER_OPENED) != 0;
	if (data[0] == _stream_open)
	{
		if (!own)
			stream_opened(peer, number, data + 3, size - 3);
		return;
	}
	/* (one that ended here: what was on its way is let go) */
	stream = find_stream(peer, number, own);
	if (!stream)
		return;
	switch (data[0])
	{
	case _stream_data:
		stream_data(stream, data + 3, size - 3);
		break;
	case _stream_close:
		stream->remote_closed = 1;
		stream_flush_pending(stream);
		break;
	case _stream_refused:
		stream->remote_closed = 1;
		stream_free(stream);
		break;
	}
}

/* what the game wrote to a stream, to its peer, while the ring has room */
static void stream_readable(struct stream *stream)
{
	static unsigned char buffer[STREAM_CHUNK_SIZE];
	int count;

	for (count = 0; count < 8 && stream->used && stream->socket >= 0; count++)
	{
		int size;

		if (!out_room(3 + STREAM_CHUNK_SIZE))
			return;
		size = posix_socket_recv(stream->socket, buffer, sizeof(buffer), 0);
		if (size == 0 || (size < 0 && !would_block()))
		{
			stream_local_closed(stream);
			return;
		}
		if (size < 0)
			return;
		stream_message(stream, _stream_data, buffer, size);
	}
}

/* ---------- links */

static void link_up(int link, const unsigned char *identifier)
{
	struct peer *peer = &p2p.peers[link];
	struct peer *other = find_peer(identifier);

	if (other && other != peer)
		return;
	if (!peer->used)
	{
		memset(peer, 0, sizeof(*peer));
		peer->used = 1;
		memcpy(peer->identifier, identifier, IDENTIFIER_SIZE);
		hex(identifier, IDENTIFIER_SIZE, peer->name);
		peer->virtual_address = virtual_address_for(identifier);
		platform_log("Internet play: reached %s", peer->name);
	}
}

static void link_down(int link)
{
	struct peer *peer = &p2p.peers[link];
	int index;

	if (!peer->used)
		return;
	platform_log("Internet play: lost %s", peer->name);
	for (index = 0; index < MAXIMUM_STREAMS; index++)
	{
		if (p2p.streams[index].used && p2p.streams[index].peer == link)
		{
			p2p.streams[index].remote_closed = 1;
			stream_free(&p2p.streams[index]);
		}
	}
	for (index = 0; index < MAXIMUM_LISTENERS; index++)
	{
		if (p2p.listeners[index].socket >= 0 && p2p.listeners[index].peer == link)
			listener_close(&p2p.listeners[index]);
	}
	while (peer->proxy_count > 0)
		proxy_close(&p2p.proxies[peer->proxies[0]]);
	p2p.retired[p2p.retired_next++ % MAXIMUM_RETIRED_ADDRESSES] = peer->virtual_address;
	memset(peer, 0, sizeof(*peer));
}

/* takes what the page sent */
static void bridge_readable(void)
{
	static unsigned char body[0x10000];
	int taken = 0;

	for (;;)
	{
		unsigned char header[RECORD_HEADER_SIZE];
		unsigned int tail = __atomic_load_n(&bridge.in.tail, __ATOMIC_ACQUIRE);
		unsigned int used = ring_used(&bridge.in);
		int size;
		int link;

		if (used < RECORD_HEADER_SIZE)
			break;
		ring_copy_out(&bridge.in, tail, header, RECORD_HEADER_SIZE);
		size = header[0] | header[1] << 8;
		if (used < (unsigned int)(RECORD_HEADER_SIZE + size))
			break;
		ring_copy_out(&bridge.in, tail + RECORD_HEADER_SIZE, body, size);
		__atomic_store_n(&bridge.in.tail, tail + RECORD_HEADER_SIZE + size, __ATOMIC_RELEASE);
		taken = 1;
		link = header[2];
		if (link >= MAXIMUM_LINKS)
			continue;
		switch (header[3])
		{
		case _in_link_up:
			if (size >= IDENTIFIER_SIZE)
				link_up(link, body);
			break;
		case _in_link_down:
			link_down(link);
			break;
		case _in_reliable:
			if (p2p.peers[link].used)
				reliable_received(link, body, size);
			break;
		case _in_unreliable:
			if (p2p.peers[link].used)
				datagram_received(link, body, size);
			break;
		}
	}
	if (taken)
	{
		/* (the page may wait for room) */
		__atomic_add_fetch(&bridge.in_sequence, 1, __ATOMIC_SEQ_CST);
		__builtin_wasm_memory_atomic_notify((int *)&bridge.in_sequence, ~0u);
	}
}

/* tells the page when the game starts or stops hosting */
static void update_hosting(void)
{
	int hosting = p2p.hosting_socket >= 0 && __atomic_load_n(&p2p.hosting_allowed, __ATOMIC_ACQUIRE);

	if (hosting != p2p.told_hosting && out_record(0, hosting ? _out_hosting : _out_not_hosting, NULL, 0, NULL, 0))
		p2p.told_hosting = hosting;
}

static void *p2p_thread(void *unused)
{
	enum
	{
		MAXIMUM_WAITED = 1 + MAXIMUM_PROXIES + MAXIMUM_LISTENERS + MAXIMUM_STREAMS,
		_owner_wake = 0,
		_owner_proxy,
		_owner_listener,
		_owner_stream,
	};
	static int read[MAXIMUM_WAITED], write[MAXIMUM_WAITED];
	static int asked_read[MAXIMUM_WAITED], asked_write[MAXIMUM_WAITED];
	static int read_owners[MAXIMUM_WAITED], write_owners[MAXIMUM_WAITED];

	(void)unused;
	pthread_mutex_lock(&p2p_lock);
	for (;;)
	{
		int read_count = 0, write_count = 0, error_count = 0;
		int asked_read_count, asked_write_count;
		int wait = LOOP_INTERVAL;
		int index, asked;

		read_owners[read_count] = _owner_wake;
		read[read_count++] = p2p.wake_socket;
		for (index = 0; index < MAXIMUM_PROXIES; index++)
		{
			if (p2p.proxies[index].socket >= 0)
			{
				read_owners[read_count] = _owner_proxy | index << 8;
				read[read_count++] = p2p.proxies[index].socket;
			}
		}
		for (index = 0; index < MAXIMUM_LISTENERS; index++)
		{
			if (p2p.listeners[index].socket >= 0)
			{
				read_owners[read_count] = _owner_listener | index << 8;
				read[read_count++] = p2p.listeners[index].socket;
			}
		}
		for (index = 0; index < MAXIMUM_STREAMS; index++)
		{
			struct stream *stream = &p2p.streams[index];

			if (!stream->used || stream->socket < 0)
				continue;
			/* (what the game writes waits while the ring is full) */
			if (out_room(3 + STREAM_CHUNK_SIZE))
			{
				read_owners[read_count] = _owner_stream | index << 8;
				read[read_count++] = stream->socket;
			}
			else
			{
				wait = FULL_RING_INTERVAL;
			}
			if (stream->connecting || stream->pending_size)
			{
				write_owners[write_count] = _owner_stream | index << 8;
				write[write_count++] = stream->socket;
			}
		}
		update_hosting();

		asked_read_count = read_count;
		asked_write_count = write_count;
		memcpy(asked_read, read, sizeof(*read) * (size_t)read_count);
		memcpy(asked_write, write, sizeof(*write) * (size_t)write_count);
		pthread_mutex_unlock(&p2p_lock);
		posix_socket_select(read, &read_count, write, &write_count, NULL, &error_count, 0, wait * 1000, 0);
		pthread_mutex_lock(&p2p_lock);

		/* (the page's records, whether or not it woke the thread) */
		bridge_readable();
		for (index = 0, asked = 0; index < read_count; index++)
		{
			int owner;

			while (asked < asked_read_count && asked_read[asked] != read[index])
				asked++;
			if (asked >= asked_read_count)
				break;
			owner = read_owners[asked++];
			switch (owner & 255)
			{
			case _owner_wake:
			{
				unsigned char drain[16];

				while (posix_socket_recv(p2p.wake_socket, drain, sizeof(drain), 0) >= 0)
					;
				break;
			}
			case _owner_proxy:
				if (p2p.proxies[owner >> 8].socket >= 0)
					proxy_readable(&p2p.proxies[owner >> 8]);
				break;
			case _owner_listener:
				if (p2p.listeners[owner >> 8].socket >= 0)
					listener_readable(&p2p.listeners[owner >> 8]);
				break;
			case _owner_stream:
				if (p2p.streams[owner >> 8].used)
					stream_readable(&p2p.streams[owner >> 8]);
				break;
			}
		}
		for (index = 0, asked = 0; index < write_count; index++)
		{
			struct stream *stream;

			while (asked < asked_write_count && asked_write[asked] != write[index])
				asked++;
			if (asked >= asked_write_count)
				break;
			stream = &p2p.streams[write_owners[asked++] >> 8];
			if (!stream->used)
				continue;
			stream->connecting = 0;
			stream_flush_pending(stream);
		}
		expire_proxies();
	}
	return NULL;
}

void p2p_initialize(unsigned long local_address)
{
	pthread_t thread;
	int index;

	p2p_identifier();
	if (p2p.running)
		return;
	for (index = 0; index < MAXIMUM_PROXIES; index++)
		p2p.proxies[index].socket = -1;
	for (index = 0; index < MAXIMUM_LISTENERS; index++)
		p2p.listeners[index].socket = -1;
	for (index = 0; index < MAXIMUM_STREAMS; index++)
		p2p.streams[index].socket = -1;
	p2p.local_address = local_address;
	{
		unsigned short wake_port = 0;

		p2p.wake_socket = open_socket(SOCK_DGRAM, network_long(0x7F000001), 0, &wake_port);
		p2p.wake_sender = open_socket(SOCK_DGRAM, network_long(0x7F000001), 0, NULL);
		if (p2p.wake_socket < 0 || p2p.wake_sender < 0)
		{
			platform_log("Internet play: cannot open its sockets; it is off");
			return;
		}
		__atomic_store_n(&p2p.wake_port, wake_port, __ATOMIC_RELEASE);
	}
	p2p.running = 1;
	if (pthread_create(&thread, NULL, p2p_thread, NULL) != 0)
	{
		p2p.running = 0;
		platform_log("Internet play: cannot start its thread; it is off");
		return;
	}
	pthread_detach(thread);
	{
		char name[2 * IDENTIFIER_SIZE + 1];

		hex(p2p_identifier(), IDENTIFIER_SIZE, name);
		platform_log("Internet play: this machine is %s; the page's links reach its peers", name);
	}
}

/* ---------- p2p.h: the game's traffic (as p2p.c's) */

int p2p_outgoing(int stream, int socket, unsigned long *address, unsigned short *port)
{
	struct peer *peer;
	int result = 0;

	if (!is_virtual_address(*address) || !p2p.running)
		return 0;
	pthread_mutex_lock(&p2p_lock);
	peer = find_peer_by_address(*address);
	if (!peer)
		result = address_retired(*address) ? -1 : 0;
	else if (stream)
	{
		struct listener *listener = find_listener(peer_index(peer), *port);

		result = -1;
		if (listener)
		{
			*address = p2p.local_address;
			*port = listener->local_port;
			result = 1;
		}
	}
	else
	{
		struct proxy *proxy = find_proxy(peer_index(peer), *port, 1);

		result = -1;
		if (proxy)
		{
			*address = p2p.local_address;
			*port = proxy->local_port;
			if (socket >= 0)
				proxy->pinned_socket = socket;
			result = 1;
		}
	}
	pthread_mutex_unlock(&p2p_lock);
	return result;
}

int p2p_incoming(int stream, unsigned long *address, unsigned short *port)
{
	int result = 0;
	int index;

	if (!p2p.running || *address != p2p.local_address)
		return 0;
	pthread_mutex_lock(&p2p_lock);
	if (stream)
	{
		for (index = 0; index < MAXIMUM_LISTENERS && !result; index++)
		{
			struct listener *listener = &p2p.listeners[index];

			if (listener->socket >= 0 && listener->local_port == *port)
			{
				*address = p2p.peers[listener->peer].virtual_address;
				*port = listener->remote_port;
				result = 1;
			}
		}
		for (index = 0; index < MAXIMUM_STREAMS && !result; index++)
		{
			struct stream *entry = &p2p.streams[index];

			if (entry->used && entry->local_port && entry->local_port == *port)
			{
				*address = p2p.peers[entry->peer].virtual_address;
				*port = entry->remote_port;
				result = 1;
			}
		}
	}
	else
	{
		struct proxy const *proxy = find_proxy_by_port(*port);

		if (proxy)
		{
			*address = p2p.peers[proxy->peer].virtual_address;
			*port = proxy->remote_port;
			result = 1;
		}
	}
	if (!result)
		result = find_closed(stream, address, port);
	pthread_mutex_unlock(&p2p_lock);
	return result;
}

int p2p_broadcast_targets(unsigned short port, unsigned long *addresses, unsigned short *ports, int maximum_count)
{
	int count = 0;
	int index;

	if (!p2p.running)
		return 0;
	pthread_mutex_lock(&p2p_lock);
	for (index = 0; index < MAXIMUM_LINKS && count < maximum_count; index++)
	{
		struct proxy *proxy;

		if (!p2p.peers[index].used)
			continue;
		proxy = find_proxy(index, port, 1);
		if (proxy)
		{
			addresses[count] = p2p.local_address;
			ports[count++] = proxy->local_port;
		}
	}
	pthread_mutex_unlock(&p2p_lock);
	return count;
}

int p2p_send_datagram(unsigned short source_port, unsigned long address, unsigned short port, const void *data,
	int size)
{
	struct peer *peer;
	int result;

	if (!is_virtual_address(address) || !p2p.running)
		return 0;
	pthread_mutex_lock(&p2p_lock);
	peer = find_peer_by_address(address);
	if (!peer)
		result = address_retired(address) ? -1 : 0;
	else
	{
		datagram_send(peer, source_port, port, data, size);
		result = 1;
	}
	pthread_mutex_unlock(&p2p_lock);
	return result;
}

int p2p_broadcast_datagram(unsigned short source_port, unsigned short port, const void *data, int size)
{
	int count = 0;
	int index;

	if (!p2p.running)
		return 0;
	pthread_mutex_lock(&p2p_lock);
	for (index = 0; index < MAXIMUM_LINKS; index++)
	{
		if (p2p.peers[index].used)
		{
			datagram_send(&p2p.peers[index], source_port, port, data, size);
			count++;
		}
	}
	pthread_mutex_unlock(&p2p_lock);
	return count;
}

int p2p_peer_address(const unsigned char *identifier, unsigned long *address)
{
	struct peer *peer;
	int result = 0;

	if (!p2p.running)
		return 0;
	pthread_mutex_lock(&p2p_lock);
	peer = find_peer(identifier);
	if (peer)
	{
		*address = peer->virtual_address;
		result = 1;
	}
	pthread_mutex_unlock(&p2p_lock);
	return result;
}

/* a peer has no address of its own here (its link is the page's) */
unsigned long p2p_peer_endpoint_address(unsigned long virtual_address)
{
	(void)virtual_address;
	return 0;
}

/* ---------- p2p.h: the game's ports (as p2p.c's) */

void p2p_socket_port(int socket, int stream, int listening, unsigned short port)
{
	struct game_port *entry = NULL;
	int index;

	if (!p2p.running || !port)
		return;
	pthread_mutex_lock(&p2p_lock);
	for (index = 0; index < MAXIMUM_GAME_PORTS; index++)
	{
		struct game_port *known = &p2p.game_ports[index];

		if (known->port && known->socket == socket)
		{
			entry = known;
			break;
		}
		if (!known->port && !entry)
			entry = known;
	}
	if (entry)
	{
		entry->socket = socket;
		entry->port = port;
		entry->stream = (unsigned char)(stream != 0);
		entry->listening |= (unsigned char)(listening != 0);
	}
	if (stream && listening)
		p2p.hosting_socket = socket;
	forget_closed(stream != 0, port);
	pthread_mutex_unlock(&p2p_lock);
	/* (the thread tells the page) */
	if (stream && listening)
		web_p2p_wake();
}

void p2p_port_taken(int stream, unsigned short port)
{
	if (!p2p.running || !port)
		return;
	pthread_mutex_lock(&p2p_lock);
	forget_closed(stream != 0, port);
	pthread_mutex_unlock(&p2p_lock);
}

void p2p_socket_closed(int socket, unsigned short datagram_port)
{
	int was_hosting;
	int index;

	if (!p2p.running)
		return;
	pthread_mutex_lock(&p2p_lock);
	for (index = 0; index < MAXIMUM_SENT_PORTS && datagram_port; index++)
	{
		if (p2p.sent_ports[index] == datagram_port)
			p2p.sent_ports[index] = 0;
	}
	for (index = 0; index < MAXIMUM_GAME_PORTS; index++)
	{
		if (p2p.game_ports[index].port && p2p.game_ports[index].socket == socket)
			memset(&p2p.game_ports[index], 0, sizeof(p2p.game_ports[index]));
	}
	for (index = 0; index < MAXIMUM_PROXIES; index++)
	{
		if (p2p.proxies[index].socket >= 0 && p2p.proxies[index].pinned_socket == socket)
			p2p.proxies[index].pinned_socket = -1;
	}
	was_hosting = p2p.hosting_socket == socket;
	if (was_hosting)
		p2p.hosting_socket = -1;
	pthread_mutex_unlock(&p2p_lock);
	if (was_hosting)
		web_p2p_wake();
}

/* ---------- invites (the page takes them: app/src/net_bridge.js) */

int p2p_hand_off_invite(void)
{
	return 0;
}

/* a room's invite in text (as app/src/halo_net.js's parseInvite takes it:
<room>.<secret>, alone or in a link's #join=) */
static int has_room_invite(const char *text)
{
	static const char room_alphabet[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz";
	const char *at;

	for (at = text; *at; at++)
	{
		int length = 0;
		int secret = 0;

		while (at[length] && strchr(room_alphabet, at[length]))
			length++;
		if (length != 8 || at[8] != '.' || (at != text && strchr(room_alphabet, at[-1])))
			continue;
		while (at[9 + secret] && (isalnum((unsigned char)at[9 + secret]) || at[9 + secret] == '-' || at[9 + secret] == '_'))
			secret++;
		if (secret == 22)
			return 1;
	}
	return 0;
}

/* a browser's invite (the menus' Direct Link): the page joins its room,
whose host's game the menus then find */
int p2p_join_invite(const char *text)
{
	int asked;

	if (!text || !has_room_invite(text) || strlen(text) > 1024)
		return 0;
	pthread_mutex_lock(&p2p_lock);
	asked = out_record(0, _out_join, text, (int)strlen(text), NULL, 0);
	pthread_mutex_unlock(&p2p_lock);
	return asked;
}

/* ---------- the PC menus' internet games */

void p2p_set_hosting_allowed(int allowed)
{
	__atomic_store_n(&p2p.hosting_allowed, allowed != 0, __ATOMIC_RELEASE);
	web_p2p_wake();
}

/* the page's: where it writes the room's invite (an empty text: none) */
EMSCRIPTEN_KEEPALIVE char *web_p2p_room_invite(void)
{
	return room_invite;
}

int p2p_invite_link(char *link, int size)
{
	char invite[sizeof(room_invite)];

	memcpy(invite, (const char *)room_invite, sizeof(invite));
	invite[sizeof(invite) - 1] = 0;
	if (!invite[0] || p2p.hosting_socket < 0 || size <= 0)
	{
		if (size > 0)
			link[0] = 0;
		return 0;
	}
	snprintf(link, (size_t)size, "%s", invite);
	return 1;
}

/* a room is not listed in the server browser (desktop builds could not
join it): these keep nothing */
void p2p_set_hosting_public(int public)
{
	(void)public;
}

void p2p_set_hosting_password(const char *password)
{
	(void)password;
}

void p2p_set_game_listing(const char *name, const char *map, const char *gametype, int engine_type, int open,
	int in_progress, int has_teams)
{
	(void)name;
	(void)map;
	(void)gametype;
	(void)engine_type;
	(void)open;
	(void)in_progress;
	(void)has_teams;
}

void p2p_lobby_browse(int on)
{
	(void)on;
}

void p2p_lobby_refresh(void)
{
}

int p2p_lobby_games(struct p2p_listing *games, int maximum_count)
{
	(void)games;
	(void)maximum_count;
	return 0;
}

void p2p_lobby_mark_failed(const unsigned char *identifier)
{
	(void)identifier;
}

/* (web_p2p_select.c has the desktop's open it) */
int p2p_listing_unlock(struct p2p_listing *listing, const char *password)
{
	(void)password;
	return !listing->locked;
}

const char *p2p_take_clipboard_text(void)
{
	return NULL;
}

void p2p_set_game_player_counts(int count, int maximum)
{
	(void)count;
	(void)maximum;
}

/* ---------- what players are known by */

/* as p2p_discord.c's */
void p2p_discord_sanitize(char *destination, int size, const char *source, int name)
{
	int length = 0;

	for (; source && *source && length < size - 1; source++)
	{
		char character = *source;

		if ((character >= '0' && character <= '9') ||
			(name && ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
				character == '_' || character == '.' || character == '-')))
		{
			destination[length++] = character;
		}
	}
	destination[length] = 0;
}

void p2p_discord_identity(char *id, int id_size, char *name, int name_size)
{
	if (id_size > 0)
		id[0] = 0;
	if (name_size > 0)
		name[0] = 0;
}

/* none to tell (as p2p.c's on a machine without one) */
void p2p_hardware_id(char *hex_text, int size)
{
	if (size > 0)
		hex_text[0] = 0;
}

/* as p2p.c's */
void p2p_hardware_id_sanitize(char *destination, int size, const char *source)
{
	int length = 0;

	for (; source && *source && length < size - 1 && length < 2 * P2P_HARDWARE_ID_BYTES; source++)
	{
		char character = *source >= 'A' && *source <= 'F' ? *source - 'A' + 'a' : *source;

		if ((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))
			destination[length++] = character;
	}
	if (size > 0)
		destination[length] = 0;
}
