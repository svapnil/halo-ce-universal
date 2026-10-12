"""
Sums a CPU profile of the game's thread (drive.mjs's PROFILE): the functions
with the most self and inclusive time, and the longest stretches in one function.

    python3 profile_summary.py run-page2.cpuprofile [functions to list]
"""
import json, sys, collections
p = json.load(open(sys.argv[1]))
nodes = {n["id"]: n for n in p["nodes"]}
parent = {}
for n in p["nodes"]:
    for c in n.get("children", []): parent[c] = n["id"]
def name(n):
    cf = nodes[n]["callFrame"]; return cf["functionName"] or "(anon)"
def stack(n):
    out = []
    while n in nodes:
        out.append(name(n)); n = parent.get(n)
        if n is None: break
    return out
samples, deltas = p["samples"], p["timeDeltas"]
total = sum(deltas) / 1000.0
self_t = collections.Counter(); incl_t = collections.Counter()
for s, d in zip(samples, deltas):
    self_t[name(s)] += d
    seen = set()
    for f in stack(s):
        if f not in seen: incl_t[f] += d; seen.add(f)
print(f"{len(samples)} samples, {total:.0f} ms")
print("-- top self time")
for f, t in self_t.most_common(int(sys.argv[2]) if len(sys.argv) > 2 else 25):
    print(f"{t/1000:8.0f} ms {100*t/1000/total:5.1f}%  {f}")
print("-- top inclusive time")
for f, t in incl_t.most_common(30):
    print(f"{t/1000:8.0f} ms {100*t/1000/total:5.1f}%  {f}")
# long stretches: consecutive samples in the same leaf/stack region exceeding 20 ms
print("-- stretches of >= 20 ms in one function (self)")
cur = None; acc = 0; start = 0; t = 0
runs = []
for s, d in zip(samples, deltas):
    f = name(s)
    if f == cur: acc += d
    else:
        if cur is not None and acc >= 20000: runs.append((acc, start, cur, stack(ls)[:6]))
        cur = f; acc = d; start = t
    ls = s; t += d
runs.sort(reverse=True)
for acc, start, f, st in runs[:25]:
    print(f"{acc/1000:7.0f} ms at {start/1000:8.0f} ms: {' < '.join(st)}")
