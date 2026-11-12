import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { LLMClient } from '../src/agent/llm-client.js';
import { resolveCodeScope, parseIntentValue, extractHintUrls } from '../src/execute/codeScope.js';

// LLM stub: every completeJson call returns the same intent JSON (explicit sha-range/single-commit paths need no disambiguation,
// and the stub being called repeatedly is harmless). The throwing stub exercises resolveCodeScope's soft-failure path.
const llmStub = (intent: Record<string, unknown>): LLMClient =>
  ({ complete: async () => ({ kind: 'json' as const, value: intent }) }) as unknown as LLMClient;
const llmBoom = (): LLMClient =>
  ({ complete: async () => { throw new Error('网关 503'); } }) as unknown as LLMClient;

const DAY = 86_400_000;
/** Same format as codeScope.ts toGitTs: git author/committer dates as explicit local-timezone timestamps (avoids bare-date boundary ambiguity). */
const gitDate = (daysAgo: number): string => {
  const d = new Date(Date.now() - daysAgo * DAY);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T10:00:00`;
};

let parent: string;
let root: string;
let sha1: string;
let sha2: string;
let sha3: string;

beforeAll(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-code-scope-'));
  root = path.join(parent, 'repo');
  await fs.mkdir(root);
  const gitAt = (daysAgo: number, cmd: string): void => {
    execSync(cmd, {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_DATE: gitDate(daysAgo), GIT_COMMITTER_DATE: gitDate(daysAgo) },
    });
  };
  gitAt(999, 'git init -b main .');
  gitAt(999, 'git config user.email t@t');
  gitAt(999, 'git config user.name t');
  await fs.writeFile(path.join(root, 'app.ts'), 'const a = 1;\nexport default a;\n');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'routes.ts'), "path:'/asset/list'\npath:'/login'\n");
  gitAt(40, 'git add -A'); // c1: outside the (30-day) window
  gitAt(40, "git commit -q -m 'c1 初始路由'");
  sha1 = execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
  await fs.writeFile(path.join(root, 'src', 'routes.ts'), "path:'/asset/list'\npath:'/login'\npath:'/asset/detail'\n");
  gitAt(10, 'git add -A'); // c2: inside the window
  gitAt(10, "git commit -q -m 'c2 资产详情路由'");
  sha2 = execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
  await fs.writeFile(path.join(root, 'app.ts'), 'const a = 2;\nexport default a;\n');
  gitAt(2, 'git add -A'); // c3: inside the window
  gitAt(2, "git commit -q -m 'c3 调整应用入口'");
  sha3 = execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
});

afterAll(async () => {
  await fs.rm(parent, { recursive: true, force: true });
});

// sessionId is a random uuid: persisting is best-effort (the test DB has no such row; a 0-row UPDATE doesn't error)
const run = (charter: string, llm: LLMClient, repoDir: string = root) =>
  resolveCodeScope({ sessionId: randomUUID(), charter, versionId: '00000000-0000-0000-0000-000000000000' }, {
    repoDir,
    deepen: async () => sha3,
    llm,
  });

describe('resolveCodeScope', () => {
  it('charter 无提交语义 → none，且不碰 git（repoDir 不存在也照常返回 none）', async () => {
    const r = await run('探索登录页的异常提示与表单校验行为', llmStub({ intent: 'none', confidence: 0.9, reason: '与提交历史无关' }), path.join(parent, 'no-such-repo'));
    expect(r.status).toBe('none');
    expect(r.scope).toBeUndefined();
  });

  it('最近 30 天 → 窗口内提交纳入、窗口外排除、基线正确', async () => {
    const r = await run('探索最近30天提交的功能', llmStub({ intent: 'time_window', sinceDays: 30, confidence: 0.9, reason: '章程要求最近 30 天' }));
    expect(r.status).toBe('resolved');
    const s = r.scope!;
    expect(s.kind).toBe('time_window');
    expect(s.fromSha).toBe(sha1); // baseline = last commit before the window
    expect(s.toSha).toBe(sha3);
    expect(s.commits.map((c) => c.subject)).toEqual(['c3 调整应用入口', 'c2 资产详情路由']); // git log newest -> oldest
    expect(s.files.map((f) => f.path).sort()).toEqual(['app.ts', 'src/routes.ts']);
    expect(s.hintUrls).toContain('/asset/detail');
    expect(s.label).toBe('最近 30 天');
  });

  it('显式 sha 区间 → 端点正确、只含区间改动', async () => {
    const r = await run(`探索 ${sha1.slice(0, 7)} 到 ${sha2} 之间的改动`, llmStub({ intent: 'commit_range', fromHint: sha1.slice(0, 7), toHint: sha2, confidence: 0.9, reason: '章程给了 sha 区间' }));
    expect(r.status).toBe('resolved');
    const s = r.scope!;
    expect(s.kind).toBe('commit_range');
    expect(s.fromSha).toBe(sha1);
    expect(s.toSha).toBe(sha2);
    expect(s.commits.map((c) => c.subject)).toEqual(['c2 资产详情路由']);
    expect(s.files).toEqual([{ path: 'src/routes.ts', status: 'M', additions: 1, deletions: 0 }]);
  });

  it('单提交 → 只含该提交与它的改动（基线 = 父提交）', async () => {
    const r = await run(`探索提交 ${sha2} 引入的问题`, llmStub({ intent: 'single_commit', commitHint: sha2, confidence: 0.9, reason: '章程点名单提交' }));
    expect(r.status).toBe('resolved');
    const s = r.scope!;
    expect(s.kind).toBe('single_commit');
    expect(s.commitSha).toBe(sha2);
    expect(s.fromSha).toBe(sha1);
    expect(s.toSha).toBe(sha2);
    expect(s.commits).toHaveLength(1);
    expect(s.files).toEqual([{ path: 'src/routes.ts', status: 'M', additions: 1, deletions: 0 }]);
  });

  it('编造的 sha → failed（加深重试后仍不存在，不把编造 sha 当真）', async () => {
    const r = await run('探索 abc1234 到 def5678 的改动', llmStub({ intent: 'commit_range', fromHint: 'abc1234', toHint: 'def5678', confidence: 0.9, reason: '章程给了 sha' }));
    expect(r.status).toBe('failed');
    expect(r.scope).toBeUndefined();
  });

  it('LLM 抛错/超时 → failed（软失败，不掀翻会话）', async () => {
    const r = await run('探索最近一周提交的功能', llmBoom());
    expect(r.status).toBe('failed');
    expect(r.scope).toBeUndefined();
  });

  it('按时间加深失败（浅边界早于窗口起点）→ 回退按提交数加深，照常解析', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const r = await resolveCodeScope(
      { sessionId: randomUUID(), charter: '探索最近30天提交的功能', versionId: '00000000-0000-0000-0000-000000000000' },
      {
        repoDir: root,
        deepen: async (bounds) => {
          calls.push(bounds as unknown as Record<string, unknown>);
          if ('since' in bounds) throw new Error('fatal: error processing shallow info: 4');
          return sha3;
        },
        llm: llmStub({ intent: 'time_window', sinceDays: 30, confidence: 0.9, reason: '章程要求最近 30 天' }),
      },
    );
    expect(r.status).toBe('resolved');
    expect(calls).toEqual([{ since: expect.any(String) }, { depth: 500 }]);
    expect(r.scope!.commits.map((c) => c.subject)).toEqual(['c3 调整应用入口', 'c2 资产详情路由']);
    expect(r.scope!.reason).toContain('按提交数加深');
  });

  it('加深始终失败 → failed（回退重试后仍失败，不掀翻会话）', async () => {
    const r = await resolveCodeScope(
      { sessionId: randomUUID(), charter: '探索最近30天提交的功能', versionId: '00000000-0000-0000-0000-000000000000' },
      {
        repoDir: root,
        deepen: async () => {
          throw new Error('network down');
        },
        llm: llmStub({ intent: 'time_window', sinceDays: 30, confidence: 0.9, reason: '章程要求最近 30 天' }),
      },
    );
    expect(r.status).toBe('failed');
    expect(r.scope).toBeUndefined();
  });

  it('意图别名容错：type/days/from·to、中文意图值', () => {
    expect(parseIntentValue({ type: 'time_window', days: '30' })).toMatchObject({ kind: 'time_window', sinceDays: 30 });
    expect(parseIntentValue({ 意图: '无关' }).kind).toBe('none');
    expect(parseIntentValue({ kind: '时间窗口', sinceDate: '2026-01-01', untilDate: '2026-01-31' }).kind).toBe('time_window');
    expect(parseIntentValue({ mode: 'commit_range', from: 'abc123', to: 'def456' })).toMatchObject({ kind: 'commit_range', fromHint: 'abc123', toHint: 'def456' });
    expect(parseIntentValue({ intent: 'single_commit', sha: 'feed000' })).toMatchObject({ kind: 'single_commit', commitHint: 'feed000' });
    expect(parseIntentValue({ intent: '莫名其妙' }).kind).toBe('none'); // unknown values are not guessed
  });

  it('extractHintUrls：抽路由字面量、滤静态资源与系统路径', () => {
    const urls = extractHintUrls([
      { path: 'src/routes.ts', content: "path:'/asset/list'\nurl: \"/login\"\nicon: 'logo.png'\nchunk: '/static/vendor.js'\n" },
      { path: 'README.md', content: '见 /usr/local/share/doc 说明\n入口：`/asset/detail`\n' },
      { path: 'logo.png', content: "path:'/should-not-appear'\n" },
    ]);
    expect(urls).toEqual(['/asset/list', '/login', '/asset/detail']);
  });
});
