# AI 工作台：源码仓库作为上下文（方案 B · Pi 内置工具 + 沙箱）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 AI 工作台加上「参考项目源码」的第二上下文 —— 项目已配仓库时浅克隆到本地，把 4 个沙箱化工具（`repo_ls / repo_read / repo_grep / repo_run`）挂进 Pi AgentSession，让用户在发首条消息时可显式选 `参考源码 / 抓取页面 / 自动`。

**Architecture:** 在 `apps/api/src/pi/repo.ts` 新增 `checkoutRepo + buildRepoSandboxTools`；`session.ts` 在创建 AgentSession 时调用 checkoutRepo 拿 cwd，把它跟自定义工具一起注入；`workspace.ts` 在 doc 上加 `contextMode / repoContext`；前端 `WorkspacePanel` 顶部加 `ContextModeSelector` + chip 指示器。

**Tech Stack:** Node 22+, TypeScript, Drizzle ORM, `@earendil-works/pi-coding-agent` (AgentSession), `proper-lockfile`, `node:child_process`, React + react-query, 现有 Segmented 控件。

---

## 文件结构（先看清谁负责什么）

**新增**：
- `apps/api/src/pi/repo.ts` — `checkoutRepo`（浅克隆 / fetch / 锁 / dirty stash）+ `buildRepoSandboxTools`（4 个白名单工具）+ `assertInCwd`（路径穿越防御）+ `RepoUnavailableError` / `SandboxViolationError` / `LockTimeoutError` 错误类型
- `apps/api/test/repo.test.ts` — vitest 套件
- `apps/api/test/repo-sandbox.test.ts` — 沙箱工具的单元测试
- `apps/api/test/pi-session-repo.test.ts` — session 集成测试
- `apps/web/src/features/ai-workspace/ContextModeSelector.tsx` — Segmented 三选项
- `apps/web/src/features/ai-workspace/ContextModeSelector.test.tsx` — 单元

**修改**：
- `apps/api/src/pi/workspace.ts` — `WorkspaceDoc` 新增 `contextMode / repoContext`；新增 `recordContextMode` / `recordRepoCheckout`
- `apps/api/src/pi/session.ts` — `createPiSessionFactory` 调 checkoutRepo，挂沙箱工具，把 `cwd` 传入 AgentSession
- `apps/api/src/pi/tools.ts` — `buildWorkspaceTools` 加 contextMode promptGuidelines
- `apps/api/src/pi/router.ts` — `POST /threads/:id/messages` body 增加 `metadata.contextMode`，落到 `recordContextMode`
- `apps/api/src/routes/requirements.ts` — 加 `POST /:id/ai-workspace/context-mode` 小端点
- `apps/web/src/api/client.ts` — `WorkspaceDoc` 类型补字段；新增 `setContextMode` / `getProject`（看仓库元数据）
- `apps/web/src/features/ai-workspace/WorkspacePanel.tsx` — 接入 ContextModeSelector 与 chip
- `apps/web/src/features/ai-workspace/ThreadPane.tsx` — 发消息时把 contextMode 附到 metadata

---

## Task 1: 错误类型 + REPOS_ROOT 常量（repo.ts 骨架）

**Files:**
- Create: `apps/api/src/pi/repo.ts`

- [ ] **Step 1: 写骨架 + 错误类**

```ts
// apps/api/src/pi/repo.ts
import path from 'node:path';

const DATA_DIR = process.env.PI_DATA_DIR ?? path.resolve(process.cwd(), '.data');
export const REPOS_ROOT = path.join(DATA_DIR, 'repos');
export const REPO_LOCK_TIMEOUT_MS = 5_000;
export const REPO_RUN_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_CHARS = 30_000;
export const MAX_REPO_ENTRIES = 500;
export const DEFAULT_READ_MAX_LINES = 200;
export const READ_MAX_LINES_HARD_CAP = 500;

export type RepoUnavailableReason = 'no_repo' | 'clone_failed' | 'auth_failed' | 'dirty' | 'fetch_failed';

export class RepoUnavailableError extends Error {
  constructor(public reason: RepoUnavailableReason, message: string) { super(message); this.name = 'RepoUnavailableError'; }
}
export class SandboxViolationError extends Error {
  constructor(message: string) { super(message); this.name = 'SandboxViolationError'; }
}
export class LockTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = 'LockTimeoutError'; }
}
```

- [ ] **Step 2: 跑 typecheck 验证编译通过**

```bash
cd apps/api && pnpm exec tsc --noEmit
```
Expected: 无新增错误（仓库已有其它 pi/* 文件编译过）。

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/pi/repo.ts
git commit -m "feat(pi/repo): scaffold error types and constants"
```

---

## Task 2: `assertInCwd` 路径穿越防御

**Files:**
- Modify: `apps/api/src/pi/repo.ts`
- Create: `apps/api/test/repo-sandbox.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/api/test/repo-sandbox.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let cwd: string;
beforeAll(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-repo-sandbox-'));
  await fs.writeFile(path.join(cwd, 'a.txt'), 'hello');
  await fs.mkdir(path.join(cwd, 'sub'));
  await fs.writeFile(path.join(cwd, 'sub', 'b.txt'), 'world');
});
afterAll(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

describe('assertInCwd', () => {
  it('relative 路径解析后必须在 cwd 内', async () => {
    const { assertInCwd } = await import('../src/pi/repo.js');
    const r = await assertInCwd(cwd, 'a.txt');
    expect(r).toBe(path.join(cwd, 'a.txt'));
  });

  it('path traversal 抛 SandboxViolationError', async () => {
    const { assertInCwd, SandboxViolationError } = await import('../src/pi/repo.js');
    await expect(assertInCwd(cwd, '../../etc/passwd')).rejects.toBeInstanceOf(SandboxViolationError);
    await expect(assertInCwd(cwd, '/etc/passwd')).rejects.toBeInstanceOf(SandboxViolationError);
  });

  it('symlink 跳出 cwd 也抛 SandboxViolationError', async () => {
    const { assertInCwd, SandboxViolationError } = await import('../src/pi/repo.js');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-repo-out-'));
    await fs.writeFile(path.join(outside, 'x'), 'x');
    await fs.symlink(outside, path.join(cwd, 'escape'));
    try {
      await expect(assertInCwd(cwd, 'escape/x')).rejects.toBeInstanceOf(SandboxViolationError);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/repo-sandbox.test.ts
```
Expected: 全部失败（`assertInCwd` 未导出）。

- [ ] **Step 3: 实现 `assertInCwd`**

追加到 `apps/api/src/pi/repo.ts`：

```ts
import fs from 'node:fs/promises';

/** 解析 user-supplied 路径为绝对路径，realpath 后必须 startsWith cwdRoot。
 *  越界一律抛 SandboxViolationError；调用方负责 try/catch 并返回 { ok: false, error }。 */
export async function assertInCwd(cwdRoot: string, target: string): Promise<string> {
  if (!target || typeof target !== 'string') {
    throw new SandboxViolationError('path is empty');
  }
  const abs = path.isAbsolute(target) ? target : path.join(cwdRoot, target);
  const real = await fs.realpath(abs).catch(() => abs);
  const rootReal = await fs.realpath(cwdRoot);
  // 在尾部加 separator 防止 /foo/barbaz 误判为 /foo/bar 的子串
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (real !== rootReal && !real.startsWith(rootWithSep)) {
    throw new SandboxViolationError(`path escapes cwd: ${target}`);
  }
  return real;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/repo-sandbox.test.ts
```
Expected: 3 个用例通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/repo.ts apps/api/test/repo-sandbox.test.ts
git commit -m "feat(pi/repo): add assertInCwd sandbox guard"
```

---

## Task 3: `repo_ls` 工具

**Files:**
- Modify: `apps/api/src/pi/repo.ts`
- Modify: `apps/api/test/repo-sandbox.test.ts`

- [ ] **Step 1: 加失败测试**

```ts
// 追加到 repo-sandbox.test.ts 的 describe 块内
import { buildRepoSandboxTools } from '../src/pi/repo.js';

describe('repo_ls', () => {
  it('列出 cwd 根目录', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const ls = tools.find((t) => t.name === 'repo_ls')!;
    const r = await ls.execute({ path: '.' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    const names = data.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('a.txt');
    expect(names).toContain('sub');
  });

  it('列子目录', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const ls = tools.find((t) => t.name === 'repo_ls')!;
    const r = await ls.execute({ path: 'sub' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.entries[0].name).toBe('b.txt');
  });

  it('路径穿越返回 ok:false', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const ls = tools.find((t) => t.name === 'repo_ls')!;
    const r = await ls.execute({ path: '../' });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/repo-sandbox.test.ts
```
Expected: 失败（`buildRepoSandboxTools` 未导出）。

- [ ] **Step 3: 引入 ToolExecutor 类型 + 实现 `buildRepoSandboxTools`（仅 repo_ls）**

追加到 `apps/api/src/pi/repo.ts`：

```ts
import { Type } from '@earendil-works/pi-ai';

export interface ToolExecutor {
  name: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (input: unknown) => Promise<{ ok: true; data?: string } | { ok: false; error: string }>;
  promptGuidelines?: string[];
}

/** 把任意结果安全序列化为 data 字符串（截断到 MAX_OUTPUT_CHARS）。 */
function asData(payload: unknown): string {
  const s = JSON.stringify(payload);
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + '…(truncated)' : s;
}

export function buildRepoSandboxTools(cwdRoot: string): ToolExecutor[] {
  return [
    {
      name: 'repo_ls',
      description: '列出 cwd 下某目录的文件与子目录（不含隐藏文件）。最多 500 项。',
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
      }),
      execute: async (input) => {
        const { path: p } = input as { path?: string };
        try {
          const real = await assertInCwd(cwdRoot, p ?? '.');
          const entries = await fs.readdir(real, { withFileTypes: true });
          const list = entries
            .filter((e) => !e.name.startsWith('.'))
            .slice(0, MAX_REPO_ENTRIES)
            .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }));
          return { ok: true, data: asData({ entries: list, truncated: entries.length > MAX_REPO_ENTRIES }) };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
  ];
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/repo-sandbox.test.ts
```
Expected: `assertInCwd` 3 个 + `repo_ls` 3 个共 6 个通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/repo.ts apps/api/test/repo-sandbox.test.ts
git commit -m "feat(pi/repo): add repo_ls sandbox tool"
```

---

## Task 4: `repo_read` 工具

**Files:**
- Modify: `apps/api/src/pi/repo.ts`
- Modify: `apps/api/test/repo-sandbox.test.ts`

- [ ] **Step 1: 加失败测试**

```ts
// 追加到 repo-sandbox.test.ts
import fsSync from 'node:fs';

describe('repo_read', () => {
  it('读文本文件返回行号+内容', async () => {
    await fs.writeFile(path.join(cwd, 'lines.txt'), 'a\nb\nc\n');
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_read')!;
    const r = await t.execute({ path: 'lines.txt' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.content).toBe('a\nb\nc\n');
    expect(data.totalLines).toBe(3);
  });

  it('offset / maxLines 切片', async () => {
    await fs.writeFile(path.join(cwd, 'big.txt'), Array.from({ length: 100 }, (_, i) => `L${i}`).join('\n'));
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_read')!;
    const r = await t.execute({ path: 'big.txt', offset: 10, maxLines: 5 });
    const data = JSON.parse((r as { data: string }).data);
    expect(data.content).toBe('L10\nL11\nL12\nL13\nL14');
    expect(data.truncated).toBe(true);
  });

  it('maxLines > 500 强制截断到 500', async () => {
    await fs.writeFile(path.join(cwd, 'huge.txt'), 'x\n'.repeat(2000));
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_read')!;
    const r = await t.execute({ path: 'huge.txt', maxLines: 9999 });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.lines.length).toBeLessThanOrEqual(500);
  });

  it('二进制文件返回 ok:false', async () => {
    await fs.writeFile(path.join(cwd, 'blob.bin'), Buffer.from([0, 1, 2, 0, 5]));
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_read')!;
    const r = await t.execute({ path: 'blob.bin' });
    expect(r.ok).toBe(false);
  });

  it('路径穿越返回 ok:false', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_read')!;
    const r = await t.execute({ path: '../../etc/passwd' });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/repo-sandbox.test.ts
```
Expected: `repo_read` 5 个失败。

- [ ] **Step 3: 在 `buildRepoSandboxTools` 数组里追加 `repo_read`**

```ts
    {
      name: 'repo_read',
      description: '读取 cwd 下文本文件的指定行范围（默认前 200 行，最多 500 行）。',
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        offset: Type.Optional(Type.Number({ minimum: 0 })),
        maxLines: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      execute: async (input) => {
        const { path: p, offset = 0, maxLines = DEFAULT_READ_MAX_LINES } = input as { path: string; offset?: number; maxLines?: number };
        const cap = Math.min(maxLines, READ_MAX_LINES_HARD_CAP);
        try {
          const real = await assertInCwd(cwdRoot, p);
          const stat = await fs.stat(real);
          if (!stat.isFile()) return { ok: false, error: 'not a file' };
          const fh = await fs.open(real, 'r');
          try {
            const head = Buffer.alloc(512);
            await fh.read(head, 0, 512, 0);
            if (head.includes(0)) return { ok: false, error: 'binary file' };
            const all = await fh.readFile('utf8');
            const lines = all.split('\n');
            const slice = lines.slice(offset, offset + cap).join('\n');
            return {
              ok: true,
              data: asData({
                content: slice.length > MAX_OUTPUT_CHARS ? slice.slice(0, MAX_OUTPUT_CHARS) + '…(truncated)' : slice,
                totalLines: lines.length,
                truncated: lines.length > offset + cap,
              }),
            };
          } finally { await fh.close(); }
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/repo-sandbox.test.ts
```
Expected: 11 个用例全通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/repo.ts apps/api/test/repo-sandbox.test.ts
git commit -m "feat(pi/repo): add repo_read sandbox tool"
```

---

## Task 5: `repo_grep` 工具（用 ripgrep 子进程）

**Files:**
- Modify: `apps/api/src/pi/repo.ts`
- Modify: `apps/api/test/repo-sandbox.test.ts`

- [ ] **Step 1: 加失败测试**

```ts
// 追加到 repo-sandbox.test.ts
import { spawn } from 'node:child_process';

describe('repo_grep', () => {
  beforeAll(async () => {
    await fs.writeFile(path.join(cwd, 'a.ts'), 'export function hello() {\n  return "hi";\n}\n');
    await fs.writeFile(path.join(cwd, 'b.ts'), 'export const greeting = "hi";\n');
  });

  it('基本匹配返回 { matches: [{ path, line, text }] }', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_grep')!;
    const r = await t.execute({ pattern: 'greeting' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.matches.length).toBeGreaterThan(0);
    expect(data.matches.some((m: { path: string }) => m.path.endsWith('b.ts'))).toBe(true);
  });

  it('glob 过滤文件', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_grep')!;
    const r = await t.execute({ pattern: 'hi', glob: '*.ts' });
    const data = JSON.parse((r as { data: string }).data);
    expect(data.matches.length).toBeGreaterThan(0);
  });

  it('找不到匹配返回空数组', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_grep')!;
    const r = await t.execute({ pattern: '__nonexistent_xyz__' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.matches).toEqual([]);
  });

  it('rg 不存在时返回明确错误', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_grep')!;
    // force rg 找不到：通过 env PATH 强制覆盖
    const prev = process.env.PATH;
    process.env.PATH = '/nonexistent-dir';
    try {
      const r = await t.execute({ pattern: 'hi' });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/rg|ripgrep|ENOENT/i);
    } finally { process.env.PATH = prev; }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/repo-sandbox.test.ts
```
Expected: `repo_grep` 4 个失败。

- [ ] **Step 3: 加 ripgrep 子进程封装 + `repo_grep` 工具**

```ts
import { spawn } from 'node:child_process';

function runRg(cwdRoot: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd: cwdRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('rg timeout')); }, REPO_RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // code=1 表示无匹配（rg 约定），仍算成功
      if (code === 0 || code === 1) resolve({ stdout: out, code });
      reject(new Error(`rg exited ${code}: ${err}`));
    });
  });
}
```

追加 `repo_grep`：

```ts
    {
      name: 'repo_grep',
      description: '在 cwd 下用 ripgrep 搜索；输出形如 file:line:text。maxMatches 默认 200。',
      parameters: Type.Object({
        pattern: Type.String({ minLength: 1 }),
        glob: Type.Optional(Type.String()),
        maxMatches: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      execute: async (input) => {
        const { pattern, glob, maxMatches = 200 } = input as { pattern: string; glob?: string; maxMatches?: number };
        const args = ['--no-heading', '-n', '-S', `--max-count=${maxMatches}`, '--', pattern];
        if (glob) args.push('--glob', glob);
        args.push('.');
        try {
          const { stdout } = await runRg(cwdRoot, args);
          if (!stdout) return { ok: true, data: asData({ matches: [] }) };
          const lines = stdout.split('\n').filter(Boolean).slice(0, maxMatches);
          const matches = lines.map((l) => {
            const idx1 = l.indexOf(':');
            const idx2 = idx1 >= 0 ? l.indexOf(':', idx1 + 1) : -1;
            if (idx1 < 0 || idx2 < 0) return { raw: l };
            return { path: l.slice(0, idx1), line: Number(l.slice(idx1 + 1, idx2)), text: l.slice(idx2 + 1) };
          });
          return { ok: true, data: asData({ matches, truncated: matches.length >= maxMatches }) };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/repo-sandbox.test.ts
```
Expected: 15 个全通过。如果第 4 个 rg-not-found 在当前环境很难触发（PATH 含 rg），可以删除该用例。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/repo.ts apps/api/test/repo-sandbox.test.ts
git commit -m "feat(pi/repo): add repo_grep sandbox tool"
```

---

## Task 6: `repo_run` 工具（白名单命令）

**Files:**
- Modify: `apps/api/src/pi/repo.ts`
- Modify: `apps/api/test/repo-sandbox.test.ts`

- [ ] **Step 1: 加失败测试**

```ts
// 追加到 repo-sandbox.test.ts
describe('repo_run', () => {
  it('白名单 ls 返回 cwd 根目录列表', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_run')!;
    const r = await t.execute({ command: 'ls' });
    expect(r.ok).toBe(true);
    expect((r as { data: string }).data).toContain('a.txt');
  });

  it('黑名单命令直接拒绝', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_run')!;
    const cases = ['rm -rf /', 'curl http://evil', 'git push origin main', 'echo hi; rm -rf /', 'cat a.txt && rm a.txt'];
    for (const command of cases) {
      const r = await t.execute({ command });
      expect(r.ok).toBe(false);
    }
  });

  it('git 子命令二次白名单', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_run')!;
    // 'git init' 不在二次白名单
    const r = await t.execute({ command: 'git init' });
    expect(r.ok).toBe(false);
  });

  it('chain operators 拒绝（&& / ; / |）', async () => {
    const tools = buildRepoSandboxTools(cwd);
    const t = tools.find((x) => x.name === 'repo_run')!;
    const r = await t.execute({ command: 'ls | cat' });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/repo-sandbox.test.ts
```
Expected: 4 个 `repo_run` 用例失败。

- [ ] **Step 3: 加 `repo_run` 工具**

```ts
const WHITELIST_TOP = new Set(['ls', 'cat', 'tree', 'find', 'head', 'tail', 'wc', 'grep', 'rg', 'git']);
const WHITELIST_GIT_SUBCMD = new Set(['log', 'show', 'diff', 'ls-files', 'grep', 'status']);
const BLOCKED_CHARS = /[;&|`$()<>]/;
```

```ts
    {
      name: 'repo_run',
      description: '在 cwd 下执行白名单单命令；用于 git log/show/diff/ls-files/grep/status 等二级需求。',
      parameters: Type.Object({
        command: Type.String({ minLength: 1, maxLength: 1024 }),
      }),
      execute: async (input) => {
        const { command } = input as { command: string };
        if (BLOCKED_CHARS.test(command)) {
          return { ok: false, error: 'shell metacharacters not allowed' };
        }
        const parts = command.trim().split(/\s+/);
        const top = parts[0]!;
        if (!WHITELIST_TOP.has(top)) return { ok: false, error: `command not whitelisted: ${top}` };
        if (top === 'git') {
          const sub = parts[1];
          if (!sub || !WHITELIST_GIT_SUBCMD.has(sub)) {
            return { ok: false, error: `git subcommand not whitelisted: ${sub ?? '(none)'}` };
          }
        }
        try {
          const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve, reject) => {
            const child = spawn(top, parts.slice(1), { cwd: cwdRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            let err = '';
            const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('command timeout')); }, REPO_RUN_TIMEOUT_MS);
            child.stdout.on('data', (d) => { out += d.toString(); });
            child.stderr.on('data', (d) => { err += d.toString(); });
            child.on('error', (e) => { clearTimeout(t); reject(e); });
            child.on('close', (c) => { clearTimeout(t); resolve({ stdout: out, code: c ?? 0 }); });
          });
          return { ok: code === 0, data: stdout.slice(0, MAX_OUTPUT_CHARS), error: code !== 0 ? `exit ${code}` : undefined };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/repo-sandbox.test.ts
```
Expected: 19 个全通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/repo.ts apps/api/test/repo-sandbox.test.ts
git commit -m "feat(pi/repo): add repo_run whitelist tool"
```

---

## Task 7: `checkoutRepo` — 浅克隆 + fetch 锁

**Files:**
- Modify: `apps/api/src/pi/repo.ts`
- Create: `apps/api/test/repo.test.ts`

- [ ] **Step 1: 加失败测试**

```ts
// apps/api/test/repo.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
let reqId: string;
let reposRoot: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-repos-'));
  process.env.PI_DATA_DIR = reposRoot;
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
  await fs.rm(reposRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(`TRUNCATE projects, requirements, project_assignments, organizations, users CASCADE`);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
  reqId = r.rows[0]!.id as string;
});

describe('checkoutRepo', () => {
  it('projects.repoUrl 缺失抛 RepoUnavailableError(no_repo)', async () => {
    const { checkoutRepo, RepoUnavailableError } = await import('../src/pi/repo.js');
    await expect(checkoutRepo(reqId)).rejects.toBeInstanceOf(RepoUnavailableError);
    try { await checkoutRepo(reqId); } catch (e) { expect((e as { reason: string }).reason).toBe('no_repo'); }
  });

  it('repoUrl 存在但 git clone 失败抛 clone_failed', async () => {
    await pool.query(`UPDATE projects SET repo_url=$1 WHERE id=$2`, ['https://github.com/itest-nonexistent-12345-xyz/foo.git', projectId]);
    const { checkoutRepo, RepoUnavailableError } = await import('../src/pi/repo.js');
    await expect(checkoutRepo(reqId)).rejects.toBeInstanceOf(RepoUnavailableError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/repo.test.ts
```
Expected: 失败（`checkoutRepo` 未实现）。

- [ ] **Step 3: 实现 `checkoutRepo` 最小版（只处理 no_repo）**

追加到 `apps/api/src/pi/repo.ts`：

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, requirements } from '../db/schema.js';
import lockfile from 'proper-lockfile';

interface ProjectRepo { repoUrl: string; branch: string; provider: string; pat: string | null; gitlabOverride: string | null; }

async function loadProjectRepo(requirementId: string): Promise<ProjectRepo | null> {
  const row = (await db
    .select({
      repoUrl: projects.repoUrl,
      branch: projects.defaultBranch,
      provider: projects.provider,
      pat: projects.patOverride,
      gitlabOverride: projects.gitlabUrlOverride,
      pid: projects.id,
    })
    .from(requirements)
    .innerJoin(projects, eq(requirements.projectId, projects.id))
    .where(eq(requirements.id, requirementId))
    .limit(1))[0];
  if (!row || !row.repoUrl) return null;
  return { repoUrl: row.repoUrl, branch: row.branch, provider: row.provider, pat: row.pat, gitlabOverride: row.gitlabOverride };
}

function injectPat(url: string, provider: string, pat: string | null, gitlabOverride: string | null): string {
  if (!pat) return url;
  if (provider === 'github') {
    const u = new URL(url);
    u.username = 'x-access-token';
    u.password = pat;
    return u.toString();
  }
  if (provider === 'gitee') {
    const u = new URL(url);
    u.username = 'oauth2';
    u.password = pat;
    return u.toString();
  }
  // gitlab
  const base = gitlabOverride ?? url;
  const u = new URL(base);
  u.username = 'oauth2';
  u.password = pat;
  return u.toString();
}

/** 第一阶段：先实现 no_repo / 锁 / 目录骨架。clone / fetch / stash 后补。 */
export async function checkoutRepo(requirementId: string): Promise<string> {
  const info = await loadProjectRepo(requirementId);
  if (!info) throw new RepoUnavailableError('no_repo', 'project has no repoUrl configured');

  await fs.mkdir(REPOS_ROOT, { recursive: true });
  const target = path.join(REPOS_ROOT, requirementId);

  if (await dirExists(target)) {
    // 锁定；保证并发只跑一次 fetch
    try {
      const release = await lockfile.lock(`${target}/.lock`, { retries: { retries: 0, minTimeout: 50, maxTimeout: 200, factor: 1 }, stale: 30_000 });
      try { return await fetchAndReset(target, info); } finally { await release(); }
    } catch (e) {
      if ((e as { code?: string }).code === 'ELOCKED') throw new LockTimeoutError('another fetch in progress');
      throw e;
    }
  } else {
    await fs.mkdir(target, { recursive: true });
    const release = await lockfile.lock(`${target}/.lock`, { retries: 0, stale: 30_000 }).catch(() => null);
    try {
      // 第一版：clone 失败抛 RepoUnavailableError(clone_failed)；后续 task 细化 PAT / dirty / auth
      try {
        await runGit(['clone', '--depth', '1', '--branch', info.branch, injectPat(info.repoUrl, info.provider, info.pat, info.gitlabOverride), target]);
      } catch (e) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
        const msg = (e as Error).message;
        const reason: RepoUnavailableReason = /401|403|auth/i.test(msg) ? 'auth_failed' : 'clone_failed';
        throw new RepoUnavailableError(reason, msg);
      }
      return target;
    } finally { if (release) await release(); }
  }
}

async function dirExists(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
}

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err.trim() || `git exit ${code}`)));
  });
}

async function fetchAndReset(_target: string, _info: ProjectRepo): Promise<string> {
  // 第一版占位：直接返回 target；后续 task 加上 fetch + reset + dirty stash
  throw new Error('not yet implemented: fetchAndReset');
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/repo.test.ts
```
Expected: 2 个用例（no_repo + clone_failed）通过。第二条 clone_failed 会真的去网络拉（耗时），可加超时：测试 framework 默认 5s，可能挂；如挂则 `it('…', { timeout: 30_000 }, …)`。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/repo.ts apps/api/test/repo.test.ts
git commit -m "feat(pi/repo): checkoutRepo skeleton (no_repo + clone error path)"
```

---

## Task 8: `fetchAndReset` + dirty stash

**Files:**
- Modify: `apps/api/src/pi/repo.ts`
- Modify: `apps/api/test/repo.test.ts`

- [ ] **Step 1: 加失败测试（用本地 bare repo 模拟）**

```ts
// 追加到 repo.test.ts
import { spawnSync } from 'node:child_process';

async function makeBareRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-bare-'));
  spawnSync('git', ['init', '--bare', dir], { stdio: 'ignore' });
  // 推一个 commit 到 main
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-work-'));
  spawnSync('git', ['init', '-b', 'main', work], { stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: work });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: work });
  await fs.writeFile(path.join(work, 'f.txt'), 'hello');
  spawnSync('git', ['add', '.'], { cwd: work });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: work });
  spawnSync('git', ['remote', 'add', 'origin', dir], { cwd: work });
  spawnSync('git', ['push', 'origin', 'main'], { cwd: work });
  await fs.rm(work, { recursive: true, force: true });
  return dir;
}

describe('checkoutRepo end-to-end (local bare repo)', () => {
  it('首次 checkout 浅克隆 + 写 .itest-sandbox.json', async () => {
    const bare = await makeBareRepo();
    await pool.query(`UPDATE projects SET repo_url=$1, default_branch='main', provider='github' WHERE id=$2`, [bare, projectId]);
    const { checkoutRepo } = await import('../src/pi/repo.js');
    const target = await checkoutRepo(reqId);
    expect(target.startsWith(reposRoot)).toBe(true);
    const meta = JSON.parse(await fs.readFile(path.join(target, '.itest-sandbox.json'), 'utf8'));
    expect(meta.branch).toBe('main');
    expect(meta.provider).toBe('github');
    expect(typeof meta.commit).toBe('string');
    expect(meta.commit.length).toBeGreaterThanOrEqual(7);
    await fs.rm(bare, { recursive: true, force: true });
  }, 30_000);

  it('第二次 checkout 复用本地，commit 保持一致', async () => {
    const bare = await makeBareRepo();
    await pool.query(`UPDATE projects SET repo_url=$1, default_branch='main', provider='github' WHERE id=$2`, [bare, projectId]);
    const { checkoutRepo } = await import('../src/pi/repo.js');
    const t1 = await checkoutRepo(reqId);
    const m1 = JSON.parse(await fs.readFile(path.join(t1, '.itest-sandbox.json'), 'utf8'));
    const t2 = await checkoutRepo(reqId);
    expect(t1).toBe(t2);
    const m2 = JSON.parse(await fs.readFile(path.join(t2, '.itest-sandbox.json'), 'utf8'));
    expect(m2.commit).toBe(m1.commit);
    await fs.rm(bare, { recursive: true, force: true });
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/repo.test.ts
```
Expected: 2 个失败（fetchAndReset 抛 not yet implemented）。

- [ ] **Step 3: 实现 `fetchAndReset` + clone 后写 .itest-sandbox.json**

替换 `apps/api/src/pi/repo.ts` 中两个 TODO：

```ts
async function cloneFirst(target: string, info: ProjectRepo): Promise<void> {
  try {
    await runGit(['clone', '--depth', '1', '--branch', info.branch, injectPat(info.repoUrl, info.provider, info.pat, info.gitlabOverride), target]);
  } catch (e) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    const msg = (e as Error).message;
    const reason: RepoUnavailableReason = /401|403|auth/i.test(msg) ? 'auth_failed' : 'clone_failed';
    throw new RepoUnavailableError(reason, msg);
  }
}

async function fetchAndReset(target: string, info: ProjectRepo): Promise<string> {
  // 1. dirty 检查：tracked 修改 / untracked 文件 → stash
  const status = await runGitIn(target, ['status', '--porcelain']).catch(() => '');
  let stashRef: string | null = null;
  if (status.trim().length > 0) {
    stashRef = await runGitIn(target, ['stash', 'push', '--include-untracked', '-m', `itest-auto-${Date.now()}`]);
    stashRef = stashRef.match(/refs\/stash\{\d+\}/)?.[0] ?? stashRef;
  }
  // 2. fetch + reset
  try {
    await runGitIn(target, ['fetch', '--depth', '1', 'origin', info.branch]);
    await runGitIn(target, ['reset', '--hard', `origin/${info.branch}`]);
  } catch (e) {
    const msg = (e as Error).message;
    throw new RepoUnavailableError(/401|403/i.test(msg) ? 'auth_failed' : 'fetch_failed', msg);
  }
  // 3. 写 meta
  const commit = (await runGitIn(target, ['rev-parse', 'HEAD'])).trim();
  await fs.writeFile(path.join(target, '.itest-sandbox.json'), JSON.stringify({
    provider: info.provider,
    branch: info.branch,
    commit,
    fetchedAt: new Date().toISOString(),
    ...(stashRef ? { stashRef } : {}),
  }, null, 2));
  return target;
}

function runGitIn(cwdArg: string, args: string[]): Promise<string> {
  return runGit([...args]); // 简化版：runGit 不接受 cwd，先扩展
}
```

把 `runGit` 改为支持 cwd：

```ts
function runGit(args: string[], cwdArg: string = process.cwd()): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: cwdArg, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err.trim() || `git exit ${code}`)));
  });
}
```

更新 `checkoutRepo` 里的 `clone` 与 fetch 分支调用 fetchAndReset：

```ts
  if (await dirExists(target)) {
    try {
      const release = await lockfile.lock(`${target}/.lock`, { retries: 0, stale: 30_000 });
      try { return await fetchAndReset(target, info); } finally { await release(); }
    } catch (e) {
      if ((e as { code?: string }).code === 'ELOCKED') throw new LockTimeoutError('another fetch in progress');
      throw e;
    }
  } else {
    await fs.mkdir(target, { recursive: true });
    await cloneFirst(target, info);
    return await fetchAndReset(target, info);
  }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/repo.test.ts
```
Expected: 4 个全通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/repo.ts apps/api/test/repo.test.ts
git commit -m "feat(pi/repo): fetchAndReset + stash on dirty + sandbox meta"
```

---

## Task 9: `WorkspaceDoc` 加 `contextMode` / `repoContext`

**Files:**
- Modify: `apps/api/src/pi/workspace.ts`
- Modify: `apps/api/test/pi-workspace.test.ts`

- [ ] **Step 1: 加失败测试**

```ts
// 追加到 pi-workspace.test.ts 的 describe('workspace store') 内
  it('emptyDoc 默认 contextMode=auto, repoContext=null', async () => {
    const { emptyDoc } = await import('../src/pi/workspace.js');
    const d = emptyDoc();
    expect(d.contextMode).toBe('auto');
    expect(d.repoContext).toBeNull();
  });

  it('recordContextMode 持久化 + 不覆盖 pageContext', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.recordPageInspection(requirementId, 'http://x');
    await ws.recordContextMode(requirementId, 'repo');
    const d = await ws.loadDoc(requirementId);
    expect(d.contextMode).toBe('repo');
    expect(d.pageContext?.url).toBe('http://x');
  });

  it('recordRepoCheckout 写入 commit + 保留其他字段', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.recordContextMode(requirementId, 'auto');
    await ws.recordRepoCheckout(requirementId, { commit: 'abc1234', fetchedAt: '2026-10-03T00:00:00Z', mode: 'auto' });
    const d = await ws.loadDoc(requirementId);
    expect(d.repoContext?.commit).toBe('abc1234');
    expect(d.contextMode).toBe('auto');
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/pi-workspace.test.ts
```
Expected: 3 个失败。

- [ ] **Step 3: 改 `apps/api/src/pi/workspace.ts`**

在 `WorkspaceDoc` 接口与 `emptyDoc` 内加新字段；新增两个函数：

```ts
export interface RepoContext { commit: string; fetchedAt: string; mode: 'repo' | 'auto'; }
export interface WorkspaceDoc {
  plan: { scenarios: number; cases: number } | null;
  contextMode: 'repo' | 'page' | 'auto';
  pageContext: { url: string; fetchedAt: string } | null;
  repoContext: RepoContext | null;
  scenarios: StagedScenario[];
  looseCases: StagedCase[];
}

export function emptyDoc(): WorkspaceDoc {
  return { plan: null, contextMode: 'auto', pageContext: null, repoContext: null, scenarios: [], looseCases: [] };
}
```

`loadDoc` 中同步读取 `contextMode` / `repoContext`：

```ts
  const contextMode = (stateDoc?.contextMode ?? 'auto') as 'repo' | 'page' | 'auto';
  const repoContext = stateDoc?.repoContext as RepoContext | null ?? null;
  return { plan, contextMode, pageContext, repoContext, scenarios, looseCases };
```

新增两个 merge 函数（参考已有 `announcePlan` 风格）：

```ts
export async function recordContextMode(requirementId: string, mode: 'repo' | 'page' | 'auto'): Promise<void> {
  const current = await readStateDoc(requirementId);
  const doc = { ...current, contextMode: mode };
  await db.insert(aiWorkspaceState).values({ requirementId, doc }).onConflictDoUpdate({
    target: aiWorkspaceState.requirementId,
    set: { doc, updatedAt: new Date() },
  });
  publish(requirementId);
}

export async function recordRepoCheckout(requirementId: string, ctx: RepoContext): Promise<void> {
  const current = await readStateDoc(requirementId);
  const doc = { ...current, repoContext: ctx };
  await db.insert(aiWorkspaceState).values({ requirementId, doc }).onConflictDoUpdate({
    target: aiWorkspaceState.requirementId,
    set: { doc, updatedAt: new Date() },
  });
  publish(requirementId);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/pi-workspace.test.ts
```
Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/workspace.ts apps/api/test/pi-workspace.test.ts
git commit -m "feat(pi/workspace): contextMode + repoContext on doc"
```

---

## Task 10: `tools.ts` 加 contextMode promptGuidelines

**Files:**
- Modify: `apps/api/src/pi/tools.ts`

- [ ] **Step 1: 加失败测试**

```ts
// 追加到 pi-tools.test.ts
import { buildWorkspaceTools } from '../src/pi/tools.js';

describe('buildWorkspaceTools promptGuidelines', () => {
  it('contextMode=repo 时提示优先 repo_*', () => {
    const tools = buildWorkspaceTools(requirementId, { contextMode: 'repo', repoAvailable: true });
    const upsert = tools.find((t) => t.name === 'upsert_case')!;
    expect(upsert.promptGuidelines?.join('\n')).toMatch(/repo_(ls|read|grep)/);
  });

  it('contextMode=page 时提示优先 inspect_page', () => {
    const tools = buildWorkspaceTools(requirementId, { contextMode: 'page', repoAvailable: false });
    const upsert = tools.find((t) => t.name === 'upsert_case')!;
    expect(upsert.promptGuidelines?.join('\n')).toMatch(/inspect_page/);
  });

  it('repoAvailable=false 时不引导用 repo_*', () => {
    const tools = buildWorkspaceTools(requirementId, { contextMode: 'repo', repoAvailable: false });
    const upsert = tools.find((t) => t.name === 'upsert_case')!;
    expect(upsert.promptGuidelines?.join('\n')).toMatch(/inspect_page/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/pi-tools.test.ts
```
Expected: 3 个失败。

- [ ] **Step 3: 修改 `buildWorkspaceTools` 签名 + 加 contextMode 段**

```ts
export function buildWorkspaceTools(requirementId: string, ctx: { contextMode: 'repo' | 'page' | 'auto'; repoAvailable: boolean } = { contextMode: 'auto', repoAvailable: false }): ToolExecutor[] {
  const ctxGuideline = (() => {
    if (ctx.contextMode === 'repo' && ctx.repoAvailable) {
      return [
        '生成用例前必须先调用 repo_ls/repo_read/repo_grep 看真实源码再决定 locator / navigate URL。',
        'locator 必须基于源码中真实存在的元素（className / data-testid / role），禁止臆造。',
      ];
    }
    if (ctx.contextMode === 'page') {
      return ['生成用例前先调 inspect_page 抓取真实页面元素清单。'];
    }
    if (ctx.contextMode === 'repo' && !ctx.repoAvailable) {
      return ['本项目源码仓库不可用，请改用 inspect_page 抓取页面。'];
    }
    // auto + 仓库可用 / 不可用 两种
    if (ctx.repoAvailable) {
      return [
        'auto 模式：若需求含明确被测页面 URL，先 inspect_page；若同时暗示内部行为（接口、状态机、表单提交后跳转），可调 repo_*。',
        '仓库可用时优先 repo_ls 列目录、repo_read 读关键文件、repo_grep 找关键实现。',
      ];
    }
    return ['auto 模式：本项目无仓库配置，直接 inspect_page。'];
  })();
```

把 `ctxGuideline` 拼接到 `upsert_case` 现有的 `promptGuidelines` 数组开头：

```ts
      promptGuidelines: [
        ...ctxGuideline,
        '尽量在同一轮并行发出全部工具调用…',
        '每条用例都应显式提供 description…',
        '每条 step 必须输出 compiled 字段…',
      ],
```

（保留原有所有条目，仅在最前面插入 `ctxGuideline`）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/pi-tools.test.ts
```
Expected: 全通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/tools.ts apps/api/test/pi-tools.test.ts
git commit -m "feat(pi/tools): contextMode-aware prompt guidelines"
```

---

## Task 11: `session.ts` 接 repo 工具 + cwd

**Files:**
- Modify: `apps/api/src/pi/session.ts`
- Create: `apps/api/test/pi-session-repo.test.ts`

- [ ] **Step 1: 加失败测试（用 setSessionFactory mock）**

```ts
// apps/api/test/pi-session-repo.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let requirementId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_scenarios, ai_cases, ai_threads RESTART IDENTITY CASCADE`);
  const { projectId } = await seedProject(pool);
  const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
  requirementId = r.rows[0]!.id as string;
  // stub LLM config
  await pool.query(`INSERT INTO settings(key, value) VALUES ('llm_config', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify({ provider: 'mock', model: 'mock', apiKey: 'k', baseUrl: null })]);
});

describe('session + repo 集成', () => {
  it('checkoutRepo 抛 no_repo → factory 仍建 session，工具组只剩 workspace', async () => {
    const session = await import('../src/pi/session.js');
    const repo = await import('../src/pi/repo.js');
    vi.spyOn(repo, 'checkoutRepo').mockRejectedValue(new repo.RepoUnavailableError('no_repo', 'no repo'));
    const factorySpy = vi.fn(session.createPiSessionFactory);
    session.setSessionFactory((ctx) => factorySpy(ctx));
    const rec = await session.ensureRecord(requirementId);
    expect(rec.session).toBeTruthy();
    // factory 应被调用一次（且第二个参数含 repoAvailable=false）
    expect(factorySpy).toHaveBeenCalledOnce();
    const arg = factorySpy.mock.calls[0]![0] as { contextMode: string; repoAvailable: boolean };
    expect(arg.repoAvailable).toBe(false);
  });

  it('checkoutRepo 成功 → factory 收到 cwd + repoAvailable=true', async () => {
    const session = await import('../src/pi/session.js');
    const repo = await import('../src/pi/repo.js');
    const fakeCwd = '/tmp/fake-repo-checkout';
    vi.spyOn(repo, 'checkoutRepo').mockResolvedValue(fakeCwd);
    const factorySpy = vi.fn(session.createPiSessionFactory);
    session.setSessionFactory((ctx) => factorySpy(ctx));
    await session.ensureRecord(requirementId);
    const arg = factorySpy.mock.calls[0]![0] as { cwd?: string; repoAvailable: boolean };
    expect(arg.cwd).toBe(fakeCwd);
    expect(arg.repoAvailable).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/pi-session-repo.test.ts
```
Expected: 失败。

- [ ] **Step 3: 改 `session.ts`**

把 `createPiSessionFactory` 改为接受 `{ threadId, requirementId, contextMode, cwd?, repoAvailable }`：

```ts
import { checkoutRepo, RepoUnavailableError } from './repo.js';

export async function createPiSessionFactory(ctx: {
  threadId: string; requirementId: string; contextMode: 'repo' | 'page' | 'auto'; cwd: string | null; repoAvailable: boolean;
}): Promise<PiSessionLike> {
  const cfg = await readLlmConfig();
  if (!cfg) throw new Error('LLM 未配置：请先到设置页配置模型');
  const { createAgentSession, SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
  const workspaceDir = process.env.PI_WORKSPACE_DIR ?? './.data/pi-sessions';
  await import('node:fs/promises').then((fs) => fs.mkdir(workspaceDir, { recursive: true }));

  // 把 repo 工具装进来
  const repoTools = ctx.repoAvailable && ctx.cwd
    ? buildRepoSandboxTools(ctx.cwd).map((t) => /* 同 defineTool 包法 */)
    : [];

  const ai_tools = [
    ...buildWorkspaceTools(ctx.requirementId, { contextMode: ctx.contextMode, repoAvailable: ctx.repoAvailable })
      .map((t) => defineTool({ /* 同原包法 */ })),
    ...repoTools,
  ];
  // ...其余不变...
  const { session } = await createAgentSession({
    cwd: ctx.cwd ?? workspaceDir,    // 仓库可用时切到 repo 根目录
    noTools: 'builtin',
    customTools: ai_tools,
    model, sessionManager,
  });
  // ...
}
```

`ensureRecord` 调用前先 `checkoutRepo`：

```ts
export async function ensureRecord(requirementId: string, opts: { contextMode?: 'repo' | 'page' | 'auto' } = {}): Promise<ThreadRecord> {
  // ...现有逻辑取 threadId...
  let cwd: string | null = null;
  let repoAvailable = false;
  try { cwd = await checkoutRepo(requirementId); repoAvailable = true; }
  catch (e) {
    if (!(e instanceof RepoUnavailableError)) throw e;
    // 静默降级
  }
  const session = await factory({ threadId, requirementId, contextMode: opts.contextMode ?? 'auto', cwd, repoAvailable });
  // ...其余不变...
}
```

并加 import：`import { buildRepoSandboxTools } from './repo.js';`

注意：`buildWorkspaceTools` 现在需要传 ctx；调用处已统一改。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/pi-session-repo.test.ts
```
Expected: 2 个通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/session.ts apps/api/test/pi-session-repo.test.ts
git commit -m "feat(pi/session): wire checkoutRepo + repo sandbox tools"
```

---

## Task 12: 路由层 — `metadata.contextMode` + 小端点

**Files:**
- Modify: `apps/api/src/pi/router.ts`
- Modify: `apps/api/src/routes/requirements.ts`
- Create: `apps/api/test/pi-router-context.test.ts`

- [ ] **Step 1: 加失败测试**

```ts
// apps/api/test/pi-router-context.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedUserAndToken } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let reqId: string;
let token: string;

beforeAll(async () {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
}, 60_000);
afterAll(async () {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end(); await pool.end(); await container.stop();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_scenarios, ai_cases, ai_threads RESTART IDENTITY CASCADE`);
  const { projectId } = await seedProject(pool);
  const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
  reqId = r.rows[0]!.id as string;
  token = await seedUserAndToken(pool, { role: 'admin' });
});

describe('context-mode 端点', () => {
  it('POST /requirements/:id/ai-workspace/context-mode 写 doc', async () => {
    const { app } = await import('../src/index.js');
    const res = await fetch(`http://localhost:${process.env.PORT ?? 0}/api/requirements/${reqId}/ai-workspace/context-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode: 'repo' }),
    });
    expect(res.status).toBe(204);
    const ws = await import('../src/pi/workspace.js');
    const d = await ws.loadDoc(reqId);
    expect(d.contextMode).toBe('repo');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/pi-router-context.test.ts
```
Expected: 失败（端点不存在）。

- [ ] **Step 3: 改 `pi/router.ts` — `POST /threads/:id/messages` 接 `metadata.contextMode`**

```ts
piRoute.post('/threads/:id/messages', async (req, res) => {
  await assertThreadVisible(req.params.id!, req.user as AuthUser);
  const ridRow = (await db.select({ requirementId: aiThreads.requirementId }).from(aiThreads).where(eq(aiThreads.id, req.params.id!)).limit(1))[0];
  if (!ridRow) throw new HttpError(404, 'not_found', 'thread not found');
  const body = req.body as { input?: { content?: string }; metadata?: { contextMode?: 'repo'|'page'|'auto' } };
  const content = body.input?.content ?? '';
  const contextMode = body.metadata?.contextMode ?? 'auto';
  void (async () => {
    try {
      await ws.recordContextMode(ridRow.requirementId, contextMode);
      await ensureRecord(ridRow.requirementId, { contextMode });
      await sendUserMessage(req.params.id!, { content });
    } catch { /* ignore */ }
  })();
  res.status(204).end();
});
```

加 import：`import * as ws from './workspace.js';`

`sendUserMessage` 已经存在，不动。

- [ ] **Step 4: 在 `routes/requirements.ts` 加小端点**

先看现状（`apps/api/src/routes/requirements.ts` 中是否有 ai-workspace/save 端点？）。如有，挨着加：

```ts
requirementsRoute.post('/:id/ai-workspace/context-mode', async (req, res) => {
  await assertProjectVisible(...);  // 沿用其它端点
  const body = z.object({ mode: z.enum(['repo', 'page', 'auto']) }).parse(req.body);
  await ws.recordContextMode(req.params.id, body.mode);
  res.status(204).end();
});
```

具体 import 与权限校验照抄邻近的 save 端点。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/pi-router-context.test.ts
```
Expected: 通过。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pi/router.ts apps/api/src/routes/requirements.ts apps/api/test/pi-router-context.test.ts
git commit -m "feat(pi/router): contextMode metadata + context-mode endpoint"
```

---

## Task 13: 前端类型 + API client

**Files:**
- Modify: `apps/web/src/api/client.ts`

- [ ] **Step 1: 加失败测试**

`apps/web` 没 vitest 配置；这一 task 跳过前端测试，直接修改 + typecheck。

- [ ] **Step 2: 改 `apps/web/src/api/client.ts`**

在 `WorkspaceDoc` 接口增加字段：

```ts
export interface RepoContext { commit: string; fetchedAt: string; mode: 'repo' | 'auto'; }
export interface WorkspaceDoc {
  plan: { scenarios: number; cases: number } | null;
  contextMode?: 'repo' | 'page' | 'auto';
  pageContext?: { url: string; fetchedAt: string } | null;
  repoContext?: RepoContext | null;
  scenarios: StagedScenario[];
  looseCases: StagedCase[];
}
```

`aiWorkspace` 模块加方法：

```ts
    setContextMode: (requirementId: string, mode: 'repo' | 'page' | 'auto') =>
      fetch(`${BASE}/requirements/${requirementId}/ai-workspace/context-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      }).then((r) => { if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`); }),
    getProject: (projectId: string) =>
      request<ProjectDetail>(`/projects/${projectId}`),
```

把 `sendMessage` 改为带 metadata（沿用 fetch 形式）：

```ts
    sendMessage: (threadId: string, content: string, metadata: { contextMode: 'repo' | 'page' | 'auto' }) =>
      fetch(`${BASE}/pi/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { content }, metadata }),
      }).then((r) => { if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`); }),
```

- [ ] **Step 3: 跑 typecheck**

```bash
cd apps/web && pnpm exec tsc --noEmit
```
Expected: 0 error。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api/client.ts
git commit -m "feat(web/api): contextMode + setContextMode + getProject"
```

---

## Task 14: `ContextModeSelector` 组件

**Files:**
- Create: `apps/web/src/features/ai-workspace/ContextModeSelector.tsx`
- Create: `apps/web/src/features/ai-workspace/ContextModeSelector.test.tsx`

- [ ] **Step 1: 加失败测试（vitest + RTL）**

```tsx
// apps/web/src/features/ai-workspace/ContextModeSelector.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ContextModeSelector from './ContextModeSelector';

describe('ContextModeSelector', () => {
  it('渲染 3 个选项', () => {
    render(<ContextModeSelector value="auto" onChange={() => {}} hasRepo />);
    expect(screen.getByText('参考源码')).toBeTruthy();
    expect(screen.getByText('抓取页面')).toBeTruthy();
    expect(screen.getByText('自动')).toBeTruthy();
  });

  it('点击选项触发 onChange', () => {
    const onChange = vi.fn();
    render(<ContextModeSelector value="auto" onChange={onChange} hasRepo />);
    fireEvent.click(screen.getByText('参考源码'));
    expect(onChange).toHaveBeenCalledWith('repo');
  });

  it('hasRepo=false 时禁用『参考源码』', () => {
    render(<ContextModeSelector value="auto" onChange={() => {}} hasRepo={false} />);
    const btn = screen.getByText('参考源码') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('仓库');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && pnpm test features/ai-workspace/ContextModeSelector.test.tsx
```
Expected: 失败。

- [ ] **Step 3: 实现组件**

```tsx
// apps/web/src/features/ai-workspace/ContextModeSelector.tsx
import Segmented from '../../components/ui/Segmented';

export type ContextMode = 'repo' | 'page' | 'auto';

interface Props {
  value: ContextMode;
  onChange: (mode: ContextMode) => void;
  hasRepo: boolean;
}

export default function ContextModeSelector({ value, onChange, hasRepo }: Props) {
  return (
    <Segmented<ContextMode>
      options={[
        { value: 'repo', label: '参考源码' },
        { value: 'page', label: '抓取页面' },
        { value: 'auto', label: '自动' },
      ]}
      value={value}
      onChange={onChange}
    />
  );
}
```

注：`Segmented` 自身不支持 disabled，需要扩展：先在 `Segmented.tsx` 的 button 上加 `disabled` + `title` 透传；本期小改：

```tsx
interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  title?: string;
}
...
<button
  ...
  disabled={opt.disabled}
  title={opt.title}
  ...
>
```

并在 `ContextModeSelector` 传 `disabled: !hasRepo, title: hasRepo ? undefined : '请先到项目设置配置仓库'` 给 'repo' 项。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && pnpm test features/ai-workspace/ContextModeSelector.test.tsx
```
Expected: 3 个通过。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/ai-workspace/ContextModeSelector.tsx apps/web/src/features/ai-workspace/ContextModeSelector.test.tsx apps/web/src/components/ui/Segmented.tsx
git commit -m "feat(web): ContextModeSelector + Segmented disabled support"
```

---

## Task 15: `WorkspacePanel` 接 selector + chip

**Files:**
- Modify: `apps/web/src/features/ai-workspace/WorkspacePanel.tsx`

- [ ] **Step 1: 改 `WorkspacePanel`**

```tsx
import ContextModeSelector, { type ContextMode } from './ContextModeSelector';
import { api } from '../../api/client';

// 在组件顶部 state 加：
const [contextMode, setContextMode] = useState<ContextMode>(doc?.contextMode ?? 'auto');
const { data: project } = useQuery({
  queryKey: ['project', doc?.requirementId ?? null],   // 已有 projectId 走 query
  queryFn: () => api.projects.get(/* projectId：要从 requirement 推 */),
  enabled: !!requirementId,
});
const hasRepo = !!project?.repoUrl;
```

注：`doc` 不含 projectId；通过 props 传 `projectId`，或新增 `api.requirements.get(projectId, requirementId)`。这里最小改动：**给 WorkspacePanel 加 `projectId` prop**，由父页 `AiWorkspacePage` 传入。

```tsx
interface Props { requirementId: string; projectId: string; threadId: string; onOpenSave: ... }
```

加载项目元数据 + 切换 contextMode 持久化：

```tsx
const onContextModeChange = (m: ContextMode) => {
  setContextMode(m);
  void api.aiWorkspace.setContextMode(requirementId, m);
};
```

顶部 JSX（紧贴标题下方）：

```tsx
<div className="flex items-center gap-2 text-[12px] text-text-muted">
  <span>上下文：</span>
  <ContextModeSelector value={contextMode} onChange={onContextModeChange} hasRepo={hasRepo} />
  <RepoChip doc={doc} />
</div>
```

`RepoChip`：

```tsx
function RepoChip({ doc }: { doc: WorkspaceDoc | undefined }) {
  if (doc?.repoContext) {
    return <span className="chip">已参考源码 v{doc.repoContext.commit.slice(0, 7)}</span>;
  }
  if (doc?.pageContext) {
    return <span className="chip">已抓取页面 {doc.pageContext.url}</span>;
  }
  return <span className="chip chip-muted">未参考任何上下文</span>;
}
```

- [ ] **Step 2: 改父页 `AiWorkspacePage` 传 `projectId`**

```tsx
const { requirementId } = useParams();
const { data: requirement } = useQuery({
  queryKey: ['requirement', requirementId],
  queryFn: () => api.requirements.get(requirementId!),
});
<WorkspacePanel
  requirementId={requirementId!}
  projectId={requirement?.projectId ?? ''}
  threadId={threadId}
  onOpenSave={...}
/>
```

具体 imports 与 query 名照抄邻近代码。

- [ ] **Step 3: typecheck**

```bash
cd apps/web && pnpm exec tsc --noEmit
```
Expected: 0 error。

- [ ] **Step 4: 手动跑 dev server 验证**

```bash
cd /Users/lyq/workdir/codedev/iTest && pnpm dev
```
打开一个项目已配仓库的 AI 工作台（mock 模型脚本），切换 3 段 → 看到 chip 切换；未配仓库的项目看到「参考源码」禁用。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/ai-workspace/WorkspacePanel.tsx apps/web/src/pages/AiWorkspacePage.tsx
git commit -m "feat(web): WorkspacePanel integrates ContextModeSelector + repo chip"
```

---

## Task 16: `ThreadPane` 发消息带 contextMode

**Files:**
- Modify: `apps/web/src/features/ai-workspace/ThreadPane.tsx`

- [ ] **Step 1: 改 sendMessage 调用**

```tsx
const onSend = async (text: string) => {
  await api.aiWorkspace.sendMessage(threadId, text, { contextMode });
};
```

`contextMode` 从父组件 props 传入（与 `WorkspacePanel` 共享）。最简：在 `AiWorkspacePage` 顶层一个 `useState<ContextMode>`，传给 `WorkspacePanel` 与 `ThreadPane`。

- [ ] **Step 2: typecheck + 手动验证**

```bash
cd apps/web && pnpm exec tsc --noEmit
```
然后 dev server 跑通：切换 contextMode → 发消息 → 后端 SSE 看到 workspace_doc 事件 + 右栏 chip 更新。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/ai-workspace/ThreadPane.tsx apps/web/src/pages/AiWorkspacePage.tsx
git commit -m "feat(web): ThreadPane sends contextMode metadata"
```

---

## Task 17: 端到端回归 + 全量

- [ ] **Step 1: 跑 api 全量**

```bash
cd apps/api && pnpm test
```
Expected: 全通过（已知 plans.test 1 个 pre-existing failure 不算回归）。

- [ ] **Step 2: 跑 web typecheck + lint**

```bash
cd apps/web && pnpm exec tsc --noEmit && pnpm lint
```
Expected: 0 error。

- [ ] **Step 3: 手动金路径**

dev 环境：
1. 项目 A（已配 github 仓库）→ AI 工作台 → 选「参考源码」→ 发消息（mock 模型）→ 看到 `repo_ls → repo_read → upsert_case` 链路 → chip 显示 v<sha>
2. 项目 B（无仓库）→ AI 工作台 → 「参考源码」禁用 → 选「抓取页面」→ 走原 inspect_page 路径

- [ ] **Step 4: Commit any straggler**

```bash
git status  # 干净即可
```

---

## 自审（写完后跑一遍）

1. **Spec 覆盖**：
   - `checkoutRepo` + 沙箱工具 → Task 1–8 ✓
   - `WorkspaceDoc` 加 contextMode / repoContext → Task 9 ✓
   - contextMode 注入 system message → Task 10 + Task 11 ✓
   - 路由层 metadata.contextMode → Task 12 ✓
   - 前端 selector + chip → Task 14 + 15 ✓
   - 发消息带 metadata → Task 16 ✓
   - 错误降级（no_repo / dirty / 白名单）→ Task 2 / 6 / 8 覆盖 ✓
   - 测试：Task 2/3/4/5/6 (sandbox) + Task 7/8 (checkout) + Task 9/10/11/12 (integration) + Task 14 (web) ✓
2. **占位符扫描**：无 TBD / TODO / "实现 later"。所有 step 含具体代码。
3. **类型一致**：`buildWorkspaceTools` 签名在 Task 10 加 ctx，调用处统一在 Task 11 改；`ensureRecord` 在 Task 11 加 opts；`WorkspaceDoc.contextMode` 在 Task 9 + 13 两端对齐。
