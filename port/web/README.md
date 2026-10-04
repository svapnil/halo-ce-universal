# Web (WebAssembly)

`ninja web` builds the game for the browser: `build/web/halo.html`, with
`halo.js` and `halo.wasm`. This is an early build. It reaches the main menu,
which draws, animates, plays its music and takes keyboard input. Nothing past
the menu has been tried.

## Requirements

- [Emscripten](https://emscripten.org/) 4 or later, with `emcc` on the PATH
  (`brew install emscripten` on macOS). The option `--emcc` of `configure.py`
  selects a different one. The first build downloads and compiles SDL 3
  (Emscripten's `sdl3` port).
- Python, and ninja.
- [Node.js](https://nodejs.org/) 20 or later, for the server (Cloudflare's
  `wrangler`, which `npm install` installs).
- A browser with WebGL 2 and JavaScript Promise Integration (JSPI), for
  example Chrome 137 or later.
- An Xbox disc image of the game (`.xiso` or `.iso`), as for the other ports.

## Build and run

1. Go to the root folder of the repository.
2. Enter `python configure.py`.
3. Enter `ninja web`.
4. The first time only, enter `python tools/extract_maps.py <disc image>`.
   It copies `maps/` out of the disc image into `assets/maps` (approximately
   1.7 GB).
5. Go to the folder `port/web`.
6. The first time only:
   1. Enter `npm install`.
   2. Enter `npm run upload-maps`. It copies the maps into the local R2
      bucket of the server (in `port/web/.wrangler/state`, another 1.7 GB).
7. Enter `npm run dev`.
8. Open <http://localhost:8765/> and click the picture so that it takes the
   keyboard.

The server is a Cloudflare Worker (`worker/worker.js`, configured by
`wrangler.toml`), which `npm run dev` runs on the computer. It serves
`build/web` as its static assets, and the maps from an R2 bucket at
`maps/<name>.map`. A different server can be used if it does the same:

- The page needs the `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` headers. Without them the
  browser gives it no shared memory, so no threads.
- The server must answer HTTP range requests, and HEAD requests with
  `Content-Length` and `Accept-Ranges: bytes`. The game reads the maps from
  the server a chunk at a time.
- The game asks for `maps//<name>.map` (two slashes), which the server must
  take as `maps/<name>.map`.

### Deploy to Cloudflare

In the folder `port/web`:

1. Enter `npx wrangler login`.
2. The first time only:
   1. Enter `npx wrangler r2 bucket create open-halo-ce`.
   2. Enter `npm run upload-maps -- --remote`.
3. Enter `npm run deploy`. It publishes the worker and `build/web` at the
   addresses in `wrangler.toml` (`openhaloce.com`, `www.openhaloce.com`) and
   at `halo-web.<account>.workers.dev`. For a different account, change the
   `routes` and the bucket (`wrangler.toml` and `upload_maps.mjs`).

The maps are the game's data, which you may not give to other people. Keep a
deployment private, for example with Cloudflare Access on its address.

Settings: each `HALO_*` parameter of the page's address sets the environment
variable of the same name, which `port_config.c` reads. For example
<http://localhost:8765/?HALO_GL_DEBUG=1&HALO_GPU_STATS=1> logs the WebGL
errors and the draw counts in the console.

Saves: the game's save drives (`z:`, `u:` and `t:`: player profiles,
playlists, the checkpoint) and its settings (`config.toml`, which the
game's Settings change: the keys, the video, the audio) are kept in the browser's Origin Private File
System (`web_main.c`), so they are still there at the next visit. The site's
data in the browser's settings holds them; clearing it starts afresh. Where
the browser has no such storage (some private windows), the page says so and
the saves last for the visit only. A game joined from an invite link uses
player 1's last profile, so its name is the player's name online
(`web_lobby.c`).

The game's map cache (`z:\cacheNNN.map`, about 770 MB) is deliberately not
kept: it is rebuilt at each visit instead of filling the browser's storage,
and so it cannot go stale when the server's maps change. `web_main.c` says
how to keep it too, should that be wanted.

The page asks the player to confirm they own the original game before the
game loads (`App.jsx`). A Confirm is kept in the browser's `localStorage`,
so it is asked once; a Deny is not kept, and the game does not load.

## Design

WebAssembly (`wasm32`) has 32-bit pointers. Thus the game's structures, its
cache files and its saved games have the same layout as on the Xbox, as in
the 32-bit x86 Linux build. The browser build compiles the units of the Linux
build (`tools/web_build.py` reads the lists of `tools/linux_build.py`) with
the platform layer in `port/linux/src`. The source of the game is not
changed.

- **Memory.** WebAssembly memory is one flat array. At start-up,
  `xbox_memory.c` grows the heap past the Xbox window at `0x80000000`, so
  that the allocator never uses it, and the window is ordinary memory. The
  memory can grow to 4 GB.
- **Threads.** The game's `main` runs on a worker (`PROXY_TO_PTHREAD`), so it
  can block as it does on the desktop. It draws on the page's canvas from
  there (`OFFSCREENCANVAS_SUPPORT`).
- **Frames.** A worker shows what it drew only when it returns to the
  browser's event loop, which the game's loop never does. After each frame,
  `platform_video_swap` (`sdl_platform.c`) suspends the game until the
  browser's next frame (JSPI, `EM_ASYNC_JS`).
- **Graphics.** WebGL 2 is OpenGL ES 3.0. The renderer uses its OpenGL ES
  path, written for the Android port (`HALO_ANDROID` in `d3d8_gl.c` and its
  helpers). `port/web/src/web_gl.c` replaces the Android host's helpers. For
  WebGL:
  - the converted textures are swapped from BGRA to RGBA on the CPU, because
    WebGL has no texture swizzle;
  - the vertices of immediate-mode draws go in one array per attribute,
    because WebGL limits a stride to 255 bytes;
  - an occlusion query reports its result a frame late, because WebGL gives
    a result only after the frame.
  - the canvas is opaque (no alpha), because the game leaves 0 in the alpha
    of its back buffer in places, which would show the page through the
    picture;
  - the picture is scaled to the canvas's drawing buffer, whose size the
    page sets, not to SDL's window size.
  - each upload of streamed vertices or indices gets a buffer of its own
    (`web_upload_buffer` in `d3d8_gl.c`). In ANGLE, `bufferSubData` into a
    buffer that queued draws read copies the whole buffer first. With the
    16 MB stream buffer and a hundred uploads a frame, that limited the
    menu to approximately 14 frames a second.
- **Files.** The file system is WasmFS. `port/web/src/web_main.c` mounts
  `maps/` from the server with the fetch backend before the game's `main`
  (renamed `halo_main`) starts. A map is one zlib stream, so a map is
  downloaded completely before it loads: 14 MB for the menu, approximately
  20 MB for a multiplayer map, and 77 to 187 MB for a campaign level.
- **Texture changes.** The desktop builds see the game write to a texture
  when the write faults on a protected page (`memory_watch.c`). WebAssembly
  has no page protection, so `memory_watch.c` compares a sample of a
  texture's memory (its first and last 256 bytes and 512 words across the
  rest) with the sample of the last upload. A texture is uploaded again only
  when its sample changes.
- **Time.** The browser's monotonic clock counts from 1970. `GetTickCount`
  counts from the start of the game, as the Xbox counts from boot, because
  the game keeps milliseconds in `long` and `float` variables.

### Calls with incorrect types

WebAssembly compares the type of each call with the type of the function,
and stops the program if they are different. x86 and AArch64 do not examine
the types. A small number of calls in the game source have incorrect types.
`tools/web_build.py` renames these calls in the units that make them
(`WEB_GAME_RENAMES`) to functions in `port/web/src/web_game_shims.c`, which
make the calls with the correct types. `include/halo_web_fixups.h` lets
`va_start` accept the game's `char *` argument lists. If the game stops with
`RuntimeError: function signature mismatch` or `unreachable`, the cause is
probably a call that is not yet in the list. The stack in the console shows
the call.

Known calls that are not yet corrected:

- The callbacks of the "stub" game engine (`game_engine_stub.c`), which the
  game does not use.
- `csprintf` in an assertion message (`debug_memory.c`).
- `lseek` and `debug_free` in libtiff, which the game does not use.

## Not done

- Saved games and settings are kept in memory only (`/home/web_user`), and
  are lost when the page closes. They need the browser's storage (OPFS).
- Network play with the desktop builds. Browsers play system link games
  with each other through Cloudflare Realtime SFU: the host's page shows an
  invite to copy. Refer to [NETWORK.md](NETWORK.md).
- Importing the game data in the page from a disc image. `xiso.c` can do it.
- Game controllers and the mouse were not tried.
- Only Chrome was tried.
