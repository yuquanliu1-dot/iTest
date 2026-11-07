"""Fine-grained per-step latency distribution (turn-count proxy)."""
import json, glob, os
from collections import Counter

calls = json.load(open('/tmp/e2e-data/calls.json'))
steps = []
for c in calls:
    for s in c['steps']:
        if s.get('dur') is None:
            continue
        steps.append((c, s))

def bucket(d):
    if d <= 20_000:  return 'a_<=20s   (1 turn, hot page)'
    if d <= 60_000:  return 'b_20-60s (1-2 turns)'
    if d <= 110_000: return 'c_60-110s (2 turns)'
    if d <= 170_000: return 'd_110-170s (3 turns)'
    return 'e_>170s   (4+ turns)'

for label, sel in (('ALL steps', steps),
                   ('PASSED steps', [x for x in steps if x[1]['status'] == 'passed']),
                   ('FAILED steps', [x for x in steps if x[1]['status'] == 'failed'])):
    cnt = Counter(bucket(s['dur']) for c, s in sel)
    tot = len(sel)
    print('=== %s (n=%d) ===' % (label, tot))
    for k in sorted(cnt):
        print('  %-26s %4d  %5.1f%%' % (k, cnt[k], 100.0 * cnt[k] / tot if tot else 0))
    print()

print('=== duration percentiles (all steps, ms) ===')
v = sorted(s['dur'] for c, s in steps)
n = len(v)
for p in (10, 25, 50, 75, 90, 95, 99):
    print('  p%-3d %8.1fs' % (p, v[min(n - 1, int(n * p / 100))] / 1000.0))
print('  max   %8.1fs' % (v[-1] / 1000.0))

print()
print('=== per-step duration by step ORDER (passed only) ===')
agg = {}
for c, s in steps:
    if s['status'] != 'passed':
        continue
    o = s.get('order')
    agg.setdefault(o, []).append(s['dur'])
for o in sorted(agg):
    x = sorted(agg[o])
    print('  order=%-3s n=%-4d p50=%5.1fs p90=%5.1fs' % (o, len(x), x[len(x) // 2] / 1000.0, x[int(len(x) * .9)] / 1000.0))
