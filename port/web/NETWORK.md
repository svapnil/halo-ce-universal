# Network play in the browser

The plan for system link games between browsers. A browser cannot use the
desktop's internet play (`port/linux/src/p2p.c`): it has no UDP or TCP
sockets, so no MQTT brokers, STUN or hole punching. Browsers reach each other
through WebRTC data channels, relayed by Cloudflare Realtime SFU, and find
each other through the site's Worker.

Status:

- Done: the in-memory sockets (`src/web_net.c`), internet play over links
  (`src/web_p2p.c`), the bridge to the page (`app/src/net_bridge.js`), the
  signalling server (`worker/rooms.js`, `app/src/halo_net.js`), and two
  transports: through the SFU (`app/src/sfu_transport.js`, the default),
  and between the pages of one browser (`app/src/tab_transport.js`,
  `?net=tabs`), and the lobby (`src/web_lobby.c`, `app/src/lobby.js`):
  the page's own Multiplayer menu hosts a game that starts at once, and a
  page opened with its invite joins it, in progress, with no menus. Refer
  to "The lobby" and "Testing".
- Not yet deployed (the secrets are: `wrangler secret put`).
- To do: a server browser (rooms that list themselves); browsers with the
  desktop builds.

## Parts

```
 joiner's page                     Worker                       host's page
 ┌──────────────┐  WebSocket   ┌──────────────────┐  WebSocket  ┌──────────────┐
 │ halo_net.js  │──signalling──│ GameRoom (one    │─signalling──│ halo_net.js  │
 │              │   (JSON)     │ Durable Object   │   (JSON)    │              │
 │              │              │ per game)        │             │              │
 │              │              └────────┬─────────┘             │              │
 │              │                       │ HTTPS, app token      │              │
 │              │              ┌────────┴─────────┐             │              │
 │ RTCPeer-     │═════════════ │ Realtime SFU     │════════════ │ RTCPeer-     │
 │ Connection   │ data channels│                  │data channels│ Connection   │
 └──────────────┘              └──────────────────┘             └──────────────┘
```

- **Signalling** (WebSocket, JSON) sets links up and tears them down. Game
  traffic never goes through it: a game goes on if the WebSocket drops.
- **The SFU** carries the game's traffic. Each page has one
  `RTCPeerConnection`, to the SFU, however many peers it has. The SFU's app
  token stays in the Worker (`REALTIME_APP_ID`, `REALTIME_APP_TOKEN`).
- **Star.** As on the desktop, joiners reach only the host, and the host
  makes the game's decisions. A link is a joiner and the host.

## Rooms and invites

A room is one hosted game, at `wss://<site>/net/rooms/<room>`:

- `room`: 8 characters of Crockford's base 32, made by the Worker. It names
  the game and is not secret, so that a server browser can list it later.
- `secret`: 16 random bytes, base64url. Only the invite carries it. A join
  without it is refused.
- The invite is `https://<site>/#join=<room>.<secret>`. The secret is in the
  fragment, which the browser does not send to the server and does not log.

A room ends when its host's WebSocket closes. Links already made keep
working (they are the SFU's), but no one else can join.

Limits: 15 joiners (16 machines); an address makes at most 5 rooms and 20
joins a minute (each is SFU sessions on the account's bill). A joiner that has not answered the SFU's
offer 30 seconds after joining is closed. A WebSocket from a page of another
site is refused.

## Signalling messages

Each message is a JSON object with a `type`. `version` is this protocol's
version, now 1. `id` is the machine's 6-byte identifier, as 12 lowercase hex
digits: the one its XNADDR carries (`p2p_identifier()`), from which every
machine derives the peer's virtual address in 100.64.0.0/10 as on the
desktop. `netVersion` is `HALO_PORT_NETWORK_VERSION`.

The page sends the text `ping` every 30 seconds; the server answers `pong`
without waking the room.

### Page to server

| `type` | Fields | When |
| --- | --- | --- |
| `host` | `version`, `id`, `netVersion` | First message, on `/net/rooms/new`. |
| `join` | `version`, `id`, `netVersion`, `secret` | First message, on `/net/rooms/<room>`. |
| `answer` | `sdp` | The page's answer to `offer`. |
| `drop` | `peer` | Host only: end that joiner's link (a kick or ban in the game). |

### Server to page

| `type` | Fields | Meaning |
| --- | --- | --- |
| `welcome` | `room`, `peer`; to the host also `secret` | Accepted. `peer` is this page's number in the room: the host is 0, joiners 1 to 15. The host's page makes the invite from its own address, `room` and `secret`. |
| `offer` | `sdp` | The SFU's offer for this page's connection. Answer with `answer`. |
| `link` | `peer`, `id`, `netVersion`, `reliable`, `unreliable` | A link to `peer` is made. Create the two data channels with these SCTP ids (refer to "Data channels"). The host gets one for each joiner; a joiner gets one, to the host. |
| `unlink` | `peer`, `reason` | The link to `peer` ended: `left`, `dropped` or `failed`. Close its channels. |
| `error` | `code`, `message` | Refused or failed; the server then closes the WebSocket. |

`error` codes: `busy` (this address made too many rooms or joins in the
last minute: 5 and 20, `wrangler.toml`), `protocol` (a message out of order or malformed), `version`
(another `version` than the server's, or another `netVersion` than the
host's), `not-found` (no such room), `secret`, `full`, `duplicate` (the `id`
is already in the room), `not-ready` (the host has not connected to the SFU
yet: try again), `timeout`, `sfu` (the SFU refused or did not answer),
`closed` (the host left).

### Sequences

Hosting:

```
page                                  server                       SFU
 │── host {id, netVersion} ──────────▶│── sessions/new ───────────▶│
 │                                    │── datachannels/establish ─▶│
 │◀── welcome {room, peer: 0, ...} ───│◀── offer ──────────────────│
 │◀── offer {sdp} ────────────────────│                            │
 │── answer {sdp} ───────────────────▶│── renegotiate ────────────▶│
 │        (the room now takes joins)  │                            │
```

Joining, after the same `welcome`, `offer` and `answer` for the joiner:

```
joiner              server                                    host
  │                   │── joiner publishes reliable, unreliable  │
  │                   │── host subscribes to both (canReply)     │
  │◀── link {peer: 0} │── link {peer: n} ────────────────────────▶│
  │                   │                                          │── "ready" on reliable
  │◀═══════════ game traffic through the SFU, both ways ═════════▶│
```

## Data channels

Each link has two channels, published by the joiner and subscribed to by the
host with `canReply`, so that each carries both directions:

| Channel | Options | Carries |
| --- | --- | --- |
| `reliable` | ordered, reliable; the host's subscription has `waitForAck` | the game's TCP connections |
| `unreliable` | `ordered: false`, `maxRetransmits: 0` | the game's UDP datagrams and broadcasts |

A page creates each with `createDataChannel(name, {negotiated: true, id,
...options})`, `id` from `link`. The host's first message on `reliable` is
the text `ready`, which the SFU takes as its acknowledgement and does not
pass on; the SFU holds the joiner's messages until then. Every other message
is binary.

`unreliable`: one datagram a message, big-endian:

```
u16 source port | u16 destination port | the datagram (at most 1400 bytes)
```

`reliable`: the game's TCP connections, multiplexed, as streams. Every
message, big-endian:

```
u8 kind | u16 stream | ...
```

| `kind` | After the stream | Meaning |
| --- | --- | --- |
| 0 `open` | u16 destination port, u16 source port | The sender's game connects to that port. The sender numbers the stream (1 to 32767). |
| 1 `data` | the bytes (at most 16 KiB a message) | |
| 2 `close` | | The sender's side closed; the other side closes too. |
| 3 `refused` | | Nothing listens on the port of an `open`: the connection fails. |

Each side numbers the streams it opens, so two may have one number. In
every message but `open`, the stream's top bit (0x8000) is set when the
stream is the receiver's: the one that opened it is the one getting the
message. (Not by role: with tabs, every page links to every other.)

KCP and the desktop's packet encryption are not needed: SCTP makes the
streams reliable, and DTLS encrypts every data channel.

## The game's side

This repository takes changes from upstream, which has no browser build. So
the browser's network code implements upstream's interfaces, and the web
build chooses it. Upstream's files change only in a few places, each in
`#ifdef __EMSCRIPTEN__` (refer to "The lobby" for the first three):

- `source/networking/network_server_manager.c`: a host starts its game
  alone (`server_ok_to_countdown`, `network_game_server_game_can_start`).
- `source/interface/ui_widget.c`: a screen that opens is told to
  `web_lobby.c` (in the port's block in `ui_widget_launch_widget`).
- `port/linux/src/sdl_platform.c`: the mouse is not captured at start-up
  (a page would lock it at the first click, in the menus), and a hidden
  page plays on a 33 ms timer (`web_wait_for_frame`, the fork's own).
- `source/main/main.c` is not changed: the web build renames its call of
  `network_test_update` to `web_frame_update` (`WEB_GAME_RENAMES`).

The layers:

| Layer | Upstream's (unchanged) | The browser build |
| --- | --- | --- |
| The game, its Winsock calls | `source/` | the same |
| Winsock, XNet, virtual addresses, routing to peers | `port/linux/src/xnet.c` | the same |
| Internet play: `p2p.h` | `p2p.c`, `p2p_signal.c`, `p2p_crypto.c`, `p2p_discord.c`, `posix_upnp.c` | `port/web/src/web_p2p.c` instead |
| Sockets: `posix_socket_*` in `posix.h` | `posix_net.c` | `port/web/src/web_net.c` |

1. `web_net.c`: the `posix_socket_*` functions as sockets in memory
   (datagram queues, streams, listening, `select`, the loopback address).
   The host's game reaches itself through 127.0.0.1, so a browser cannot
   host without this. `posix_net.c` keeps its other functions (random
   bytes, names, ...): `tools/web_build.py` compiles it with its socket
   functions renamed (`-Dposix_socket_bind=posix_native_socket_bind`, ...,
   as `WEB_GAME_RENAMES` does for the game), so the two do not collide.
2. `web_p2p.c`: all of `p2p.h`, over the links, as `p2p.c` over its
   tunnel: each peer a virtual address (from its identifier), its
   datagrams and streams framed as above, and its stand-ins the sockets of
   step 1. `tools/web_build.py` leaves the desktop's internet play units
   out.
3. The bridge (below) from `web_p2p.c`'s thread to a transport on the
   page's main thread (`RTCPeerConnection` exists only there). The page
   will read `netVersion` from the game (`HALO_PORT_NETWORK_VERSION`), not
   from a copy.

When an upstream merge changes `p2p.h` or the socket functions of
`posix.h`, the web build stops at compiling or linking (a declaration that
does not match, or a function that `web_p2p.c` lacks): update the web files
then. A change to `xnet.c` or the game needs nothing. A new
`HALO_PORT_NETWORK_VERSION` reaches the browsers by itself; the rooms
refuse a joiner of another version than the host.

## The lobby

The page offers online games itself, over the game's menus (`App.jsx`):

- When the game's Multiplayer menu opens, the page's shows over it: host an
  online game (a map and a game type), or join a friend's with their
  invite. "Split screen or local network" leaves the game's own menu,
  whose System Link still lists the games the page's links reach.
- Create game hosts the game. With "Start now" (the default) it starts at
  once: the host plays alone until friends come, and they join it in
  progress. With "Wait for friends" the host waits in the game's own lobby
  (its Select Teams screen), where friends who open the invite arrive (a
  team game puts them on the other team), until the host starts the game:
  the page's Start game, or the lobby's own (A). Either way the host's page
  shows the invite to copy.
- A page opened with an invite (`#join=`) links to the host, and its game
  then finds the host's game and joins it, in progress, with no menus.

`web_lobby.c` does this in the game, once a frame on the game's thread
(`web_frame_update`, which main.c calls in place of `network_test_update`,
and which calls it first). Hosting and joining take network_test.c's own
steps: the fast setup of a server, the map and game type, the player of
controller 1 and an immediate start (or none, for the lobby: a `start`
request, or the game's own Start, starts it later); the first game the
search finds, then a team. The game starts with one machine and one player in the
browser build (the Xbox wanted two machines), and players join it in
progress (`port/linux/NETCODE.md`, "Joining a game in progress").

The page and the game share a mailbox (`struct web_lobby_mailbox`, in the
game's memory): the page writes a request (`host` with a map, a game type
and whether to start now; `start`; or `join`) and raises
`request_sequence`; the game writes its phase (`main-menu`,
`multiplayer-menu`, `starting`, `lobby`, `hosting`, `joining`, `joined`,
`failed` with a message) and raises and notifies `event_sequence`. `ui_widget.c` tells `web_lobby.c` which screen opens,
as nothing else in the game says that its Multiplayer menu is up.

While the page's menu shows, the mouse is the page's (a locked pointer
sends every click to the game), and the menu's keys do not reach the game.
The game starts windowed (`HALO_FULLSCREEN=0`, `game.js`): its own
fullscreen would take the bare canvas fullscreen and hide the page's
panels; the page's fullscreen button takes them along.

## The bridge

`web_p2p.c` and `app/src/net_bridge.js` share two rings in the game's
memory (`struct web_bridge`), one each way, so that no datagram waits for
a call to another thread:

```
struct web_bridge: u32 magic "HALO", u32 version (1), u32 out_sequence,
                   u32 in_sequence, u8 identifier[6], u16 network version
                   (HALO_PORT_NETWORK_VERSION), then two rings
struct web_ring:   u32 head, u32 tail, u32 size, u32 reserved, u8 data[1 MiB]
a record:          u16 size (little-endian), u8 link, u8 type, then size bytes
```

`head - tail` bytes are in a ring (the counts run on and wrap); the writer
moves `head`, the reader `tail`.

| Way | Types | Wakes the other side by |
| --- | --- | --- |
| game to page | 0 reliable, 1 unreliable (the bytes of a channel's message), 2 hosting, 3 not hosting | raising `out_sequence` and notifying it (the page waits with `Atomics.waitAsync`) |
| page to game | 0 link up (the peer's identifier), 1 link down, 2 reliable, 3 unreliable | calling `web_p2p_wake()`, which sends a datagram to the thread's wake socket |

When the ring to the game is full, the page holds its records (and drops
unreliable ones past a thousand); when the ring to the page is full, the
game's datagrams are lost and its streams wait. A transport numbers its
links 0 to 127, and has `start`, `send` and, if it cares, `hosting`
(`net_bridge.js`).

## Testing

`?net=tabs` links a page's game to the game's other pages in the same
browser (`app/src/tab_transport.js`, over a `BroadcastChannel`), as
machines on one LAN, with no server and no WebRTC. Keep each page in a
window of its own: a page in the background stops drawing, and so
playing.

With `debug.network_test` (refer to `port/linux/NETCODE.md`), one page
hosts and one joins:

```
http://localhost:8765/?net=tabs&HALO_NETWORK_TEST=host:bloodgulch&HALO_NETWORK_TEST_START=60&HALO_TEST_INPUT=bot:1&HALO_NETWORK_TEST_SHOOT=5&HALO_NETWORK_TEST_KILL=20
http://localhost:8765/?net=tabs&HALO_NETWORK_TEST=join&HALO_TEST_INPUT=bot:2&HALO_NETWORK_TEST_SHOOT=5
```

Each page logs every player's state every second in the console; the two
must agree. Six minutes of this, with a vehicle and a weapon pickup too,
ended with both pages at the same scores, kills and deaths, and every hit
the joiner reported dealt by the host.

Through the SFU, with `npm run dev` (and the SFU app in `.dev.vars`): open
a page with `?HALO_NETWORK_TEST=host:bloodgulch&HALO_NETWORK_TEST_START=90`,
then another with `?HALO_NETWORK_TEST=join#join=<the first's invite>`.
Three and a half minutes of this (scripted shots and kills, no bots: in the
menus a bot presses A at random) ended with both pages at 30 ticks a
second, the same scores, and all 37 hits the joiner reported dealt by the
host.

The whole of it, as a player does it, driven in a headless Chrome: a page at the main menu, the arrow down and Enter to Multiplayer, the page's
menu, Damnation and Team Slayer, Create game: the host was playing on
Damnation 3 seconds later, its invite shown; a second page opened with the
invite was playing in that game 5 seconds after it opened. With "Wait for
friends", both pages were in the lobby's Select Teams screen (the friend on
the other team), and Start game in the host's page took both into the game.

## Moving to Phoenix

`worker/rooms.js` can be replaced by a Phoenix server that speaks these
same messages; the pages change only the signalling address
(`signalling` in `app/src/halo_net.js`). Refer to the note at the start of
`worker/rooms.js`.
