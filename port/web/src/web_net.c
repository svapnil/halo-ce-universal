/*
WEB_NET.C

The browser build's sockets: posix.h's posix_socket_* functions as sockets
in this page's memory, in place of posix_net.c's (tools/web_build.py
compiles posix_net.c with those renamed, and keeps its other functions). A
page has no sockets of the system's: Emscripten's stand in for some over
WebSockets, without UDP, broadcasts, listening or the loopback address,
all of which the game uses (a host joins its own game through 127.0.0.1).

This is one machine on a network of its own, at WEB_LOCAL_ADDRESS (which
posix_local_ipv4_address gives xnet.c for its XNADDR):

- datagrams to this machine (127.0.0.0/8, its address, 0.0.0.0) and
  broadcasts (255.255.255.255) go to its sockets bound to their port;
  datagrams anywhere else are lost, as a datagram may be;
- a connection to this machine is made at once by a socket listening on
  its port (or refused); one anywhere else is unreachable;
- what other machines send comes in through web_p2p.c's stand-ins, which are
  sockets here too (NETWORK.md, "The game's side"), as p2p.c's are the
  system's.

Each call answers as posix_net.c's does: Winsock's error codes, a connect
that fails is refused at once, select takes any socket of here, blocking
sockets block (the game runs on a worker, which may wait). One lock keeps
all of it; one condition wakes whatever waits on any change.

It is compiled with the host ABI, as posix_*.c are, and uses no header of
the system's for sockets: it keeps the address in Winsock's layout itself.
*/

#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "posix.h"

/* Winsock error codes (winsockx.h) */
#define WSAEBADF 10009
#define WSAEACCES 10013
#define WSAEFAULT 10014
#define WSAEINVAL 10022
#define WSAEMFILE 10024
#define WSAEWOULDBLOCK 10035
#define WSAENOTSOCK 10038
#define WSAEDESTADDRREQ 10039
#define WSAEMSGSIZE 10040
#define WSAENOPROTOOPT 10042
#define WSAEPROTONOSUPPORT 10043
#define WSAEOPNOTSUPP 10045
#define WSAEAFNOSUPPORT 10047
#define WSAEADDRINUSE 10048
#define WSAEADDRNOTAVAIL 10049
#define WSAENOBUFS 10055
#define WSAEISCONN 10056
#define WSAENOTCONN 10057
#define WSAESHUTDOWN 10058
#define WSAECONNREFUSED 10061
#define WSAEHOSTUNREACH 10065
#define WSAECONNRESET 10054

/* Winsock SOL_SOCKET options (winsockx.h) */
#define WINSOCK_SOL_SOCKET 0xffff
#define WINSOCK_SO_REUSEADDR 0x0004
#define WINSOCK_SO_BROADCAST 0x0020
#define WINSOCK_SO_SNDBUF 0x1001
#define WINSOCK_SO_RCVBUF 0x1002
#define WINSOCK_SO_ERROR 0x1007
#define WINSOCK_SO_TYPE 0x1008

/* the same in Winsock and Linux */
#define WEB_AF_INET 2
#define WEB_SOCK_STREAM 1
#define WEB_SOCK_DGRAM 2
#define WEB_MSG_PEEK 0x2
#define WEB_SD_RECEIVE 0
#define WEB_SD_SEND 1
#define WEB_SD_BOTH 2

/* this machine's address on its network: 10.0.0.1 (host byte order) */
#define WEB_LOCAL_ADDRESS 0x0A000001UL
#define WEB_LOOPBACK_ADDRESS 0x7F000001UL
#define WEB_BROADCAST_ADDRESS 0xFFFFFFFFUL

enum
{
	MAXIMUM_SOCKETS = 256,
	/* the game's sockets are small numbers nowhere else: these are not
	taken for a file's */
	FIRST_DESCRIPTOR = 0x4000,
	MAXIMUM_DATAGRAM_SIZE = 65507,
	/* what a socket holds unread: datagrams beyond these are lost, a stream's
	sender waits */
	MAXIMUM_QUEUED_DATAGRAMS = 256,
	MAXIMUM_QUEUED_DATAGRAM_BYTES = 256 * 1024,
	STREAM_BUFFER_SIZE = 64 * 1024,
	MAXIMUM_BACKLOG = 16,
	FIRST_EPHEMERAL_PORT = 49152,
	LAST_EPHEMERAL_PORT = 65535,
};

/* sockaddr_in as Winsock and Linux lay it out (posix.h): addresses and
ports in network byte order */
struct web_address
{
	unsigned short family;
	unsigned short port;
	unsigned int address;
	unsigned char zero[8];
};

struct datagram
{
	struct datagram *next;
	unsigned int from_address;
	unsigned short from_port;
	int size;
	unsigned char data[];
};

struct web_socket
{
	int used;
	int type;
	int nonblocking;
	int reuse_address;
	int broadcast;
	int send_buffer_size;
	int receive_buffer_size;

	/* host byte order */
	int bound;
	unsigned int local_address;
	unsigned short local_port;
	int connected;
	unsigned int remote_address;
	unsigned short remote_port;

	/* datagrams waiting, oldest first */
	struct datagram *first_datagram;
	struct datagram *last_datagram;
	int datagram_count;
	int datagram_bytes;

	/* a stream: the other end's socket (-1: none, or it closed), and what it
	sent that has not been read */
	int listening;
	int backlog;
	int pending[MAXIMUM_BACKLOG];
	int pending_count;
	int peer;
	unsigned char *buffer;
	int buffer_start;
	int buffer_count;
	/* the other end sends no more (it shut down or closed: after what it
	sent, a read gets 0), or it was reset (a read fails) */
	int peer_finished;
	int reset;
	int send_shut;
	int receive_shut;
};

static pthread_mutex_t net_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t net_changed = PTHREAD_COND_INITIALIZER;
static struct web_socket sockets[MAXIMUM_SOCKETS];
static unsigned short next_ephemeral_port = FIRST_EPHEMERAL_PORT;
static __thread int last_error;

static unsigned int swap32(unsigned int value)
{
	return __builtin_bswap32(value);
}

static unsigned short swap16(unsigned short value)
{
	return __builtin_bswap16(value);
}

static int fail(int error)
{
	last_error = error;
	return -1;
}

static int succeed(int result)
{
	last_error = 0;
	return result;
}

static int descriptor_of(int index)
{
	return FIRST_DESCRIPTOR + index;
}

/* the socket of a descriptor; NULL (with WSAENOTSOCK) if none is open.
Under net_lock */
static struct web_socket *socket_of(int descriptor)
{
	int index = descriptor - FIRST_DESCRIPTOR;

	if (index < 0 || index >= MAXIMUM_SOCKETS || !sockets[index].used)
	{
		last_error = WSAENOTSOCK;
		return NULL;
	}
	return &sockets[index];
}

static int index_of(const struct web_socket *socket)
{
	return (int)(socket - sockets);
}

/* this machine: the loopback network, its address, or any (as a
destination, any is this machine) */
static int is_this_machine(unsigned int address)
{
	return (address >> 24) == 0x7F || address == WEB_LOCAL_ADDRESS || address == 0;
}

/* the address a socket bound to any sends from to this destination */
static unsigned int source_address_for(unsigned int destination)
{
	return (destination >> 24) == 0x7F ? WEB_LOOPBACK_ADDRESS : WEB_LOCAL_ADDRESS;
}

/* an address the caller passed: 0 if it is not an IPv4 one */
static int read_address(const void *address, int address_length, unsigned int *ip, unsigned short *port)
{
	struct web_address in;

	if (!address || address_length < (int)sizeof(in))
	{
		fail(WSAEFAULT);
		return 0;
	}
	memcpy(&in, address, sizeof(in));
	if (in.family != WEB_AF_INET)
	{
		fail(WSAEAFNOSUPPORT);
		return 0;
	}
	*ip = swap32(in.address);
	*port = swap16(in.port);
	return 1;
}

static void write_address(void *address, int *address_length, unsigned int ip, unsigned short port)
{
	struct web_address out;
	int size;

	if (!address || !address_length)
		return;
	memset(&out, 0, sizeof(out));
	out.family = WEB_AF_INET;
	out.address = swap32(ip);
	out.port = swap16(port);
	size = *address_length < (int)sizeof(out) ? *address_length : (int)sizeof(out);
	if (size > 0)
		memcpy(address, &out, (size_t)size);
	*address_length = (int)sizeof(out);
}

/* whether a socket of this type has the port, other than except */
static int port_taken(int type, unsigned short port, const struct web_socket *except, int *all_reuse)
{
	int index;
	int taken = 0;

	*all_reuse = 1;
	for (index = 0; index < MAXIMUM_SOCKETS; index++)
	{
		const struct web_socket *other = &sockets[index];

		if (other->used && other != except && other->type == type && other->bound && other->local_port == port)
		{
			taken = 1;
			if (!other->reuse_address)
				*all_reuse = 0;
		}
	}
	return taken;
}

/* binds the socket to address and a port of the system's choosing */
static int bind_ephemeral(struct web_socket *socket, unsigned int address)
{
	int attempt;

	for (attempt = 0; attempt <= LAST_EPHEMERAL_PORT - FIRST_EPHEMERAL_PORT; attempt++)
	{
		unsigned short port = next_ephemeral_port;
		int all_reuse;

		next_ephemeral_port = port == LAST_EPHEMERAL_PORT ? FIRST_EPHEMERAL_PORT : (unsigned short)(port + 1);
		if (!port_taken(socket->type, port, socket, &all_reuse))
		{
			socket->bound = 1;
			socket->local_address = address;
			socket->local_port = port;
			return 1;
		}
	}
	fail(WSAEADDRINUSE);
	return 0;
}

/* whether a socket bound so receives what is sent to address */
static int receives_at(const struct web_socket *socket, unsigned int address)
{
	if (socket->local_address == 0)
		return 1;
	if ((socket->local_address >> 24) == 0x7F && (address >> 24) == 0x7F)
		return 1;
	return socket->local_address == address || (address == 0 && socket->local_address == WEB_LOCAL_ADDRESS);
}

static void free_datagrams(struct web_socket *socket)
{
	while (socket->first_datagram)
	{
		struct datagram *next = socket->first_datagram->next;

		free(socket->first_datagram);
		socket->first_datagram = next;
	}
	socket->last_datagram = NULL;
	socket->datagram_count = 0;
	socket->datagram_bytes = 0;
}

/* queues a copy of a datagram on the socket, or loses it (full, or the
socket is connected to someone else) */
static void deliver_datagram(struct web_socket *socket, unsigned int from_address, unsigned short from_port,
	const void *data, int size)
{
	struct datagram *datagram;

	if (socket->receive_shut ||
		(socket->connected && (socket->remote_address != from_address || socket->remote_port != from_port)) ||
		socket->datagram_count >= MAXIMUM_QUEUED_DATAGRAMS ||
		socket->datagram_bytes + size > MAXIMUM_QUEUED_DATAGRAM_BYTES)
	{
		return;
	}
	datagram = malloc(sizeof(*datagram) + (size_t)size);
	if (!datagram)
		return;
	datagram->next = NULL;
	datagram->from_address = from_address;
	datagram->from_port = from_port;
	datagram->size = size;
	memcpy(datagram->data, data, (size_t)size);
	if (socket->last_datagram)
		socket->last_datagram->next = datagram;
	else
		socket->first_datagram = datagram;
	socket->last_datagram = datagram;
	socket->datagram_count++;
	socket->datagram_bytes += size;
}

/* a stream's end goes: the other end reads what is left, then the end
(reset: fails instead) */
static void detach_peer(struct web_socket *socket, int reset)
{
	if (socket->peer >= 0)
	{
		struct web_socket *peer = &sockets[socket->peer];

		peer->peer = -1;
		peer->peer_finished = 1;
		if (reset)
			peer->reset = 1;
		socket->peer = -1;
	}
}

static void release(struct web_socket *socket)
{
	free_datagrams(socket);
	free(socket->buffer);
	memset(socket, 0, sizeof(*socket));
}

/* ---------- posix.h */

int posix_socket_last_error(void)
{
	return last_error;
}

int posix_socket(int family, int type, int protocol)
{
	int index;
	int result = -1;

	(void)protocol;
	if (family != WEB_AF_INET)
		return fail(WSAEAFNOSUPPORT);
	if (type != WEB_SOCK_STREAM && type != WEB_SOCK_DGRAM)
		return fail(WSAEPROTONOSUPPORT);
	pthread_mutex_lock(&net_lock);
	for (index = 0; index < MAXIMUM_SOCKETS; index++)
	{
		if (!sockets[index].used)
		{
			memset(&sockets[index], 0, sizeof(sockets[index]));
			sockets[index].used = 1;
			sockets[index].type = type;
			sockets[index].peer = -1;
			sockets[index].send_buffer_size = STREAM_BUFFER_SIZE;
			sockets[index].receive_buffer_size = STREAM_BUFFER_SIZE;
			result = descriptor_of(index);
			break;
		}
	}
	pthread_mutex_unlock(&net_lock);
	return result < 0 ? fail(WSAEMFILE) : succeed(result);
}

int posix_socket_close(int descriptor)
{
	struct web_socket *socket;
	int index;

	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&net_lock);
		return -1;
	}
	/* connections not accepted yet are refused after all */
	for (index = 0; index < socket->pending_count; index++)
	{
		struct web_socket *pending = &sockets[socket->pending[index]];

		detach_peer(pending, 1);
		release(pending);
	}
	detach_peer(socket, 0);
	release(socket);
	pthread_cond_broadcast(&net_changed);
	pthread_mutex_unlock(&net_lock);
	return succeed(0);
}

int posix_socket_bind(int descriptor, const void *address, int address_length)
{
	struct web_socket *socket;
	unsigned int ip;
	unsigned short port;
	int all_reuse;
	int error = 0;

	if (!read_address(address, address_length, &ip, &port))
		return -1;
	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (!socket)
		error = WSAENOTSOCK;
	else if (socket->bound)
		error = WSAEINVAL;
	else if (ip != 0 && !is_this_machine(ip))
		error = WSAEADDRNOTAVAIL;
	else if (port == 0)
		error = bind_ephemeral(socket, ip) ? 0 : WSAEADDRINUSE;
	else if (port_taken(socket->type, port, socket, &all_reuse) && !(all_reuse && socket->reuse_address))
		error = WSAEADDRINUSE;
	else
	{
		socket->bound = 1;
		socket->local_address = ip;
		socket->local_port = port;
	}
	pthread_mutex_unlock(&net_lock);
	return error ? fail(error) : succeed(0);
}

/* the socket listening on port at address, or NULL; under net_lock */
static struct web_socket *find_listener(unsigned int address, unsigned short port)
{
	int index;

	for (index = 0; index < MAXIMUM_SOCKETS; index++)
	{
		struct web_socket *socket = &sockets[index];

		if (socket->used && socket->type == WEB_SOCK_STREAM && socket->listening && socket->local_port == port &&
			receives_at(socket, address))
		{
			return socket;
		}
	}
	return NULL;
}

/* a new connection to listener from socket: the end the listener accepts,
which takes what socket sends until then */
static int connect_stream(struct web_socket *socket, struct web_socket *listener, unsigned int address,
	unsigned short port)
{
	int index;
	struct web_socket *accepted = NULL;

	if (listener->pending_count >= listener->backlog)
		return WSAECONNREFUSED;
	for (index = 0; index < MAXIMUM_SOCKETS; index++)
	{
		if (!sockets[index].used)
		{
			accepted = &sockets[index];
			break;
		}
	}
	if (!accepted)
		return WSAENOBUFS;
	socket->buffer = malloc(STREAM_BUFFER_SIZE);
	memset(accepted, 0, sizeof(*accepted));
	accepted->buffer = malloc(STREAM_BUFFER_SIZE);
	if (!socket->buffer || !accepted->buffer)
	{
		free(socket->buffer);
		free(accepted->buffer);
		socket->buffer = NULL;
		accepted->buffer = NULL;
		return WSAENOBUFS;
	}
	accepted->used = 1;
	accepted->type = WEB_SOCK_STREAM;
	accepted->send_buffer_size = STREAM_BUFFER_SIZE;
	accepted->receive_buffer_size = STREAM_BUFFER_SIZE;
	accepted->bound = 1;
	accepted->local_address = address == 0 ? WEB_LOCAL_ADDRESS : address;
	accepted->local_port = port;
	accepted->connected = 1;
	accepted->remote_address = socket->local_address;
	accepted->remote_port = socket->local_port;
	accepted->peer = index_of(socket);
	socket->connected = 1;
	socket->remote_address = accepted->local_address;
	socket->remote_port = port;
	socket->peer = index;
	listener->pending[listener->pending_count++] = index;
	return 0;
}

int posix_socket_connect(int descriptor, const void *address, int address_length)
{
	struct web_socket *socket;
	unsigned int ip;
	unsigned short port;
	int error = 0;

	if (!read_address(address, address_length, &ip, &port))
		return -1;
	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (!socket)
		error = WSAENOTSOCK;
	else if (socket->type == WEB_SOCK_DGRAM)
	{
		/* a datagram socket's: where its sends go and what it takes */
		if (!socket->bound && !bind_ephemeral(socket, 0))
			error = WSAEADDRINUSE;
		else
		{
			socket->connected = 1;
			socket->remote_address = ip == 0 ? WEB_LOCAL_ADDRESS : ip;
			socket->remote_port = port;
		}
	}
	else if (socket->connected || socket->listening)
		error = WSAEISCONN;
	else if (!is_this_machine(ip))
		error = WSAEHOSTUNREACH;
	else
	{
		struct web_socket *listener = find_listener(ip, port);

		if (!listener)
			error = WSAECONNREFUSED;
		else if (!socket->bound && !bind_ephemeral(socket, source_address_for(ip)))
			error = WSAEADDRINUSE;
		else
		{
			if (socket->local_address == 0)
				socket->local_address = source_address_for(ip);
			error = connect_stream(socket, listener, ip, port);
			if (!error)
				pthread_cond_broadcast(&net_changed);
		}
	}
	pthread_mutex_unlock(&net_lock);
	return error ? fail(error) : succeed(0);
}

int posix_socket_listen(int descriptor, int backlog)
{
	struct web_socket *socket;
	int error = 0;

	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (!socket)
		error = WSAENOTSOCK;
	else if (socket->type != WEB_SOCK_STREAM)
		error = WSAEOPNOTSUPP;
	else if (socket->connected)
		error = WSAEISCONN;
	else if (!socket->bound && !bind_ephemeral(socket, 0))
		error = WSAEADDRINUSE;
	else
	{
		socket->listening = 1;
		socket->backlog = backlog < 1 ? 1 : backlog > MAXIMUM_BACKLOG ? MAXIMUM_BACKLOG : backlog;
	}
	pthread_mutex_unlock(&net_lock);
	return error ? fail(error) : succeed(0);
}

/* waits for a change, until the deadline if there is one; 0 if it passed.
Under net_lock */
static int wait_for_change(const struct timespec *deadline)
{
	if (!deadline)
	{
		pthread_cond_wait(&net_changed, &net_lock);
		return 1;
	}
	return pthread_cond_timedwait(&net_changed, &net_lock, deadline) == 0;
}

int posix_socket_accept(int descriptor, void *address, int *address_length)
{
	struct web_socket *socket;
	int result = -1;
	int error = 0;

	pthread_mutex_lock(&net_lock);
	for (;;)
	{
		socket = socket_of(descriptor);
		if (!socket)
		{
			error = WSAENOTSOCK;
			break;
		}
		if (!socket->listening)
		{
			error = WSAEINVAL;
			break;
		}
		if (socket->pending_count > 0)
		{
			int index = socket->pending[0];

			socket->pending_count--;
			memmove(socket->pending, socket->pending + 1, sizeof(*socket->pending) * (size_t)socket->pending_count);
			write_address(address, address_length, sockets[index].remote_address, sockets[index].remote_port);
			result = descriptor_of(index);
			break;
		}
		if (socket->nonblocking)
		{
			error = WSAEWOULDBLOCK;
			break;
		}
		wait_for_change(NULL);
	}
	pthread_mutex_unlock(&net_lock);
	return error ? fail(error) : succeed(result);
}

/* room in a stream's other end for what it sends */
static int stream_room(const struct web_socket *socket)
{
	return socket->peer >= 0 ? STREAM_BUFFER_SIZE - sockets[socket->peer].buffer_count : 0;
}

static int send_stream(int descriptor, const unsigned char *data, int length)
{
	struct web_socket *socket;
	int sent = -1;
	int error = 0;

	pthread_mutex_lock(&net_lock);
	for (;;)
	{
		struct web_socket *peer;
		int room;
		int index;

		socket = socket_of(descriptor);
		if (!socket)
		{
			error = WSAENOTSOCK;
			break;
		}
		if (socket->send_shut)
		{
			error = WSAESHUTDOWN;
			break;
		}
		if (!socket->connected)
		{
			error = WSAENOTCONN;
			break;
		}
		if (socket->reset || socket->peer < 0)
		{
			error = WSAECONNRESET;
			break;
		}
		peer = &sockets[socket->peer];
		if (peer->receive_shut)
		{
			/* (what the other end will not read goes nowhere) */
			sent = length;
			break;
		}
		room = stream_room(socket);
		if (room == 0 && length > 0)
		{
			if (socket->nonblocking)
			{
				error = WSAEWOULDBLOCK;
				break;
			}
			wait_for_change(NULL);
			continue;
		}
		sent = length < room ? length : room;
		for (index = 0; index < sent; index++)
			peer->buffer[(peer->buffer_start + peer->buffer_count + index) % STREAM_BUFFER_SIZE] = data[index];
		peer->buffer_count += sent;
		pthread_cond_broadcast(&net_changed);
		break;
	}
	pthread_mutex_unlock(&net_lock);
	return error ? fail(error) : succeed(sent);
}

/* sends a datagram from socket to this machine's sockets on the port
(or every one's, a broadcast); lost if none takes it. Under net_lock */
static void send_datagram(struct web_socket *socket, unsigned int address, unsigned short port,
	const void *data, int length)
{
	int broadcast = address == WEB_BROADCAST_ADDRESS;
	unsigned int from = socket->local_address ? socket->local_address :
		source_address_for(broadcast ? WEB_LOCAL_ADDRESS : address);
	int index;

	if (!broadcast && !is_this_machine(address))
		return;
	for (index = 0; index < MAXIMUM_SOCKETS; index++)
	{
		struct web_socket *other = &sockets[index];

		if (!other->used || other->type != WEB_SOCK_DGRAM || !other->bound || other->local_port != port)
			continue;
		/* (a broadcast reaches only the sockets bound to any address) */
		if (broadcast ? other->local_address != 0 : !receives_at(other, address))
			continue;
		deliver_datagram(other, from, socket->local_port, data, length);
		/* a datagram to one address goes to one socket (sockets sharing a
		port: the first); a broadcast to each */
		if (!broadcast)
			break;
	}
	pthread_cond_broadcast(&net_changed);
}

int posix_socket_send(int descriptor, const void *buffer, int length, int flags)
{
	struct web_socket *socket;
	unsigned int address;
	unsigned short port;

	(void)flags;
	if (length < 0)
		return fail(WSAEINVAL);
	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&net_lock);
		return -1;
	}
	if (socket->type == WEB_SOCK_STREAM)
	{
		pthread_mutex_unlock(&net_lock);
		return send_stream(descriptor, buffer, length);
	}
	if (!socket->connected)
	{
		pthread_mutex_unlock(&net_lock);
		return fail(WSAENOTCONN);
	}
	if (length > MAXIMUM_DATAGRAM_SIZE)
	{
		pthread_mutex_unlock(&net_lock);
		return fail(WSAEMSGSIZE);
	}
	address = socket->remote_address;
	port = socket->remote_port;
	send_datagram(socket, address, port, buffer, length);
	pthread_mutex_unlock(&net_lock);
	return succeed(length);
}

int posix_socket_sendto(int descriptor, const void *buffer, int length, int flags,
	const void *address, int address_length)
{
	struct web_socket *socket;
	unsigned int ip;
	unsigned short port;
	int error = 0;

	if (!address)
		return posix_socket_send(descriptor, buffer, length, flags);
	if (!read_address(address, address_length, &ip, &port))
		return -1;
	if (length < 0)
		return fail(WSAEINVAL);
	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (!socket)
		error = WSAENOTSOCK;
	else if (socket->type == WEB_SOCK_STREAM)
		error = socket->connected ? WSAEISCONN : WSAENOTCONN;
	else if (length > MAXIMUM_DATAGRAM_SIZE)
		error = WSAEMSGSIZE;
	else if (port == 0)
		error = WSAEADDRNOTAVAIL;
	else if (!socket->bound && !bind_ephemeral(socket, 0))
		error = WSAEADDRINUSE;
	else
		send_datagram(socket, ip, port, buffer, length);
	pthread_mutex_unlock(&net_lock);
	return error ? fail(error) : succeed(length);
}

/* reads a stream's bytes, or its end */
static int receive_stream(struct web_socket *socket, unsigned char *data, int length, int flags, int *error)
{
	int count;
	int index;

	if (socket->receive_shut)
		return 0;
	if (socket->buffer_count == 0)
	{
		if (socket->reset)
		{
			*error = WSAECONNRESET;
			return -1;
		}
		if (socket->peer_finished)
			return 0;
		if (!socket->connected)
		{
			*error = WSAENOTCONN;
			return -1;
		}
		*error = WSAEWOULDBLOCK;
		return -1;
	}
	count = length < socket->buffer_count ? length : socket->buffer_count;
	for (index = 0; index < count; index++)
		data[index] = socket->buffer[(socket->buffer_start + index) % STREAM_BUFFER_SIZE];
	if (!(flags & WEB_MSG_PEEK))
	{
		socket->buffer_start = (socket->buffer_start + count) % STREAM_BUFFER_SIZE;
		socket->buffer_count -= count;
		/* (room for a sender waiting) */
		pthread_cond_broadcast(&net_changed);
	}
	return count;
}

/* takes a datagram: its start, with WSAEMSGSIZE, if it is larger than the
buffer (as Winsock does) */
static int receive_datagram(struct web_socket *socket, unsigned char *data, int length, int flags,
	void *address, int *address_length, int *error)
{
	struct datagram *datagram = socket->first_datagram;
	int size;

	if (!datagram)
	{
		*error = WSAEWOULDBLOCK;
		return -1;
	}
	size = datagram->size < length ? datagram->size : length;
	memcpy(data, datagram->data, (size_t)size);
	write_address(address, address_length, datagram->from_address, datagram->from_port);
	if (!(flags & WEB_MSG_PEEK))
	{
		socket->first_datagram = datagram->next;
		if (!socket->first_datagram)
			socket->last_datagram = NULL;
		socket->datagram_count--;
		socket->datagram_bytes -= datagram->size;
		if (datagram->size > length)
		{
			free(datagram);
			*error = WSAEMSGSIZE;
			return -1;
		}
		free(datagram);
	}
	else if (datagram->size > length)
	{
		*error = WSAEMSGSIZE;
		return -1;
	}
	return size;
}

int posix_socket_recvfrom(int descriptor, void *buffer, int length, int flags,
	void *address, int *address_length)
{
	struct web_socket *socket;
	int result = -1;
	int error = 0;

	if (length < 0)
		return fail(WSAEINVAL);
	pthread_mutex_lock(&net_lock);
	for (;;)
	{
		socket = socket_of(descriptor);
		if (!socket)
		{
			error = WSAENOTSOCK;
			break;
		}
		error = 0;
		if (socket->type == WEB_SOCK_STREAM)
		{
			result = receive_stream(socket, buffer, length, flags, &error);
			if (result >= 0)
				write_address(address, address_length, socket->remote_address, socket->remote_port);
		}
		else if (!socket->bound)
		{
			/* (Winsock: a datagram socket not bound has nothing to read) */
			error = WSAEINVAL;
		}
		else
		{
			result = receive_datagram(socket, buffer, length, flags, address, address_length, &error);
		}
		if (error != WSAEWOULDBLOCK || socket->nonblocking)
			break;
		wait_for_change(NULL);
	}
	pthread_mutex_unlock(&net_lock);
	return error ? fail(error) : succeed(result);
}

int posix_socket_recv(int descriptor, void *buffer, int length, int flags)
{
	return posix_socket_recvfrom(descriptor, buffer, length, flags, NULL, NULL);
}

int posix_socket_shutdown(int descriptor, int how)
{
	struct web_socket *socket;
	int error = 0;

	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (!socket)
		error = WSAENOTSOCK;
	else if (socket->type == WEB_SOCK_STREAM && !socket->connected)
		error = WSAENOTCONN;
	else if (how != WEB_SD_RECEIVE && how != WEB_SD_SEND && how != WEB_SD_BOTH)
		error = WSAEINVAL;
	else
	{
		if (how != WEB_SD_RECEIVE && !socket->send_shut)
		{
			socket->send_shut = 1;
			if (socket->peer >= 0)
				sockets[socket->peer].peer_finished = 1;
		}
		if (how != WEB_SD_SEND)
			socket->receive_shut = 1;
		pthread_cond_broadcast(&net_changed);
	}
	pthread_mutex_unlock(&net_lock);
	return error ? fail(error) : succeed(0);
}

int posix_socket_set_nonblocking(int descriptor, int nonblocking)
{
	struct web_socket *socket;

	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (socket)
		socket->nonblocking = nonblocking != 0;
	pthread_mutex_unlock(&net_lock);
	return socket ? succeed(0) : -1;
}

int posix_socket_set_nodelay(int descriptor)
{
	/* (every write is at the other end at once) */
	struct web_socket *socket;

	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	pthread_mutex_unlock(&net_lock);
	return socket ? succeed(0) : -1;
}

int posix_socket_bytes_available(int descriptor, posix_ulong *count)
{
	struct web_socket *socket;

	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (socket)
	{
		/* a stream's bytes; a datagram socket's next datagram */
		if (socket->type == WEB_SOCK_STREAM)
			*count = (posix_ulong)socket->buffer_count;
		else
			*count = socket->first_datagram ? (posix_ulong)socket->first_datagram->size : 0;
	}
	pthread_mutex_unlock(&net_lock);
	return socket ? succeed(0) : -1;
}

/* a SOL_SOCKET option's value in the socket, or NULL for one it does not
keep (accepted and ignored, as posix_net.c ignores Xbox-only ones) */
static int *option_of(struct web_socket *socket, int name)
{
	switch (name)
	{
	case WINSOCK_SO_REUSEADDR: return &socket->reuse_address;
	case WINSOCK_SO_BROADCAST: return &socket->broadcast;
	case WINSOCK_SO_SNDBUF: return &socket->send_buffer_size;
	case WINSOCK_SO_RCVBUF: return &socket->receive_buffer_size;
	default: return NULL;
	}
}

int posix_socket_setsockopt(int descriptor, int level, int name, const void *value, int length)
{
	struct web_socket *socket;
	int *option;
	int error = 0;

	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (!socket)
		error = WSAENOTSOCK;
	else if (level == WINSOCK_SOL_SOCKET && (option = option_of(socket, name)) != NULL)
	{
		if (!value || length < (int)sizeof(char))
			error = WSAEFAULT;
		else if (length >= (int)sizeof(int))
			memcpy(option, value, sizeof(int));
		else
			*option = *(const unsigned char *)value;
	}
	pthread_mutex_unlock(&net_lock);
	return error ? fail(error) : succeed(0);
}

int posix_socket_getsockopt(int descriptor, int level, int name, void *value, int *length)
{
	struct web_socket *socket;
	int result = 0;
	int error = 0;

	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (!socket)
		error = WSAENOTSOCK;
	else if (level != WINSOCK_SOL_SOCKET)
		error = WSAENOPROTOOPT;
	else if (name == WINSOCK_SO_TYPE)
		result = socket->type;
	else if (name == WINSOCK_SO_ERROR)
		result = 0;
	else if (option_of(socket, name))
		result = *option_of(socket, name);
	else
		error = WSAENOPROTOOPT;
	pthread_mutex_unlock(&net_lock);
	if (error)
		return fail(error);
	if (!value || !length || *length < (int)sizeof(int))
		return fail(WSAEFAULT);
	memcpy(value, &result, sizeof(result));
	*length = (int)sizeof(result);
	return succeed(0);
}

int posix_socket_getsockname(int descriptor, void *address, int *address_length)
{
	struct web_socket *socket;
	unsigned int ip = 0;
	unsigned short port = 0;

	if (!address || !address_length)
		return fail(WSAEFAULT);
	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (socket && socket->bound)
	{
		ip = socket->local_address;
		port = socket->local_port;
	}
	pthread_mutex_unlock(&net_lock);
	if (!socket)
		return -1;
	/* (one not bound yet: 0.0.0.0, port 0, as Linux gives) */
	write_address(address, address_length, ip, port);
	return succeed(0);
}

int posix_socket_getpeername(int descriptor, void *address, int *address_length)
{
	struct web_socket *socket;
	int connected = 0;
	unsigned int ip = 0;
	unsigned short port = 0;

	if (!address || !address_length)
		return fail(WSAEFAULT);
	pthread_mutex_lock(&net_lock);
	socket = socket_of(descriptor);
	if (socket && socket->connected)
	{
		connected = 1;
		ip = socket->remote_address;
		port = socket->remote_port;
	}
	pthread_mutex_unlock(&net_lock);
	if (!socket)
		return -1;
	if (!connected)
		return fail(WSAENOTCONN);
	write_address(address, address_length, ip, port);
	return succeed(0);
}

/* whether a socket is ready for select's list (0 read, 1 write, 2 error):
read for data, a connection to accept, or a stream's end; write for room;
error never (no urgent data, and a connect fails at once). Under net_lock */
static int is_ready(const struct web_socket *socket, int list)
{
	switch (list)
	{
	case 0:
		if (socket->type == WEB_SOCK_DGRAM)
			return socket->first_datagram != NULL;
		if (socket->listening)
			return socket->pending_count > 0;
		return socket->connected && (socket->buffer_count > 0 || socket->peer_finished || socket->reset);
	case 1:
		if (socket->type == WEB_SOCK_DGRAM)
			return 1;
		return socket->connected && !socket->reset && !socket->send_shut && stream_room(socket) > 0;
	default:
		return 0;
	}
}

int posix_socket_select(int *read, int *read_count, int *write, int *write_count,
	int *error, int *error_count, posix_long timeout_seconds, posix_long timeout_microseconds, int infinite)
{
	int *lists[3] = { read, write, error };
	int *counts[3] = { read_count, write_count, error_count };
	struct timespec deadline;
	int list, index;
	int result = 0;

	if (!infinite)
	{
		long long microseconds = (long long)timeout_seconds * 1000000 + timeout_microseconds;

		if (microseconds < 0)
			microseconds = 0;
		clock_gettime(CLOCK_REALTIME, &deadline);
		deadline.tv_sec += (time_t)(microseconds / 1000000);
		deadline.tv_nsec += (long)(microseconds % 1000000) * 1000;
		if (deadline.tv_nsec >= 1000000000)
		{
			deadline.tv_sec++;
			deadline.tv_nsec -= 1000000000;
		}
	}
	for (list = 0; list < 3; list++)
	{
		if (!lists[list] || !counts[list])
			lists[list] = NULL;
	}

	pthread_mutex_lock(&net_lock);
	for (;;)
	{
		/* (as select fails on a descriptor that is not open) */
		for (list = 0; list < 3; list++)
		{
			for (index = 0; lists[list] && index < *counts[list]; index++)
			{
				if (!socket_of(lists[list][index]))
				{
					pthread_mutex_unlock(&net_lock);
					return fail(WSAENOTSOCK);
				}
			}
		}
		for (list = 0; list < 3 && !result; list++)
		{
			for (index = 0; lists[list] && index < *counts[list]; index++)
			{
				if (is_ready(socket_of(lists[list][index]), list))
				{
					result = 1;
					break;
				}
			}
		}
		if (result || !wait_for_change(infinite ? NULL : &deadline))
			break;
	}
	/* each list keeps its ready ones, in the order given */
	result = 0;
	for (list = 0; list < 3; list++)
	{
		int kept = 0;

		for (index = 0; lists[list] && index < *counts[list]; index++)
		{
			if (is_ready(socket_of(lists[list][index]), list))
				lists[list][kept++] = lists[list][index];
		}
		if (lists[list])
			*counts[list] = kept;
		result += kept;
	}
	pthread_mutex_unlock(&net_lock);
	/* like Winsock, a select with nothing ready leaves the last error as it
	was */
	if (result > 0)
		last_error = 0;
	return result;
}

posix_ulong posix_local_ipv4_address(void)
{
	return (posix_ulong)swap32(WEB_LOCAL_ADDRESS);
}
