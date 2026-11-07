"""Second pass: per-verify wall time, prefix replay, failure reasons."""
import json, os, glob
from collections import Counter, defaultdict

# 容器内只读拉取：docker exec itest-api-1 cat /repo/apps/api/.data/pi-sessions/<s>.jsonl
SESSIONS_DIR = os.environ.get('SESSIONS_DIR', '/tmp/e2e-data/sessions/pi-sessions')

FILES = sorted(glob.glob(os.path.join(SESSIONS_DIR, '*.jsonl')))

def ms(ts):
    if isinstance(ts, str):
        from datetime import datetime
        return datetime.strptime(ts.replace('Z', '+0000'), '%Y-%m-%dT%H:%M:%S.%f%z').timestamp() * 1000
    return ts

calls = []   # per verify_case invocation
for path in FILES:
    rows = [json.loads(l) for l in open(path) if l.strip()]
    # map toolCallId -> (name, ts of assistant msg)
    call_ts = {}
    for r in rows:
        if r.get('type') != 'message':
            continue
        m = r.get('message') or {}
        c = m.get('content')
        if not isinstance(c, list):
            continue
        for p in c:
            if isinstance(p, dict) and p.get('type') == 'toolCall':
                call_ts[p.get('id')] = (p.get('name'), ms(r.get('timestamp')))
    for r in rows:
        if r.get('type') != 'message':
            continue
        m = r.get('message') or {}
        if m.get('role') != 'toolResult' or m.get('toolName') != 'verify_case':
            continue
        c = m.get('content')
        txt = ''.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text') if isinstance(c, list) else (c or '')
        i = txt.find('{')
        if i < 0:
            continue
        try:
            obj = json.loads(txt[i:])
        except Exception:
            continue
        name, cts = call_ts.get(m.get('toolCallId'), (None, None))
        rts = ms(r.get('timestamp'))
        calls.append(dict(
            file=os.path.basename(path), ts=r.get('timestamp'),
            wall_ms=(rts - cts) if (cts and rts) else None,
            result=obj.get('result'), resume_from=obj.get('resumeFrom'),
            reused=bool(obj.get('browserReused')), trace_saved=bool(obj.get('traceSaved')),
            n_steps=len(obj.get('steps') or []),
            failure=obj.get('failure'),
            steps=[{'order': s.get('order'), 'status': s.get('status'), 'dur': s.get('durationMs'),
                    'err': (s.get('error') or '')[:120], 'brief': (s.get('brief') or '')[:50]}
                   for s in (obj.get('steps') or [])],
        ))

json.dump(calls, open('/tmp/e2e-data/calls.json', 'w'), ensure_ascii=False, indent=1)

ok = [c for c in calls if c['wall_ms']]
print('=== verify_case invocations: %d (with wall time: %d) ===' % (len(calls), len(ok)))
w = sorted(c['wall_ms'] for c in ok)
def pct(p):
    return w[min(len(w) - 1, int(len(w) * p))] / 1000.0
print('  wall time (s): p10=%.0f p25=%.0f p50=%.0f p75=%.0f p90=%.0f max=%.0f  mean=%.0f'
      % (pct(.10), pct(.25), pct(.50), pct(.75), pct(.90), w[-1] / 1000.0, sum(w) / len(w) / 1000.0))

wp = sorted(c['wall_ms'] for c in ok if c['result'] == 'passed')
def pctp(p):
    return wp[min(len(wp) - 1, int(len(wp) * p))] / 1000.0 if wp else 0
print('  passed-only (n=%d): p10=%.0f p50=%.0f p90=%.0f mean=%.0f'
      % (len(wp), pctp(.10), pctp(.50), pctp(.90), (sum(wp) / len(wp) / 1000.0) if wp else 0))

print()
print('=== prefix replay analysis (resumeFrom>0 means prefix was CONFIRMED) ===')
print('  %-14s %6s %8s %8s  %s' % ('resumeFrom', 'calls', 'n_steps', 'total', 'prefix_skipped?'))
agg = defaultdict(lambda: [0, 0, 0])
for c in calls:
    k = str(c['resume_from'])
    agg[k][0] += 1
    agg[k][1] += c['n_steps']
    agg[k][2] += 1 if c['n_steps'] else 0
for k in sorted(agg, key=lambda x: (x == 'None', x)):
    n, s, _ = agg[k]
    print('  %-14s %6d %8.1f' % (k, n, s / n))

print()
print('=== failure reasons (top 15) ===')
fc = Counter()
for c in calls:
    f = c['failure']
    if isinstance(f, dict):
        fc[str(f.get('reason') or f.get('type') or list(f.keys()))[:60]] += 1
    elif f:
        fc[str(f)[:60]] += 1
    else:
        for s in c['steps']:
            if s['status'] == 'failed':
                fc['step:' + (s['err'][:50])] += 1
for k, v in fc.most_common(15):
    print('  %4d  %s' % (v, k))

print()
print('=== sessions with >=2 verify calls (B-path multi-round case building) ===')
bysess = defaultdict(list)
for c in calls:
    bysess[c['file']].append(c)
multi = {k: v for k, v in bysess.items() if len(v) >= 2}
print('  sessions: %d   multi-round sessions: %d' % (len(bysess), len(multi)))
for k, v in sorted(multi.items(), key=lambda kv: -sum(c['wall_ms'] or 0 for c in kv[1]))[:6]:
    tot = sum(c['wall_ms'] or 0 for c in v) / 1000.0
    print('   %-42s calls=%d wall=%.0fs steps=%d reused=%d' % (
        k[:42], len(v), tot, sum(c['n_steps'] for c in v), sum(1 for c in v if c['reused'])))
