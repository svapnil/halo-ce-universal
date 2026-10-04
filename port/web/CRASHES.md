# Crashes in the browser build

How the game fails in a page, what the page does about each way, and how to
read the reports it sends. The desktop builds are at the end.

## The ways it fails

| What happens | What the player saw before | What it is | Now |
| --- | --- | --- | --- |
| The tab closes, or reloads | The same | **A key.** Ctrl is crouch and W is forward: Ctrl+W closes a tab (Windows, Linux). Ctrl+R (crouch, reload) reloads the page; Ctrl+T, Ctrl+N, Ctrl+Tab, Ctrl+1 are as near | Kept from the browser where a page can (`app/src/keys.js`); refer to "Keys" |
| The game's thread traps | The picture freezes, with a line of error under it | An abort, an `unreachable`, memory out of bounds, a call of the wrong type (WebAssembly checks what x86 does not) | "The game crashed", reported with its stack |
| The game's memory runs out | The same, at whatever asked for memory next | The heap cannot pass 4 GB; refer to "Memory" | Reported; the report has the heap's numbers |
| The game hangs | The picture freezes, with nothing said | A loop that does not end, or a thread that died silently | "The game stopped responding" after 30 s, reported |
| The browser ends the page | The tab says it crashed ("Aw, Snap"), or is reloaded, or is gone | The page's process was killed: out of memory in the browser's count, or the browser's own fault | Reported at the next visit ("killed"), and by Chrome itself ("browser-crash", with its reason) |
| The graphics go | A black or frozen picture | The browser's GPU process or the graphics driver failed: the WebGL context is lost | "The game lost its graphics", reported |
| An assertion fails | Nothing (a release build carries on past it) | The game's own checks, noted in its `debug.txt`, which in a page is in memory | The end of `debug.txt` is in every report |
| Quit, in the menus | The picture freezes | The game's main returned | "The game was quit", with Reload (not reported) |

## Keys

A page may stop most of the browser's shortcuts, but not Ctrl+W, Ctrl+T,
Ctrl+N and Ctrl+Tab in a tab. So (`app/src/keys.js`):

- every key pressed on the game's canvas is kept from the browser (but the
  Command key's own, and F12);
- in fullscreen the page asks for the keys of those shortcuts (W, T, N, Q:
  the Keyboard Lock API, in Chrome and Edge), and for Esc, which then is
  the game's (its pause menu). **Playing in fullscreen is the whole
  cure.** Leaving fullscreen: F11, the page's button, Esc held, or another
  window (Alt+Tab is left to the system: Tab is not asked for, so Ctrl+Tab
  still changes tabs), which also lets the mouse go;
- out of fullscreen, while a game is being played, the browser asks before
  the page closes or reloads ("Leave site?"). Ctrl+W then interrupts the
  game with a question, and does not end it.

Not done: another crouch key by default in the browser (Left Ctrl is the
desktop's, `controls.crouch`; Settings > Controls Setup changes it, and the
browser keeps `config.toml`).

## Memory

WebAssembly's memory is 32-bit: 4 GB at most. The heap starts past the Xbox
window at 0x80000000 (`port/linux/src/xbox_memory.c`), so about 2 GB below
it is never used, and at the main menu the heap is already 3,067 MB (779 MB
of it in malloc's hands, most of it the map cache, `z:\cacheNNN.map`, in
memory). Measured (`?crashtest=oom`): **1,141 MB more** can be had, and no
more. Then the next allocation fails, and the game aborts wherever that is
(a font's, in the test).

Playing does not use it up: the heap was the same before, in and after
games on two maps (3,067 MB, 778 MB in use), and the browser's processes
stayed near 300 MB (the page) and 230 MB (the GPU) through four minutes
of a public game. So memory is not the usual cause of a crash; a report's numbers say
when it was.

## What is captured

`src/web_crash.c` keeps a block of the game's memory that the page reads
without calling the game (which may be what died): the frame count, the
heap's numbers, the end of `debug.txt`, whether the WebGL context is lost,
and the stack of the error that ended a thread (`src/web_pre.js` writes it
from the thread: the page only gets a line number otherwise).

`app/src/crash.js` keeps the latest 400 lines the game printed, and what
the page saw happen (the network's states, joins). When the game stops it
shows a panel (`CrashPanel.jsx`) and sends a report:

| `kind` | When |
| --- | --- |
| `exception` | A trap or abort in the game, with the thread's stack |
| `hang` | No frame for 30 s, the page in view |
| `context-lost` | The WebGL context lost |
| `killed` | Sent by the next visit: the page before ended without its `pagehide`. A journal of each session is kept in `localStorage` every 3 s for this |
| `error` | An error of the page's own script (the game goes on) |
| `browser-crash` | Chrome's own report of a page it ended, with `reason` (`oom`, `unresponsive`): the Reporting API, which the site's `Reporting-Endpoints` header asks for |

A report holds the build (the commit), the browser, the time played, the
heap, the page's marks, the end of `debug.txt` and of the log, and no name:
addresses and invites in the log are cut short. Each page sends 3 at most.

`worker/crash.js` takes them (`POST /net/crash`, `/net/reports`): only from
the site's own pages, 10 a minute an address, 256 KiB at most, kept 30 days
in the KV namespace `CRASHES`.

## Reading them

```
npm run crashes              # the list: time, kind, browser, country, build, message
npm run crashes -- 7         # the seventh, in full
npm run crashes -- --local   # those of `npm run dev`
```

A stack names the game's functions (the build keeps their names). The
`build` is the commit to look in; a `+` after it says the tree had changes.

## Logs for debugging

- `?debug` on any build: the whole log is kept (20,000 lines), the heap's
  numbers are logged every 10 s, and the bar has **Save log**, which saves
  all of it as a file, with the visit before if that ended without
  warning. The crash panel has Save log on every build.
- A build that stops at a failed assertion, and says which: configure
  without `--release` (`python configure.py`, then `ninja web`). Its
  assertions are checked, and Emscripten's too (`-sASSERTIONS=1`); the
  failure is reported as an `exception` with the assertion's text and
  place. Run it with `npm run dev`; a release build only notes them in
  `debug.txt` (whose end is in each report).
- `?HALO_CONSOLE_LOG=all` shows every line of the game's log on its own
  console (the \` key).

## Testing

`?crashtest=trap`, `abort`, `hang` or `oom` makes that failure 15 seconds in
(`web_crash.c`), to see it reported; `relay/test/walk.mjs`'s `crashpage`
ends the page's process, and a visit after it reports `killed`. All five,
and the question before leaving a game, were seen to work with `npm run
dev` (2026-10-04).

## The desktop builds

Upstream's, not this fork's, but for what was asked of them:

- A crash writes its report (the faulting address and the calls that led
  to it) to `debug.txt` in the data folder (`port/linux/src/memory_watch.c`,
  `port/windows/src/win32_memory_watch.c`), and nowhere else: a player has
  to send the file. Upstream's issues are closed, so reports are not public.
- A release build carries on past failed assertions (`cseries.c`), noting
  them in `debug.txt`: a later crash may be far from its cause.
- A blue screen is not the game's own fault to make: a program cannot stop
  Windows, a driver can. The graphics driver is the one the game drives
  hard; upstream has two workarounds for drivers already (a GPU never left
  idle hanging Intel's Raptor Lake graphics, and Mesa Intel needing a flush
  every 3 draws: `sdl_platform.c`, `d3d8_gl.c`). In a browser the same
  failure costs the WebGL context (`context-lost`), not the machine.
