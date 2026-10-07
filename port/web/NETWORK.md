# Network play in the browser

The plan for system link games between browsers. A browser cannot use the
desktop's internet play (`port/linux/src/p2p.c`): it has no UDP or TCP
sockets, so no MQTT brokers, STUN or hole punching. Browsers reach each other
through WebRTC data channels, relayed by Cloudflare Realtime SFU, and find
each other through the signalling: a server of our own, or the site's Worker.

Status:

- Done: the in-memory sockets (`src/web_net.c`), internet play over links
  (`src/web_p2p.c`), the bridge to the page (`app/src/net_bridge.js`), the
  signalling (`app/src/halo_net.js`, and its two servers: `signalling/`,
  Elixir, and the Worker's `worker/rooms.js`; refer to "The signalling's
  server"), and two transports: through the SFU (`app/src/sfu_transport.js`, the default),
  and between the pages of one browser (`app/src/tab_transport.js`,
  `?net=tabs`), and the lobby (`src/web_lobby.c`, `app/src/lobby.js`):
  the game's own menus (the PC version's, as upstream's) host and join, and
  a page opened with an invite joins its game, in progress. Refer to "The
  lobby" and "Testing".
- Deployed at openhaloce.com (its secrets: `wrangler secret put`).
- Native games: a browser joins a desktop build's game through a relay, on
  Fly.io, by its invite or from the PC menus' server browser (refer to
  "Native games"). A page hosts for browsers only.
- To do: browsers' rooms in the server browser (rooms that list themselves).
- To do: remove the Worker's rooms, once the pages have moved to the
  signalling's server and it has run a while (refer to "Removing the
  Worker's rooms").
- To do, perhaps: the lobby's chat kept in a Postgres database, so that its
  history outlasts a restart of the server (refer to "The lobby's chat").
- To do: moderation for the lobby's chat: it has length and rate limits, and
  blocked words, but no mute, report or ban (refer to "The lobby's chat").

## How it differs from upstream's

Multiplayer in the browser is upstream's game and menus, but it does not
always work the way the desktop builds do. Each difference below is a
product decision the fork has made. During a merge from upstream, a change
that touches one of them is a behavioural conflict: ask the owner what to
do (`AGENTS.md`, "Syncing with upstream") rather than taking either side.
The fork's decisions are kept here, in a tracked file, because `AGENTS.md`
is not in git. When a decision changes, update this list.

| # | The browser build | Upstream (desktop builds) | Why | Where |
| --- | --- | --- | --- | --- |
| 1 | Browsers play each other over WebRTC data channels through Cloudflare Realtime SFU, in rooms on our signalling. | `p2p.c`'s tunnel: MQTT brokers, STUN, hole punching, KCP, its own encryption. | A page has no UDP or TCP sockets. DTLS encrypts the channels and SCTP makes them reliable, so KCP and the tunnel's encryption are not used. | `src/web_p2p.c`, `app/src/sfu_transport.js`, `signalling/` |
| 2 | A browser's invite is `https://<site>/#join=<room>.<secret>`. | `halo://join/...` | A link anyone can open in a browser. The secret is in the fragment, which is never sent to a server. | "Rooms and invites" |
| 3 | A page hosts for browsers only. Desktop builds cannot join a browser's game. | Any desktop build can host anyone. | Hosting desktop players would put every joiner's traffic through the relay, and a host page in a background tab would slow the game for everyone. | `web_p2p_select.c` (`p2p_native_set_hosting_allowed(0)`) |
| 4 | A page joins desktop builds' games (by invite, Direct Link or the Server Browser) by running upstream's `p2p.c` unchanged, with its sockets lent by our relay on Fly.io. | Direct sockets. | The browser speaks the desktop's protocol exactly, so it keeps working as upstream changes it. | "Native games" |
| 5 | A browser's room is never listed in the Server Browser. Server Setup hides LISTING and PASSWORD, and `p2p_set_hosting_public`, `p2p_set_hosting_password` and `p2p_set_game_listing` keep nothing. | Public lobbies, with a password since network version 20. | Desktop builds could not join a listed browser room (see 3). Listing browsers' rooms for other browsers is a to-do. | `menu_functions.c` (`server_settings_update`), `web_p2p.c` |
| 6 | A browser can join a desktop build's password-protected public game. The game's own text field asks for the password. | The same. | Matches upstream. | `web_p2p_select.c` (`p2p_listing_unlock`) |
| 7 | A host starts its game alone, in any game type, and the players it invites join the game in progress. The first game of an internet host starts as soon as Server Setup's START GAME is pressed: no lobby, no countdown. After each game's scores the host is back in the lobby, as upstream, and starts the next from there (the room stays open). | The game waits in the lobby for its minimum players (and teams), then counts down. | A friend opening an invite should be playing at once, and a room should be a game being played (decided 2026-10-06; the lobby between games was the owner's choice, over starting the next game on its own). | `network_server_manager.c` (`server_ok_to_countdown`, `network_game_server_game_can_start`), `menu_functions.c` (`server_start`, `web_host_start_update`), "The lobby" |
| 8 | A page opened with an invite (`#join=` or `#native=`) skips the menus. It joins the game in progress from the main menu, then opens the menus' lobby. | The player joins through the menus, or from the clipboard at start-up. | One click from an invite to playing. | `src/web_lobby.c`, `app/src/lobby.js` |
| 9 | Create Game > Internet makes the room only when the game starts (Server Setup's START GAME), not when Server Setup opens, so Server Setup's INVITE LINK reads MADE WHEN THE GAME STARTS. The invite is then on the page (its toast and its bar) and in the lobby between games. Create Game > LAN makes no room. | The server, and its invite, are made as Create Game opens, and Server Setup shows the invite. | A room is a game being played, not one being set up. A browser has no LAN, so a LAN game gets no room and no invite. | `menu_functions.c` (`multiplayer_host`, `server_start`: `p2p_set_hosting_allowed`), "The lobby" |
| 10 | The clipboard is read only when the player presses PASTE LINK. `network.join_from_clipboard` is off. | The game reads the clipboard each time its window comes to the front, and joins an invite it finds there. | The browser asks the player's permission to read the clipboard; reading it unprompted would show that prompt for no reason. | `src/web_clipboard.c`, `app/src/game.js` |
| 11 | A room ends when its host's WebSocket closes. Games already linked go on, but no one else can join until the host hosts again. A deploy of the Fly machine drops native games. | The host's own process keeps hosting. | Rooms live in the signalling server's memory. | "Rooms and invites", "The machine" |
| 12 | Limits: 15 joiners (16 machines) a room, 5 rooms and 20 joins a minute from an address, and the relay's caps for native games. | The game's own limits. | Each join costs SFU sessions, and the relay is shared. | "Rooms and invites", "The relay's limits" |
| 13 | A joiner must have the host's `HALO_PORT_NETWORK_VERSION`. The rooms refuse other versions, and native games need a matching desktop release. | The same check, in `p2p.c`. | Matches upstream. A new version reaches browsers on deploy. | "The game's side" |
| 14 | No Discord identity and no hardware id: `p2p_discord_identity` and `p2p_hardware_id` give empty values for browsers. | Discord name and id, hardware id. | A page has neither. | `web_p2p.c` |
| 15 | A lobby beside the game, outside it: how many browsers have the site open, and a chat between them, using the player's profile name. | None. | The fork's own feature. | "The online count", "The lobby's chat" |
| 16 | A page in a background tab keeps playing on a 33 ms timer. | The game runs at full speed. | Browsers throttle hidden pages, and a host that stopped would freeze its game for everyone. | `sdl_platform.c` (`web_wait_for_frame`) |

If upstream changes any of these on its side, the browser build may need a
matching change (in `web_p2p.c`, `web_p2p_select.c`, the relay or the page),
or the decision may need revisiting. Some examples:
- a new `p2p.h` function: decide what a browser's room does with it (as with
  5 and 14);
- a new way to host or list games: decide whether browsers' rooms take part
  (3 and 5);
- a change to the countdown or join-in-progress rules: check 7 and 8;
- a new clipboard or invite behaviour: check 2 and 10.

## Parts

```
 joiner's page                   signalling                     host's page
 ┌──────────────┐  WebSocket   ┌──────────────────┐  WebSocket  ┌──────────────┐
 │ halo_net.js  │──signalling──│ a room for each  │─signalling──│ halo_net.js  │
 │              │   (JSON)     │ game             │   (JSON)    │              │
 │              │              │                  │             │              │
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
  token stays in the signalling's server (`REALTIME_APP_ID`,
  `REALTIME_APP_TOKEN`).
- **Star.** As on the desktop, joiners reach only the host, and the host
  makes the game's decisions. A link is a joiner and the host.

## Rooms and invites

A room is one hosted game, at `wss://<signalling>/net/rooms/<room>`
(`<signalling>`: what the site's Worker answers at `GET /net/signalling`,
or the site itself; "The signalling's server"):

- `room`: 8 characters of Crockford's base 32, made by the server. It names
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
site is refused. (The server of `signalling/` has two more, for its
machine's sake: "The signalling's server".)

## Signalling messages

Each message is a JSON object with a `type`. `version` is this protocol's
version, now 1. `id` is the machine's 6-byte identifier, as 12 lowercase hex
digits: the one its XNADDR carries (`p2p_identifier()`), from which every
machine derives the peer's virtual address in 100.64.0.0/10 as on the
desktop. `netVersion` is `HALO_PORT_NETWORK_VERSION`.

The page sends the text `ping` every 30 seconds; the server answers `pong`
without a word to the room.

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
last minute: 5 and 20; or has too many pages at once), `protocol` (a message out of order or malformed), `version`
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
`#ifdef __EMSCRIPTEN__`:

- `source/networking/network_server_manager.c`: a host starts its game
  alone (`server_ok_to_countdown`, `network_game_server_game_can_start`).
- `port/linux/game/menu_functions.c`: an internet game's room is made, and
  its first game started, at Server Setup's START GAME (`multiplayer_host`,
  `server_start`, `web_host_start_update`; "The lobby").
- `port/linux/game/menu_functions.c`: Video Setup shows neither RESOLUTION
  nor WINDOW SIZE (`video_rows_show`; `port/web/README.md`), and Server
  Setup neither LISTING nor PASSWORD (`server_settings_update`): a
  browser's room is not listed in the server browser, so the two have
  nothing to set.
- `port/linux/src/menu_files.c`: Video Setup's ANTI-ALIASING is Android's
  row (`web_android_rows`), as the browser draws as Android does
  (`port/web/README.md`).
- `port/linux/src/sdl_platform.c`: the mouse is not captured at start-up
  (a page would lock it at the first click, in the menus), a hidden page
  plays on a 33 ms timer (`web_wait_for_frame`, the fork's own), and the
  game's fullscreen (F11, Settings) is the page's (`web_page_fullscreen`:
  the page's panels along, as its button does).
- `source/main/main.c` is not changed: the web build renames its call of
  `network_test_update` to `web_frame_update` (`WEB_GAME_RENAMES`); nor is
  `sdl_platform.c`'s clipboard used: the web build renames it out of the
  way (`WEB_PLATFORM_RENAMES`) for `src/web_clipboard.c`'s, on the page's
  thread.

The layers:

| Layer | Upstream's (unchanged) | The browser build |
| --- | --- | --- |
| The game, its Winsock calls | `source/` | the same |
| Winsock, XNet, virtual addresses, routing to peers | `port/linux/src/xnet.c` | the same |
| Internet play: `p2p.h` | `p2p.c`, `p2p_signal.c`, `p2p_lobby.c`, `p2p_crypto.c`, `p2p_discord.c`, `posix_upnp.c` | `port/web/src/web_p2p.c` beside the same (`web_p2p_select.c`; "Native games") |
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
   step 1. The desktop's own runs beside it, for desktop builds' games
   ("Native games").
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

The game's own menus host and join, as on the desktop: the PC version's
(upstream's, `display.menus = "pc"`). Their Multiplayer has, for a browser:

- Create Game > Internet: the game hosts, and the page makes it a room
  (`web_p2p.c` tells it, as the game listens and hosting is allowed),
  whose invite (`https://<site>/#join=<room>.<secret>`) the page shows to
  copy and the menus show too (the lobby's "Invite link copied":
  `p2p_invite_link`, which the page writes into the game). Hosting is
  allowed only once Server Setup's START GAME is pressed (`server_start`;
  until then `multiplayer_host` holds it off), and the game then starts at
  once, the host alone in the map: the lobby asks the server for an
  immediate start (`web_host_start_update`). After each game the host is in
  the lobby again, with the room open, and starts the next as upstream's
  does. Create Game > LAN makes no room (`p2p_set_hosting_allowed`).
- Join Game > Direct Link: PASTE LINK joins the invite on the clipboard,
  a browser's (the page joins its room) or a desktop build's (the desktop's
  internet play, through the relay). The clipboard is read then only
  (`src/web_clipboard.c`; `network.join_from_clipboard` is off in the
  browser), which the browser may ask the player to allow, once.
- Join Game > Server Browser: desktop builds' public games ("Native
  games").

A page opened with an invite (`#join=` a browser's, `#native=` a desktop
build's) links to its host, and its game then finds the host's game and
joins it, in progress, from the main menu: `web_lobby.c` does this in the
game, once a frame on the game's thread (`web_frame_update`, which main.c
calls in place of `network_test_update`, and which calls it first), with
network_test.c's own steps (the first game the search finds), then opens
the menus' lobby. The game starts with one machine and one player in the
browser build (the Xbox wanted two machines), and players join it in
progress (`port/linux/NETCODE.md`, "Joining a game in progress").

The page and the game share a mailbox (`struct web_lobby_mailbox`, in the
game's memory): the page writes a request (`join`) and raises
`request_sequence`; the game writes its phase (`main-menu`, `joining`,
`joined`, `failed` with a message) and raises and notifies
`event_sequence`.

The game starts windowed (`HALO_FULLSCREEN=0`, `game.js`): its own
fullscreen would take the bare canvas fullscreen and hide the page's
panels; the page's fullscreen (its button, F11, the game's Settings) takes
them along.

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

With the PC menus, driven in a headless Chrome with keys
(`relay/test/drive.mjs` for the pages, key presses through Chrome's
DevTools protocol): Multiplayer > Create Game > Internet hosted, and the
page made its room and showed its invite; Create Game > LAN made none; a
second browser opened with the room's invite was playing in that game,
joined in progress, 2 seconds after its game reached the main menu; and
Join Game > Server Browser listed the desktop builds' public games on the
internet, through the relay.

## Native games

A browser joins a game a desktop build hosts,
with its invite (`halo://join/...`), and the desktop build is not changed.
The page runs the desktop's own internet play (`port/linux/src/p2p.c`, with
`p2p_signal.c`, `p2p_crypto.c` and `p2p_discord.c`), so it speaks the
desktop's protocols as they are, and keeps doing so as upstream changes
them. What a browser lacks, real sockets, a relay lends it:

```
 browser                                   relay (port/web/relay)       desktop build
 ┌───────────────────────────┐ WebSocket  ┌──────────────────┐  UDP     ┌──────────────┐
 │ p2p.c ── web_net.c ── relay_bridge.js │═══════════│ real sockets     │══════════│ p2p.c        │
 │ (sealed tunnel, MQTT)     │  records   │ (sees sealed     │ tunnel   │              │
 └───────────────────────────┘            │  bytes only)     │──────────│ MQTT brokers │
                                          └──────────────────┘  TCP     └──────────────┘
```

- **Both internet plays.** `web_p2p.c` and `p2p.c` both implement
  `p2p.h`. `tools/web_build.py` compiles them with its functions renamed
  (`p2p_web_*`, `p2p_native_*`), and `src/web_p2p_select.c` gives the game
  both at once: one machine with one identifier (the desktop's, which its
  tunnel proves; the rooms are told it too), whose peers are each the one's
  that has them. The desktop's starts only when first needed, for a desktop
  build's invite or the server browser, so a page that never needs it
  never reaches the relay (`relay_bridge.js` connects at the game's first
  record). It never hosts: a page hosts for browsers only, as hosting for
  desktop builds' players would have the relay carry every joiner's
  traffic, and a host's page in the background slow the game for all of
  them.
- **The server browser.** The PC menus' Join Game > Server Browser lists
  desktop builds' public games (`p2p_lobby.c`, through the MQTT brokers),
  and joins one by its invite, as Direct Link does. A game with a password
  (network version 20) asks for it first: `p2p_listing_unlock` opens the
  listing's sealed invite on this machine (`web_p2p_select.c` calls the
  desktop's, which need not have started), and the game's own text field
  takes the typing (on a phone, its on-screen keyboard).
- **The brokers** are the desktop's: `port/assets/network/brokers.txt`,
  which the desktop builds read beside `config.toml`
  (`network.brokers_file`) and the browser build carries in its own files,
  at `/brokers.txt` (`tools/web_build.py`). The relay reaches only the
  brokers it knows, so a broker upstream adds to that file must be added to
  `RELAY_BROKERS` too (`relay/main.go`), and the relay deployed: until
  then the page gets no address for the new one, and uses the rest (any
  one is enough).
- **Sockets.** `p2p.c` keeps its stand-ins on this machine, as `web_p2p.c`
  does, and only its tunnel's socket and its brokers' connections go to the
  internet. `web_net.c` sends a socket's datagrams and connections there
  (an address that is not this machine's, a broadcast or a peer's virtual
  one) through the relay, and puts what comes back into the socket, so
  `select` and the rest work as for any socket of `web_net.c`. Names are
  looked up through the relay too (`posix_resolve_ipv4`). UPnP is stubbed:
  the relay has a public address, and no router to ask.
- **The bridge.** `web_net.c` and `app/src/relay_bridge.js` share two rings
  in the game's memory (`struct web_relay_bridge`), as `web_p2p.c` and
  `net_bridge.js` do; a thread of `web_net.c`'s takes the page's records.
  The page passes each record to the relay as one WebSocket message and
  knows nothing of what it holds.
- **The relay** (`relay/main.go`, Go) opens a socket for each socket of
  the page's that reaches the internet. The tunnel is sealed end to end, so
  it sees addresses and sealed bytes. Messages (big-endian numbers; a
  handle is a socket of the page's):

  | Page to relay | Relay to page |
  | --- | --- |
  | 1 datagram: handle, address, port, data | 1 datagram: handle, from address, from port, data |
  | 2 connect: handle, address, port | 2 connected: handle |
  | 3 data: handle, bytes | 3 refused: handle |
  | 4 close: handle | 4 data: handle, bytes |
  | 5 resolve: number, name | 5 closed: handle |
  | | 6 resolved: number, address (0: none) |
  | 0x7f ping, echoed by the page | 0x7f ping: number |

  With `RELAY_REPORT=1` it logs each page's round trip to it, the traffic
  each way, and the loss of the desktop's tunnel packets on their way to
  it, from the packet numbers in their header (which is authenticated, not
  encrypted).
- **Invites.** A page opened at `#native=<invite>` joins that game
  (`HALO_NET_NATIVE_INVITE`, as the game's internet play starts; then "The
  lobby"); Direct Link's PASTE LINK takes one too.
- **Where it runs.** On Fly.io (`fly.toml`: the app `halo-web-relay`,
  in iad; "The machine"), not on Workers, which have no UDP. What Fly does with UDP, as
  found in deploying it:
  - it takes UDP in only on a dedicated IPv4 (109.105.217.218), for sockets
    bound to `fly-global-services`, and does not translate ports;
  - only ports listed one by one, each its own `[[services]]`: a
    `start_port`/`end_port` range validates, but takes nothing in. Each
    session takes a port of `RELAY_UDP_PORTS` (96: 96 pages in native
    games at once), and is reached at the dedicated IP and that port
    as it is (no NAT: the desktop's hole punching gets through);
  - what the machine sends first (a STUN request, a punch) leaves from its
    egress address, not the dedicated IP, and STUN reports that one, which
    takes nothing in. So the relay rewrites STUN's answers to the dedicated
    IP (`RELAY_PUBLIC_IP`), which the page then offers; a peer's packets to
    it come in, and the answers to them leave from it;
  - one machine: a peer's UDP reaches the IP's nearest machine, which must
    hold the page's sockets (more regions: an app, and an IP, for each);
  - Fly leaves about 1300 bytes of a packet, less than the tunnel's largest
    (1431); no loss was seen, but the sizes were not logged.

  Measured (2026-10-04), the live site, through iad, to a desktop build
  behind two NATs (Docker's, which gives each destination its own port, and
  a router's): two browsers in one desktop host's game,
  the same final scores on all three machines, 22 to 26 ms average round
  trip from the page to the relay, and none of about 8,200 tunnel packets
  from the host missing. A session that started seconds after the machine
  did got no STUN answers at all (its port worked later): to watch after
  deploys.

### The relay's limits

Anyone who opens the site can get a token, so a token alone does not stop
abuse: it makes the relay serve only what comes through the Worker's
limits, and the relay does only what native games need, so that a token
is worth little for anything else.

- **Tokens** (`worker/relay.js`). Before each connection the page asks
  `POST /net/relay`: only the site's own pages get an answer, at most 10 a
  minute for an address (`RELAY_LIMIT`). The answer is the relay's address
  (`RELAY_URL`) and a token, `<expiry>.<nonce>.<signature>`: the
  signature is the HMAC-SHA256 (base64url) of `relay1.<expiry>.<nonce>`
  with `RELAY_TOKEN_SECRET`, which the Worker and the relay share. The
  relay takes a token once, within its minute, and checks the page's
  `Origin` (`RELAY_ORIGINS`).
- **What it sends.** Names: only the brokers' and the STUN servers' are
  looked up. TCP: only to the addresses those brokers had, on their port.
  UDP: to the STUN servers only a binding request; anywhere else only the
  desktop's tunnel packets (their magic and size), and only to public
  addresses; a destination that does not answer gets 200 at most.
- **What it takes.** UDP only from the addresses the session sent to (from
  any of their ports, as TURN's permissions: a peer behind a NAT that gives
  each destination its own port answers from another than STUN told): no
  one else reaches a page through it.
- **Caps**, for a page that joins (a joiner sends its host about 35
  datagrams, 5 KiB, a second, and gets about 40, 15 KiB). Each session: 200
  datagrams and 256 KiB a second to its peers, 500 and 256 KiB from them
  (a big co-op game sends each player about 250 KiB: past the cap, it loses
  packets at the relay),
  64 KiB a second to the brokers, 2 UDP and 6 TCP sockets, 16
  destinations, 30 lookups a minute (10 at once). Sessions: 4 from an
  address, 400 in all, and one UDP port each (96 on Fly.io).

At worst, then, a token buys a few hundred small datagrams, shaped like the
desktop's, to an address that does not answer: nothing amplified, and
nothing to a private network. `relay/test/limits.test.mjs` tests each of
these.

### Trying it

Locally, with `npm run dev` (no secret: `RELAY_INSECURE=1` for the relay;
`?relay=<ws URL>` gives the page another relay than port 8790 of its host):
`relay/test/README.md` runs a desktop build's host in Docker beside the relay,
and joins it from a headless Chrome. By hand, open a desktop build's invite in
a page: `http://localhost:8765/#native=halo://join/...`.

Deployed: the relay as `fly.toml` says, the same secret in the Worker
(`npx wrangler secret put RELAY_TOKEN_SECRET`), and `RELAY_URL` in
`wrangler.toml`.

## The signalling's server

`signalling/` (Elixir: Bandit, a plain WebSocket) is the rooms as a server
of our own, on the relay's machine. It speaks "Signalling messages" as
`worker/rooms.js` does, so the pages change only the address
(`signallingAddress` in `app/src/halo_net.js`): what the Worker answers at
`GET /net/signalling`, which is `wrangler.toml`'s `SIGNALLING_URL`. Without
one the pages use the Worker's own rooms (a `GameRoom` Durable Object for
each), which stay until this server has run a while. `?signalling=<URL>`
gives a page another.

What it is for: what a server that is always there can do and a Durable
Object cannot, a lobby that rooms update and pages watch (browsers' rooms in
the server browser), and hosts that come back to their rooms. Neither is
made yet.

- **A process for each.** A room is a process (`Signalling.Room`), found by
  its code; a page's WebSocket is another (`Signalling.Page`), which makes
  its own SFU calls, so a slow SFU holds up that page only. The room
  watches its pages: a joiner's end is the host's `unlink`, the host's end
  is the room's.
- **In memory.** Rooms are kept nowhere else: when the server starts again
  they are gone, and their hosts host again ("The machine").
- **Limits.** As the Worker's (5 rooms and 20 joins a minute for an
  address, by `Fly-Client-IP`), and two for the machine, whose memory is
  the relay's too: an address has at most 32 pages at once
  (`SIGNALLING_PAGES_AT_ONCE`), and the server 800. A page that has not
  answered the SFU's offer, or said who it is, in 30 seconds is closed, and
  one that has sent nothing for 90.
- **When the host leaves**, its joiners' channels are left open, as "Rooms
  and invites" says: a host whose WebSocket dropped plays on. The Worker's
  rooms close them (as for a joiner that leaves), which ends those links.
- **Settings** (the environment): `SIGNALLING_PORT` (8791) and
  `SIGNALLING_HOST` (127.0.0.1: the relay passes `/net/rooms/` on),
  `SIGNALLING_ORIGINS` (the pages' origins allowed; any, if empty),
  `REALTIME_APP_ID` and `REALTIME_APP_TOKEN`, and for tests `SFU_API` and
  `SIGNALLING_ANSWER_TIMEOUT` (milliseconds).

Locally: `mix run --no-halt` in `signalling/` (with the SFU app's two
values in the environment), and `SIGNALLING_URL=http://localhost:8791` in
`.dev.vars` for `npm run dev`.

`signalling/test/rooms.test.mjs` talks to it as pages do, with an SFU of
its own, and runs against the Worker's rooms too (`SERVER=worker`), so that
the two stay the same to a page, and against Fly.io's image
(`SERVER=machine`).

### The online count

The lobby's chat (to the game's right; "The lobby's chat") shows how many
browsers have the site open (`app/src/online.js`). Only this server has
it: the Worker's rooms do not, and a page without it shows no count, and a
chat that waits.

- **A WebSocket for each page**, `/net/online?visitor=<id>`, open as long as
  the page is (`Signalling.Online`; the relay passes it on, as
  `/net/rooms/`). `visitor` is the browser's, in `localStorage`
  (`halo-visitor-v1`): a browser's tabs are one. Server to page:
  `{"type": "online", "count": n}`, as it connects and as the count
  changes; the page pings every 30 seconds.
- **Phoenix's Presence** (`Signalling.Presence`, without Phoenix's Endpoint
  or Channels) tracks each WebSocket by its visitor; its `handle_metas`
  gives the count (the topic's keys) to `Signalling.OnlineCount`, which
  tells the pages at most every 2 seconds, and only when it changed: one
  message for each page, not one for each page that comes or goes.
- **Limits.** They are among an address's 32 pages, and at most 400 at once
  (`SIGNALLING_ONLINE_AT_ONCE`), so that the rooms' pages keep the rest of
  the server's 800. A page refused, or whose WebSocket closes, shows no
  count and tries again, after 1 to 2 seconds, then longer, at random, so
  that after a restart the pages do not all come back at once. A tab hidden
  for 5 minutes lets go of its WebSocket until it is shown again.

### The lobby's chat

A pane to the game's right (`app/src/Chat.jsx`), as tall as it: every page
with the site open, over the online count's WebSocket (`Signalling.Chat`).
Not where the window is narrower than 900 pixels, nor on phones and
tablets (the game takes the whole window).

- **Messages.** Page to server: `{"type": "name", "name"}` (as it connects,
  and when the name changes) and `{"type": "chat", "text"}`. Server to
  page: `{"type": "history", "messages"}` as it connects (the last 50, in
  memory: a restart forgets them), then `{"type": "chat", "id", "name",
  "color", "text", "at"}` for each, and `{"type": "error", "code": "busy"}`
  for a message refused. A name is at most 11 characters, a message 200;
  control characters are spaces. An address says at most 20 a minute.
- **Blocked words.** A message whose text or name has one of
  `signalling/lib/signalling/chat_blocked.txt`'s (`Signalling.ChatFilter`:
  letters only, look-alikes such as `1` and `3` undone, each letter
  repeated or not) is told only to the page that said it: it is shown
  there, with an id of its own, so that nothing tells the sender; the other
  pages never see it, and the history does not keep it (a reload loses it).
  Only the slurs said most, not a moderator: a word that is in other words
  is matched only on its own (`=coon`, not `raccoon`), and one that is not,
  anywhere (`n i g g e r`). `mix test --no-start` checks the list against
  words it must let through.
- **The history** is the `Signalling.Chat` process's state (an Erlang
  `:queue`, not ETS): the last 50 messages, in memory only. A deploy, a
  crash or `fly_start.sh`'s restart forgets them, and the ids start again
  at 1 (the pages then drop what they had: `online.js`). To do, perhaps:
  keep them in a Postgres database (Fly's, or one hosted elsewhere), so
  that the history outlasts a restart and can be longer; the process would
  still give each message its id and tell the pages, and write each to the
  database as it does.
- **The name** is the player's Halo profile's (`app/src/profile.js`): the
  page reads the saves the browser keeps (OPFS, `web_main.c`'s
  `mount_saves`): of `u/UDATA`'s profiles (a folder with a `blam.sav`,
  whose first 24 bytes are the name, UTF-16LE), the one the game last
  played as (`z/lastprof.txt`), else the first by folder name; none, and
  `New001`. It looks again every 15 seconds, for a profile made or chosen.
- **The colour** is one of a multiplayer game's 18 (`player_profile.c`'s
  `profile_color_table`), the server's, by a hash of the visitor id: the
  same at every visit, and a page cannot choose another's. Each name is a
  chip of its colour, so that black, blue and sage read on the pane.
- **Keys.** The chat's keys are its own (the game takes the window's: the
  pane stops them, as the panels over the game do); Esc gives the keyboard
  back to the game.

Locally: the server (`mix run --no-halt`), `npm run dev`, and the page at
`http://localhost:8787/?signalling=http://localhost:8791`.

### The machine

One Fly.io machine (`fly.toml`, `Dockerfile`: `fly deploy` in `port/web`)
runs both servers, started by `fly_start.sh`: the relay, and the signalling
beside it. Only the relay's port is open: it passes `/net/rooms/` to the
signalling (`RELAY_SIGNALLING`), so the two share an address,
`halo-web-relay.fly.dev`.

- **A deploy ends the games in progress**, whichever server it is for: the
  machine starts again, and the relay with it, whose sockets native games'
  pages play through; they are dropped from their games. Games between
  browsers go on (their traffic is the SFU's), but their rooms end: no one
  else joins until their hosts host again. So deploy when few play
  (`fly logs` has each relay session; `/healthz` counts them).
- **The CPU is the relay's first.** The relay carries games' packets, and
  the machine's four shared CPUs have one allowance between them (a quarter
  of one CPU for long: `fly.toml`). The signalling runs at the lowest
  priority (`nice -n 19`), with one scheduler that sleeps as soon as it has
  nothing to do (`signalling/rel/vm.args.eex`: Erlang's spin for a while
  first, by default). Its work is small besides: a few messages and SFU
  calls for each join, and TLS ends at Fly's edge. If it ends, it is
  started again and the relay's games go on; if the relay ends, the machine
  does.
- **Memory.** About 140 MB for the signalling, idle, and 10 MB for the
  relay, of the machine's 1 GB.

Measured (2026-10-05), the image on one CPU of a laptop's Docker, with a
page of the relay's answering its pings: idle, the image took 0.03% of the
CPU; with about 120 rooms and 350 joins a second through the signalling
(far more than there will be, and all of the CPU), the relay's round trip
to its page stayed under 4 ms. At the usual priority it was much the same
(one of 14 ms), so the priority is for what was not tried. (One run's first
round trip, before any load, was 87 ms: not explained.) Not measured on
Fly.io, where a shared CPU that is used steadily is throttled, the relay
with it: watch the machine's CPU after the pages move here.

### The connection limits

`fly.toml`'s `[services.concurrency]` is how many TCP connections Fly's
proxy sends the machine on port 8790: past `soft_limit` it counts the
machine as busy (with one machine, nothing changes), past `hard_limit` it
sends none, and a new one fails at Fly's edge. Fly's own are 20 and 25, for
short requests: here every connection is a WebSocket kept for a whole game.

Why 1200: the sum of what the two servers behind the port take, the relay's
400 sessions (`maximumSessions`, `relay/main.go`; in practice 96, one UDP
port each) and the signalling's 800 pages (4 acceptors of 200,
`application.ex`). It is one count for both: Fly cannot tell a native
game's WebSocket from a room's, so a crowd of either is refused the other's
room too. `soft_limit` is a little under it (1000). (Before the signalling
came, 300 and 400: the relay alone.)

Fly sets no ceiling that matters here: what holds the number down is the
machine. Raise it only when all of these hold, and raise the servers' own
limits with it (Fly's alone changes nothing: the servers refuse at theirs):

1. **Memory.** Measured, not guessed: the memory one more connection costs,
   in the relay (a proxied one is two goroutines and a second socket) and in
   the signalling, on the image (`docker`, as above). At the new
   `hard_limit`, with 96 native sessions, the machine's servers use at most
   three quarters of its memory (now 1 GB; `[[vm]] memory` is the way to
   more). Running out ends the relay, and every native game with it.
2. **The servers' own limits** raised to match: the signalling's acceptors
   (`application.ex`), and `hard_limit` again their sum with the relay's
   sessions; `soft_limit` about five sixths of it.
3. **File descriptors.** A WebSocket the relay passes to the signalling
   holds three (the page's, the relay's to the signalling, the
   signalling's): the machine's `ulimit -n` (`fly ssh console`) is above
   three times `hard_limit`, with room to spare.
4. **The relay first.** With the new number of WebSockets reconnecting at
   once (as after a deploy), a native game's page's round trip through the
   relay stays where it was measured above (under 4 ms), and the machine's
   CPU within its allowance (`fly.toml`'s `[[vm]]`).
5. **A kind of connection that only waits** (a page's count of who is
   online, say) has a limit of its own, lower, so that it never takes the
   room that games' WebSockets need.

Then deploy when few play (it ends native games), and watch the machine's
memory and CPU (refer to the Fly metrics) the first evenings.

### Moving the pages to it

1. In `port/web`: `fly secrets set REALTIME_APP_ID=... REALTIME_APP_TOKEN=...`
   (the Worker's), then `fly deploy` (it ends native games in progress).
2. Check it from the live site, before any page is told of it:
   `node signalling/test/probe.mjs https://openhaloce.com https://halo-web-relay.fly.dev`
   hosts and joins a room there from two tabs of a headless Chrome at the
   site, and sends bytes both ways through the SFU. (The site's pages take
   `?signalling=` only once the next step has deployed them.)
3. Uncomment `SIGNALLING_URL` in `wrangler.toml`, and `npm run deploy`;
   then the same check without its second address, which goes where the
   pages now go. Rooms made before then are the Worker's: a page loaded
   after cannot join them (`not-found`) until their hosts host again.

Moved (2026-10-05): the probe passed from openhaloce.com and
www.openhaloce.com, and a game on the live site between two windows of a
headless Chrome (`debug.network_test`: one hosting, one joining its invite)
went through `halo-web-relay.fly.dev`, both pages at the same scores, kills
and deaths after a minute and a half. On the machine the signalling took
125 MB, idle, at priority 19, and was up 2 seconds after the relay (until
then the relay answers `/net/rooms/` 502: a page that hosts or joins just
as the machine starts tries again). The site's workers.dev address is not
among `SIGNALLING_ORIGINS` (nor `RELAY_ORIGINS`): its pages get no rooms.

### Removing the Worker's rooms

To do, once the pages have moved and the server has run a while (until
then they are the way back: comment `SIGNALLING_URL` out again, and
`npm run deploy`). What goes:

- `worker/rooms.js`'s `GameRoom` and `handleRooms`, and their route in
  `worker/worker.js` (`/net/signalling` stays: it is how the pages find
  the server);
- in `wrangler.toml`: the `ROOMS` Durable Object binding, with a
  `deleted_classes = ["GameRoom"]` migration, and the `HOST_LIMIT` and
  `JOIN_LIMIT` rate limits;
- the Worker's secrets `REALTIME_APP_ID` and `REALTIME_APP_TOKEN`
  (`npx wrangler secret delete`), and their lines in `.dev.vars`, where
  `SIGNALLING_URL` then says where `npm run dev`'s pages find a server;
- the pages' way back to the site's own rooms (`signallingAddress` in
  `app/src/halo_net.js`), and `SERVER=worker` in
  `signalling/test/rooms.test.mjs`;
- what this file says of the two servers, which is then of one.
