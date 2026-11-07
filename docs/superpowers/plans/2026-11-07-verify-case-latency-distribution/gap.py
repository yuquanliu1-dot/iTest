"""Was there ever a valid keep-alive reuse window? gap analysis per case/thread."""
import json
from collections import defaultdict

calls = json.load(open('/tmp/e2e-data/calls.json'))
byfile = defaultdict(list)
for c in calls:
    byfile[c['file']].append(c)

TTL_MIN = 20.0

rows = []
for f, cs in byfile.items():
    cs.sort(key=lambda c: c['ts'] or '')
    for i in range(1, len(cs)):
        prev, cur = cs[i - 1], cs[i]
        if not prev['ts'] or not cur['ts']:
            continue
        # ISO timestamps
        import datetime as dt
        t0 = dt.datetime.fromisoformat(prev['ts'].replace('Z', '+00:00'))
        t1 = dt.datetime.fromisoformat(cur['ts'].replace('Z', '+00:00'))
        gap = (t1 - t0).total_seconds() / 60.0
        rows.append(dict(
            file=f, gap=gap,
            prev_result=prev['result'], cur_result=cur['result'],
            prev_steps=prev['n_steps'], cur_resume=cur['resume_from'],
            cur_reused=cur['reused'],
            prev_applied=prev.get('applied', prev['n_steps']),
        ))

print('=== consecutive same-case round pairs: n=%d ===' % len(rows))
within = [r for r in rows if r['gap'] <= TTL_MIN]
print('pairs within TTL(20min): %d (%.1f%%)' % (len(within), 100.0 * len(within) / len(rows)))
print()

print('=== of pairs within TTL, broken down by prev_round_result ===')
byres = defaultdict(list)
for r in within:
    byres[r['prev_result']].append(r)
for k, v in sorted(byres.items()):
    print('  prev=%-8s n=%-4d  cur_reused=true: %d' % (k, len(v), sum(1 for x in v if x['cur_reused'])))
print()

print('=== pairs where prev PASSED and gap<=TTL (the only rows where reuse was possible) ===')
cand = [r for r in within if r['prev_result'] == 'passed']
print('  n=%d' % len(cand))
for r in cand[:40]:
    print('   gap=%6.1fmin  cur_resume=%-4s cur_reused=%-5s  file=%s' % (
        r['gap'], r['cur_resume'], r['cur_reused'], r['file'][:44]))
print()

print('=== gap distribution (all consecutive pairs) ===')
g = sorted(r['gap'] for r in rows)
n = len(g)
for p in (10, 25, 50, 75, 90):
    print('  p%-3d %8.1f min' % (p, g[min(n - 1, int(n * p / 100))]))
print('  max   %8.1f min' % g[-1])
