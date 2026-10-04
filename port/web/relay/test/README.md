# Testing native games

A browser joining a desktop build's game through the relay
(`port/web/NETWORK.md`, "Native games"), with no desktop build of your own:
a desktop build's release runs headless in Docker and hosts a scripted
game, and a headless Chrome joins it.

Requirements: Docker (on an arm64 Mac it runs the 32-bit x86 Linux build
under emulation), `gh` (to download the release), Google Chrome, and the
maps in `assets/maps` (`tools/extract_maps.py`).

1. Build the browser build (`ninja web`), and serve it (`npm run dev` in
   `port/web`, port 8765).
2. `port/web/relay/test/native_host.sh [release tag]` starts two containers
   on a Docker network of their own, `halonet`:
   - `halo-native-host`: the release (by default `build-74`), hosting Blood
     Gulch with a bot that shoots and is killed every 20 seconds
     (`debug.network_test`, `port/linux/NETCODE.md`);
   - `halo-relay`: the relay (built from `port/web/relay`, as for Fly.io),
     with `RELAY_INSECURE=1` (no tokens, so that `npm run dev` needs no
     secret; and private addresses allowed: the host's is one) and
     `RELAY_REPORT=1`, on port 8790. Its other limits apply as in
     production. It reaches the host at its address on `halonet`: Docker's
     NAT gives each destination its own port, which the host's tunnel could
     not get through otherwise.

   It prints the host's invite. The release's network version
   (`HALO_PORT_NETWORK_VERSION`) must be the browser build's, or the host
   refuses it: `build-74` is the browser build's upstream base. Upstream
   keeps only its last five releases, so keep the zip of the one that
   matches (`halo-linux-release.zip`), and give the script its path once
   the tag is gone: `native_host.sh ~/halo-releases/build-74-halo-linux-release.zip`.
3. Join it, scripted, and log the page:

   ```
   node port/web/relay/test/drive.mjs "http://localhost:8765/?HALO_NETWORK_TEST=join&HALO_TEST_INPUT=bot:2&HALO_NETWORK_TEST_SHOOT=5#native=<invite>" 300 page.log
   ```

   or open `http://localhost:8765/#native=<invite>` in Chrome to play.
4. Compare: each machine logs every player's state each second
   (`network test: tick ...`): `docker logs -t halo-native-host` and
   `page.log`. The relay logs each page's round trip, its traffic, and the
   loss of the host's tunnel packets: `docker logs halo-relay`.
5. `port/web/relay/test/native_host.sh stop` removes the containers.

`limits.test.mjs` tests the relay's limits without Docker (it builds the
relay with Go, and makes its tokens with the Worker's code):
`node --test relay/test/limits.test.mjs` in `port/web`.

`probe_ports.mjs` checks the deployed relay after a deploy: for each
session, a token from the live Worker, a STUN round trip through the relay,
and datagrams from this machine in through the relay's public address and
the session's port. `node port/web/relay/test/probe_ports.mjs
https://openhaloce.com 32` (spaced for the Worker's 10 tokens a minute:
about 3½ minutes).

`walk.mjs` walks the game's menus as a player does, with keys and
screenshots (the PC menus' online screens). For example, the live site's
server browser, and into its first game (a game under way asks for JOIN
GAME again, on its preview):

```
node port/web/relay/test/walk.mjs https://openhaloce.com/ 40 click:640,300 \
  ArrowDown Enter wait:2 Enter wait:3 Enter wait:12 shot:list.png \
  ArrowRight Enter wait:8 Enter wait:40 shot:playing.png
```

(Multiplayer; Done, on a first visit's profile name; Server Browser; JOIN
GAME. Clicks do not reach the game's pointer in a headless Chrome: use the
keys.) On 2026-10-04 that joined a desktop build's public game of 18
players, through the Fly.io relay: about 45 datagrams and 37 KiB a second
from the host, none of its tunnel packets missing.

`drive.mjs` opens several pages in one browser with `|` between their
addresses, for the browsers' own test (`?net=tabs`, `NETWORK.md`,
"Testing").

The first spike (2026-10-03): 4½ minutes, both machines at the same
scores, kills and deaths (9/9/5 and 5/5/9), positions a median 0.4 world
units apart (sampled at slightly different times), 30 ticks a second; the
relay saw none of the host's 8,683 tunnel packets missing, about 30
packets and 11 KiB a second from the host and 5 KiB to it, and a round
trip to the page under 1 ms (both on one machine).
