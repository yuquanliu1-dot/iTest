"""B-path cost model: what does 'add one more step' actually cost the user?"""
import json
from collections import defaultdict

calls = json.load(open('/tmp/e2e-data/calls.json'))
bysess = defaultdict(list)
for c in calls:
    bysess[c['file']].append(c)

rows = []
for f, cs in bysess.items():
    if len(cs) < 2:
        continue
    cs.sort(key=lambda c: c['ts'] or '')
    for i, c in enumerate(cs):
        if c['wall_ms'] is None:
            continue
        rows.append(dict(
            file=f, i=i, wall=c['wall_ms'] / 1000.0, steps=c['n_steps'],
            resume=c['resume_from'], reused=c['reused'], result=c['result'],
            first=(i == 0),
        ))

# rounds that carried a confirmed prefix (i.e. "I added a step to an existing case")
carry = [r for r in rows if isinstance(r['resume'], int) and r['resume'] > 0]
fresh = [r for r in rows if r['resume'] == 0]

def stats(rs, key='wall'):
    if not rs:
        return 'n=0'
    v = sorted(r[key] for r in rs)
    n = len(v)
    return 'n=%-3d p50=%5.0fs p90=%5.0fs mean=%5.0fs' % (
        n, v[n // 2], v[min(n - 1, int(n * .9))], sum(v) / n)

print('=== per-verify wall time (s) ===')
print('  all rounds        ', stats(rows))
print('  first round       ', stats([r for r in rows if r['first']]))
print('  confirmed-prefix  ', stats(carry))
print('  no-prefix (fresh) ', stats(fresh))
print()
print('  confirmed-prefix rounds by executed step count:')
agg = defaultdict(list)
for r in carry:
    agg[r['steps']].append(r['wall'])
for k in sorted(agg):
    v = sorted(agg[k])
    print('    steps=%-3d n=%-3d p50=%5.0fs' % (k, len(v), v[len(v) // 2]))
print()

# whole-session totals for multi-round sessions
print('=== multi-round session totals (the "build a 4-step case" journey) ===')
tot = []
for f, cs in bysess.items():
    if len(cs) < 2:
        continue
    w = sum(c['wall_ms'] or 0 for c in cs) / 1000.0
    tot.append((w, len(cs), sum(c['n_steps'] for c in cs), f))
tot.sort()
print('  sessions=%d  median total=%.0fs  p90=%.0fs  max=%.0fs' % (
    len(tot), tot[len(tot) // 2][0], tot[int(len(tot) * .9)][0], tot[-1][0]))
print('  (22min = 1320s baseline from prod228 10-23 single-case measurement)')
print()
print('  slowest 5 sessions:')
for w, n, st, f in tot[-5:]:
    print('    %7.0fs calls=%-3d steps=%-3d %s' % (w, n, st, f[:40]))
