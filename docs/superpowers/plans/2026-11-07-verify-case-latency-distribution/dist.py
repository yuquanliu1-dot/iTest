"""Extract verify_case per-step durations from pi-sessions JSONL and print a distribution.

Buckets (per plan):
  <=110s   ~2 turns (protocol floor: action turn + screenshot-confirm turn)
  110-170s ~3 turns (confirm-dialog class is normal 3 turns)
  >170s   4+ turns (exploration / retry waste)
"""
import json, os, sys, glob
from collections import Counter, defaultdict

# 容器内只读拉取：docker exec itest-api-1 cat /repo/apps/api/.data/pi-sessions/<s>.jsonl
SESSIONS_DIR = os.environ.get('SESSIONS_DIR', '/tmp/e2e-data/sessions/pi-sessions')

FILES = sorted(glob.glob(os.path.join(SESSIONS_DIR, '*.jsonl')))

records = []   # (session_file, ts, case_id, result, resume_from, browser_reused, step)
verifies = []  # one per verify_case tool call

for path in FILES:
    try:
        rows = [json.loads(l) for l in open(path) if l.strip()]
    except Exception as e:
        print('SKIP %s: %s' % (path, e), file=sys.stderr)
        continue
    for r in rows:
        if r.get('type') != 'message':
            continue
        m = r.get('message') or {}
        if m.get('role') != 'toolResult':
            continue
        if m.get('toolName') != 'verify_case':
            continue
        c = m.get('content')
        if isinstance(c, list):
            txt = ''.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
        else:
            txt = c if isinstance(c, str) else ''
        s = txt.strip()
        i = s.find('{')
        if i < 0:
            continue
        try:
            obj = json.loads(s[i:])
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        steps = obj.get('steps') or []
        v = dict(
            file=os.path.basename(path),
            ts=r.get('timestamp'),
            case_id=obj.get('caseId'),
            result=obj.get('result'),
            resume_from=obj.get('resumeFrom'),
            browser_reused=bool(obj.get('browserReused')),
            trace_saved=bool(obj.get('traceSaved')),
            n_steps=len(steps),
            failure=(obj.get('failure') or {}).get('reason') if isinstance(obj.get('failure'), dict) else obj.get('failure'),
            steps=[dict(order=s.get('order'), status=s.get('status'), dur=s.get('durationMs'),
                        brief=(s.get('brief') or s.get('instruction') or '')[:40],
                        err=(s.get('error') or '')[:80]) for s in steps],
        )
        verifies.append(v)

json.dump(verifies, open('/tmp/e2e-data/verifies.json', 'w'), ensure_ascii=False, indent=1)

# ---- distribution over executed steps ----
all_steps = []
for v in verifies:
    for s in v['steps']:
        if s['dur'] is None:
            continue
        all_steps.append((v, s))

def bucket(d):
    if d <= 110_000: return 'a_<=110s (2 turns, floor)'
    if d <= 170_000: return 'b_110-170s (3 turns)'
    return 'c_>170s (4+ turns, waste)'

cnt = Counter()
status_cnt = Counter()
for v, s in all_steps:
    cnt[bucket(s['dur'])] += 1
    status_cnt[s['status']] += 1

print('=== verify_case calls: %d   executed steps with duration: %d ===' % (len(verifies), len(all_steps)))
print('--- per-step duration bucket ---')
tot = len(all_steps)
for k in sorted(cnt):
    print('  %-28s %4d  %5.1f%%' % (k, cnt[k], 100.0 * cnt[k] / tot if tot else 0))
print('--- per-step status ---')
for k, v in status_cnt.most_common():
    print('  %-12s %4d  %5.1f%%' % (k, v, 100.0 * v / tot if tot else 0))

# passed-only distribution (failed steps include retry waste + gateway flakes)
passed = [(v, s) for v, s in all_steps if s['status'] == 'passed']
print('--- PASSED-only bucket (n=%d) ---' % len(passed))
pc = Counter(bucket(s['dur']) for v, s in passed)
for k in sorted(pc):
    print('  %-28s %4d  %5.1f%%' % (k, pc[k], 100.0 * pc[k] / len(passed) if passed else 0))

# ---- per-verify totals ----
print('--- per-verify totals (sum of step durations) ---')
vt = []
for v in verifies:
    tot_ms = sum(s['dur'] for s in v['steps'] if s['dur'] is not None)
    vt.append((tot_ms, v))
vt.sort(key=lambda x: -x[0])
for tot_ms, v in vt[:12]:
    print('  %7.1fs  steps=%d result=%-8s resumeFrom=%-3s reused=%-5s %s %s' % (
        tot_ms / 1000.0, v['n_steps'], v['result'], v['resume_from'], v['browser_reused'],
        v['file'][:28], (v['failure'] or '')[:40]))

print('--- resumeFrom / browserReused across all verify calls ---')
print('  browserReused=true count: %d / %d' % (sum(1 for v in verifies if v['browser_reused']), len(verifies)))
print('  resumeFrom distribution:', Counter(v['resume_from'] for v in verifies))
print('  result distribution:', Counter(v['result'] for v in verifies))
