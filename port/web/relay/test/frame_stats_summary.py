"""
Sums the frame statistics a page logged (?HALO_FRAME_STATS=1, port/web/README.md)
from a drive.mjs log: each page in a game, its frames and ticks a second, the
seconds with long frames, and the long frames themselves with what they held.

    python3 frame_stats_summary.py page.log [long frames to list]
"""
import re, sys, collections
log = open(sys.argv[1]).read().splitlines()
pages = collections.defaultdict(lambda: {"sec": [], "long": [], "tasks": [], "late": [], "own": [], "shaders": 0, "shader_ms": 0.0, "textures": 0, "corr": None})
start = {}
for line in log:
    m = re.match(r'\[(\S+)\] (page \d+) (\w+): (.*)', line)
    if not m: continue
    t, page, kind, text = m.groups()
    P = pages[page]
    if "network test: game" in text and page not in start: start[page] = t
    if page not in start: continue   # before the game
    if text.startswith("web stats: ") and " frames in " in text:
        f = re.search(r'(\d+) frames in (\d+) ms: work avg ([\d.]+) max ([\d.]+), swap avg ([\d.]+) max ([\d.]+), wait avg ([\d.]+) max ([\d.]+) ms; (\d+) ticks; (\d+) long, (\d+) on the timer', text)
        P["sec"].append((t,) + tuple(float(x) for x in f.groups()))
    elif text.startswith("web stats: long frame"):
        P["long"].append((t, text[len("web stats: "):]))
    elif text.startswith("web stats: shaders"):
        f = re.search(r'shaders (\d+) \(([\d.]+) ms\), textures (\d+).*corrections (\d+)(?:, own (\d+)(.*))?', text)
        P["shaders"] += int(f.group(1)); P["shader_ms"] += float(f.group(2)); P["textures"] += int(f.group(3))
        P["corr"] = (t, int(f.group(4)), f.group(5), (f.group(6) or "").strip())
        if f.group(5) is not None:
            P["own"].append((t, int(f.group(5)), (f.group(6) or "").strip()))
    elif "main thread long task" in text:
        P["tasks"].append((t, text))
    elif "timer late" in text:
        P["late"].append((t, text))
for page, P in sorted(pages.items()):
    if not P["sec"]: continue
    frames = sum(s[1] for s in P["sec"]); secs = len(P["sec"])
    print(f"== {page}: game from {start[page]}, {secs} s, {frames:.0f} frames ({frames/secs:.1f}/s), ticks {sum(s[9] for s in P['sec'])/secs:.1f}/s")
    print(f"   work avg {sum(s[3] for s in P['sec'])/secs:.1f} ms; seconds with work max >25: {sum(1 for s in P['sec'] if s[4]>25)}, >50: {sum(1 for s in P['sec'] if s[4]>50)}, >100: {sum(1 for s in P['sec'] if s[4]>100)}; wait max >40: {sum(1 for s in P['sec'] if s[8]>40)}; timer frames {sum(s[11] for s in P['sec']):.0f}")
    print(f"   long frames {sum(s[10] for s in P['sec']):.0f}; shaders {P['shaders']} ({P['shader_ms']:.0f} ms), textures {P['textures']}; corrections at end {P['corr']}")
    print(f"   main thread long tasks: {len(P['tasks'])}; timer late: {len(P['late'])}")
    for t, text in P["long"][:int(sys.argv[2]) if len(sys.argv) > 2 else 12]:
        print("   ", t, text)
    for t, text in P["tasks"][:8]: print("   ", t, text)
    last = None
    for t, n, rest in P["own"]:
        if n != last: print("    own corrections", t, n, rest); last = n
