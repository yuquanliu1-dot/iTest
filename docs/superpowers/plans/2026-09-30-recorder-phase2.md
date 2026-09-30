# 录制增强二期：录制模式 + 多标签页 + 组件识别 + 密码加密 + 上传回放 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CueCast 文档里的 P2（录制模式）、P3（多标签页）、P4（组件识别）、P5（密码加密 + 上传真回放）一次性补齐，让录制真正成为「沉淀测试资产」的入口。

**Architecture:** 三层各自扩展、契约只有 `packages/shared` 的 DSL 与 `apps/api` 的 HTTP/WS 协议：shared 定义 SwitchTabAction / UploadAction.fileId / FillAction.sensitive；api 负责加密模块、上传附件端点、tab-events 落库、执行器真回放、resume 前置回放；recorder 扩展 background 状态机 + tab 路由 + selector-filter 与 component-detector；web 负责步骤维护面板（密码切换 / 上传绑定 / 录制模式入口）。

**Tech Stack:** Turborepo + pnpm workspaces；shared/api/recorder 用 vitest；api 用 Express 5 + Drizzle + zod + playwright-core；recorder 为 MV3 扩展（vanilla JS popup + content script）；web 为 React 18 + zustand + react-query。

**Spec:** `docs/superpowers/specs/2026-09-30-recorder-phase2-design.md`

---

## 文件结构

**shared（契约层）**
- Modify: `packages/shared/src/step-dsl.ts` — 新增 SwitchTabAction、UploadAction.fileId、FillAction.sensitive
- Modify: `packages/shared/src/index.ts` — 重新导出（若需要）

**api（编译 + 执行 + 接口 + 数据库）**
- Modify: `apps/api/src/db/schema.ts` — testSteps 加 tab_ref / sensitive / component_kind / secret_* 列；新增 testAttachments / testSessions.mode+incognito+resumeFromOrder / testSessionTabs
- Create: `apps/api/drizzle/0002_*.sql`（db:generate 产出）
- Create: `apps/api/src/lib/secret-crypto.ts` — AES-256-GCM 加密解密模块
- Create: `apps/api/src/lib/attachments.ts` — multipart 接收 + sha256 + 落盘 + 复用
- Modify: `apps/api/src/recorder/ws.ts` — RecorderSession 加 mode/incognito/resumeFromOrder/tabs；ws 信封加 tabRef/componentKind；ws.onmessage 加 tab-events 分发
- Modify: `apps/api/src/routes/recorder.ts` — POST /sessions 接 mode/resumeFromOrder/incognito；POST /sessions/:id/finish 写 tabRef/componentKind；POST /sessions/:id/tab-events
- Modify: `apps/api/src/routes/steps.ts` — PUT /cases/:id/steps 加密敏感字段 + 校验 upload.fileId 存在
- Create: `apps/api/src/routes/secrets.ts` — GET /cases/:id/steps/secrets/:stepId（专用鉴权）
- Modify: `apps/api/src/execute/cdp.ts` — dispatch 新分支 switchTab；upload 真回放；fill sensitive 走 decrypt
- Modify: `apps/api/src/execute/runCase.ts` — steps 映射带上 tabRef/componentKind/sensitive 字段
- Modify: `apps/api/src/lib/resolve-url.ts` — 不变
- Modify: `apps/api/test/helpers/db.ts` — SCHEMA_SQL 加新列 + 新表
- Modify: `apps/api/test/*.test.ts` — 各测试表 DDL 同步

**recorder（采集 + 面板）**
- Modify: `apps/recorder/modules/selector-core.ts` — generateLocators 加 filterUnstableAttrs
- Create: `apps/recorder/modules/selector-filter.ts` — filterUnstableAttrs 实现
- Create: `apps/recorder/modules/component-detector.ts` — detectComponent 静态嗅探
- Modify: `apps/recorder/modules/recorder-manager.ts` — RecordedStep 加 tabRef/componentKind/sensitive；onChange 命中 select 查组件类；onInput 命中 password 标 sensitive；upload 不上送 fileId
- Modify: `apps/recorder/modules/picker.ts` — PickResult 加 componentHint
- Modify: `apps/recorder/background.js` — 会话模式状态机 + tab 路由 + switch-tab 信封 + incognito
- Modify: `apps/recorder/content/recorder.js` — start 信封带 mode；emit-step 带 tabRef/componentKind
- Modify: `apps/recorder/popup/popup.html` / `popup.js` / `popup.css` — 模式展示 + tab 列表按钮
- Modify: `apps/recorder/popup/panel.html` / `panel.js` / `panel.css` — tab 切换预览

**web（步骤维护 + 录制入口）**
- Modify: `apps/web/src/api/client.ts` — TestStep 加 tabRef/componentKind；attachment 上传 API；secrets 取值 API；createSession 接 mode/resumeFromOrder
- Modify: `apps/web/src/components/StepEditModal.tsx` — fill 敏感值开关 + upload 绑定 + 展示 tabRef/componentKind
- Modify: `apps/web/src/pages/CaseDetail.tsx` — 录制按钮下拉（全新/追加/从这里开始/无痕）；步骤行「从这里开始」入口；resume 弹窗
- Modify: `apps/web/src/pages/ReportDetail.tsx` — 按 tabIndex 分组展示

---

## Task 1: shared — DSL 扩展（SwitchTab / Upload.fileId / Fill.sensitive）

**Files:**
- Modify: `packages/shared/src/step-dsl.ts`
- Test: `packages/shared/test/step-dsl.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `packages/shared/test/step-dsl.test.ts`：

```ts
describe('step-dsl — phase2 new kinds', () => {
  it('accepts switchTab action', () => {
    const r = StepAction.safeParse({
      kind: 'switchTab',
      tabRef: 'session-abc|tab#1',
    });
    expect(r.success).toBe(true);
  });

  it('accepts upload action with required fileId', () => {
    const ok = StepAction.safeParse({
      kind: 'upload',
      locator: [{ strategy: 'css', value: 'input[type=file]' }],
      fileId: 'att-1',
    });
    expect(ok.success).toBe(true);
    const noFile = StepAction.safeParse({
      kind: 'upload',
      locator: [{ strategy: 'css', value: 'input[type=file]' }],
    });
    expect(noFile.success).toBe(false);
  });

  it('accepts fill action with sensitive flag', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: 'input[type=password]' }],
      value: 'placeholder-not-stored',
      sensitive: true,
    });
    expect(r.success).toBe(true);
  });

  it('accepts fill without sensitive flag (existing behavior)', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: 'alice',
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/shared test`
Expected: 新用例 FAIL（switchTab/upload.fileId/fill.sensitive 不被识别）

- [ ] **Step 3: 修改 step-dsl.ts**

在 `FillAction` 改为：

```ts
export const FillAction = z.object({
  kind: z.literal('fill'),
  locator: z.array(Locator).min(1),
  value: FillValue,
  sensitive: z.boolean().optional(),
});
```

`UploadAction` 改为（移除 fileName、加 fileId）：

```ts
export const UploadAction = z.object({
  kind: z.literal('upload'),
  locator: z.array(Locator).min(1),
  fileId: z.string().min(1),
});
```

新增 `SwitchTabAction`：

```ts
export const SwitchTabAction = z.object({
  kind: z.literal('switchTab'),
  tabRef: z.string().min(1).max(64),
});
```

`StepAction` 类型与 zod 联合两处都要追加 SwitchTabAction，并把 UploadAction 替换（fileName → fileId）。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm --filter @itest/shared test && pnpm --filter @itest/shared typecheck`
Expected: PASS（api 引用 UploadAction.fileName 处会 typecheck 报错，属预期，Task 3 修）

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/step-dsl.ts packages/shared/test/step-dsl.test.ts
git commit -m "feat(shared): phase2 DSL — switchTab + upload.fileId + fill.sensitive"
```

---

## Task 2: api — 加密 / 解密模块（secret-crypto）

**Files:**
- Create: `apps/api/src/lib/secret-crypto.ts`
- Test: `apps/api/test/secret-crypto.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `apps/api/test/secret-crypto.test.ts`：

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { encrypt, decrypt, ensureKeyLoaded } from '../src/lib/secret-crypto.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  ensureKeyLoaded();
});

describe('secret-crypto', () => {
  it('roundtrips plaintext', () => {
    const { ciphertext, iv, tag } = encrypt('hunter2');
    expect(decrypt({ ciphertext, iv, tag })).toBe('hunter2');
  });

  it('different ivs produce different ciphertexts for same plaintext', () => {
    const a = encrypt('same');
    const b = encrypt('same');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it('tampered tag fails decryption', () => {
    const { ciphertext, iv, tag } = encrypt('secret');
    const tampered = Buffer.from(tag);
    tampered[0] = tampered[0]! ^ 1;
    expect(() => decrypt({ ciphertext, iv, tag: tampered })).toThrow(/decrypt/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- secret-crypto`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 secret-crypto.ts**

新建 `apps/api/src/lib/secret-crypto.ts`：

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

let cachedKey: Buffer | null = null;

export function ensureKeyLoaded(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ENCRYPTION_KEY is not set (base64-encoded 32 bytes required for AES-256-GCM)');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  cachedKey = key;
  return key;
}

export function encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const key = ensureKeyLoaded();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

export function decrypt(parts: { ciphertext: Buffer; iv: Buffer; tag: Buffer }): string {
  const key = ensureKeyLoaded();
  const decipher = createDecipheriv(ALG, key, parts.iv);
  decipher.setAuthTag(parts.tag);
  try {
    const out = Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
    return out.toString('utf8');
  } catch (e) {
    throw new Error(`decrypt failed: ${(e as Error).message}`);
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm --filter @itest/api test -- secret-crypto && pnpm --filter @itest/api typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/secret-crypto.ts apps/api/test/secret-crypto.test.ts
git commit -m "feat(api): AES-256-GCM secret encryption module"
```

---

## Task 3: api — 数据库迁移（schema + 新表）

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0002_*.sql`（db:generate 产出）
- Modify: `apps/api/test/helpers/db.ts`
- Modify: `apps/api/test/*.test.ts`（含 test_steps 建表的所有文件）

- [ ] **Step 1: 修改 schema.ts**

`apps/api/src/db/schema.ts`：

`testSteps` 加列（在 `action` 之前）：

```ts
  tabRef: varchar('tab_ref', { length: 64 }),
  sensitive: boolean('sensitive').notNull().default(false),
  componentKind: varchar('component_kind', { length: 32 }),
  secretCiphertext: text('secret_ciphertext'),
  secretIv: text('secret_iv'),
  secretTag: text('secret_tag'),
```

`text` 列存 base64；如需原生 bytea 用 `bytea` + `Buffer` 转换（保持简单先用 text/base64，executor 再解码）。

顶部 import 加 `text`。

新增表（放在文件末尾）：

```ts
export const testAttachments = pgTable('test_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  stepId: uuid('step_id').references(() => testSteps.id, { onDelete: 'set null' }),
  originalName: text('original_name').notNull(),
  mime: text('mime'),
  size: integer('size').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull().unique(),
  storedPath: text('stored_path').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const testSessions = pgTable('test_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  mode: varchar('mode', { length: 16 }).notNull().default('fresh'),
  incognito: boolean('incognito').notNull().default(false),
  resumeFromOrder: integer('resume_from_order'),
  tabs: jsonb('tabs'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

- [ ] **Step 2: 生成迁移**

Run: `pnpm --filter @itest/api db:generate`
Expected: `apps/api/drizzle/0002_*.sql` 文件新增，包含 test_steps 的 ALTER TABLE 加列、CREATE TABLE test_attachments、CREATE TABLE test_sessions。记录生成的文件名。

- [ ] **Step 3: 更新测试 SCHEMA_SQL**

修改 `apps/api/test/helpers/db.ts` 的 SCHEMA_SQL（line 9）：

- `test_steps` 行追加 `tab_ref varchar(64), sensitive boolean NOT NULL DEFAULT false, component_kind varchar(32), secret_ciphertext text, secret_iv text, secret_tag text`
- 在文件末尾追加：

```sql
CREATE TABLE test_attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, step_id uuid REFERENCES test_steps(id) ON DELETE SET NULL, original_name text NOT NULL, mime text, size integer NOT NULL, sha256 varchar(64) NOT NULL UNIQUE, stored_path text NOT NULL, created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE test_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, mode varchar(16) NOT NULL DEFAULT 'fresh', incognito boolean NOT NULL DEFAULT false, resume_from_order integer, tabs jsonb, created_at timestamp NOT NULL DEFAULT now());
```

- [ ] **Step 4: typecheck + 全 api 测试**

Run: `pnpm --filter @itest/api typecheck && pnpm --filter @itest/api test`
Expected: 全 PASS（schema 与测试容器一致）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/ apps/api/test/helpers/db.ts
git commit -m "feat(api): test_steps phase2 columns + test_attachments + test_sessions"
```

---

## Task 4: api — 附件上传模块（multipart + sha256 幂等）

**Files:**
- Create: `apps/api/src/lib/attachments.ts`
- Test: `apps/api/test/attachments.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `apps/api/test/attachments.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pgContainer: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = pgContainer.getConnectionUri();
  process.env.UPLOAD_DIR = '/tmp/itest-uploads-' + Date.now();
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { attachmentsRoute } = await import('../src/routes/attachments.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use('/api/cases', casesRoute);
  app.use('/api/cases', attachmentsRoute);
  app.use(express.json());
  app.use(express.raw({ type: 'application/octet-stream', limit: '60mb' }));
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await pgContainer.stop();
});

describe('attachments', () => {
  it('uploads file and returns sha256 + id', async () => {
    const { caseId } = await seedCase(pool);
    const buf = Buffer.from('hello world');
    const r = await request(app)
      .post(`/api/cases/${caseId}/attachments`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Filename', 'hello.txt')
      .send(buf);
    expect(r.status).toBe(200);
    expect(r.body.sha256).toHaveLength(64);
    expect(r.body.originalName).toBe('hello.txt');
    expect(r.body.size).toBe(buf.length);
  });

  it('same content uploaded twice returns the same record', async () => {
    const { caseId } = await seedCase(pool);
    const buf = Buffer.from('dup-content');
    const r1 = await request(app).post(`/api/cases/${caseId}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'a.txt').send(buf);
    const r2 = await request(app).post(`/api/cases/${caseId}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'b.txt').send(buf);
    expect(r1.body.id).toBe(r2.body.id);
  });

  it('rejects oversize upload', async () => {
    const { caseId } = await seedCase(pool);
    process.env.UPLOAD_MAX_BYTES = '10';
    const buf = Buffer.alloc(64, 1);
    const r = await request(app).post(`/api/cases/${caseId}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'big.bin').send(buf);
    expect(r.status).toBe(413);
    process.env.UPLOAD_MAX_BYTES = undefined;
  });
});

async function seedCase(pool: Pool): Promise<{ caseId: string }> {
  const { projectId, groupId } = await seedProject(pool);
  const c = await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1, 'C') RETURNING id`, [groupId]);
  return { caseId: c.rows[0]!.id as string };
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- attachments`
Expected: FAIL（路由与模块都不存在）

- [ ] **Step 3: 实现 attachments.ts**

新建 `apps/api/src/lib/attachments.ts`：

```ts
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(process.cwd(), '.data', 'uploads');
export const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES ?? 52428800);

export interface PreparedUpload {
  sha256: string;
  storedPath: string;
  size: number;
}

export function ensureUploadDir(): Promise<void> {
  return mkdir(UPLOAD_DIR, { recursive: true });
}

export async function persistUpload(buf: Buffer): Promise<PreparedUpload> {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  // 按 sha256 前两位分桶，避免单目录文件过多
  const storedPath = join(UPLOAD_DIR, sha256.slice(0, 2), sha256);
  await mkdir(join(UPLOAD_DIR, sha256.slice(0, 2)), { recursive: true });
  await writeFile(storedPath, buf);
  return { sha256, storedPath, size: buf.length };
}
```

新建 `apps/api/src/routes/attachments.ts`：

```ts
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testCases, testAttachments } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { persistUpload, UPLOAD_MAX_BYTES, ensureUploadDir } from '../lib/attachments.js';

export const attachmentsRoute = Router();

attachmentsRoute.post('/:caseId/attachments', async (req, res) => {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf)) throw new HttpError(400, 'bad_request', 'expected octet-stream body');
  if (buf.length > UPLOAD_MAX_BYTES) throw new HttpError(413, 'too_large', `file exceeds ${UPLOAD_MAX_BYTES} bytes`);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const originalName = (req.header('x-filename') ?? 'upload.bin').slice(0, 200);
  const mime = req.header('content-type') ?? null;

  await ensureUploadDir();
  const { sha256, storedPath, size } = await persistUpload(buf);

  // 同一 sha256 全局复用
  const existing = await db.select().from(testAttachments).where(eq(testAttachments.sha256, sha256));
  if (existing.length > 0) {
    const row = existing[0]!;
    res.json({ id: row.id, sha256, originalName: row.originalName, size: row.size });
    return;
  }
  const inserted = await db
    .insert(testAttachments)
    .values({
      caseId: req.params.caseId,
      originalName,
      mime,
      size,
      sha256,
      storedPath,
    })
    .returning();
  res.json({ id: inserted[0]!.id, sha256, originalName, size });
});
```

挂载到 server（`apps/api/src/index.ts` 或 `server.ts`）：找到现有 `app.use('/api/...', ...)`，新增一行：

```ts
import { attachmentsRoute } from './routes/attachments.js';
// ...
app.use('/api/cases', attachmentsRoute);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/api test -- attachments`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/attachments.ts apps/api/src/routes/attachments.ts apps/api/src/index.ts apps/api/test/attachments.test.ts
git commit -m "feat(api): attachments upload with sha256 deduplication"
```

---

## Task 5: api — 步骤 PUT 加密敏感字段 + upload.fileId 校验

**Files:**
- Modify: `apps/api/src/routes/steps.ts`
- Test: 追加到 `apps/api/test/cases.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `apps/api/test/cases.test.ts` 的 describe 内：

```ts
beforeAll 块里 import 区域加 `import { attachmentsRoute } from '../src/routes/attachments.js';` 并在 app 上 `app.use('/api/cases', attachmentsRoute);`（与 Task 4 一致）。下面补测试用例：

```ts
  it('PUT stores sensitive fill as ciphertext and never echoes plaintext', async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    const { ensureKeyLoaded } = await import('../src/lib/secret-crypto.js');
    ensureKeyLoaded();
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'S' });
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: {
            kind: 'fill',
            locator: [{ strategy: 'css', value: 'input[type=password]' }],
            value: 'super-secret',
            sensitive: true,
          },
          source: 'manual',
        },
      ],
    });
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain('super-secret');
    const got = await request(app).get(`/api/cases/${c.body.id}`);
    expect(JSON.stringify(got.body)).not.toContain('super-secret');
  });

  it('PUT rejects upload step with unknown fileId', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'U' });
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: 'no-such' },
          source: 'manual',
        },
      ],
    });
    expect(r.status).toBe(422);
  });

  it('PUT accepts upload step with valid fileId', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'U2' });
    const buf = Buffer.from('file-body');
    const up = await request(app).post(`/api/cases/${c.body.id}/attachments`).set('Content-Type', 'application/octet-stream').set('X-Filename', 'x.bin').send(buf);
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: up.body.id },
          source: 'manual',
        },
      ],
    });
    expect(r.status).toBe(200);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- cases`
Expected: 新用例 FAIL（PUT 路径尚未处理 sensitive 与 upload.fileId）

- [ ] **Step 3: 修改 steps.ts**

PUT 路由 (`stepsRoute.put('/:caseId/steps', ...)`) 内：

- import 区加：

```ts
import { encrypt, ensureKeyLoaded } from '../lib/secret-crypto.js';
import { eq } from 'drizzle-orm';
import { testAttachments } from '../db/schema.js';
```

- 在 `const failedAi = ...` 之后、transaction 之前：

```ts
  // 校验 upload.fileId 与 sensitive 加密
  const uploadedFileIds = new Set<string>();
  for (const s of body.steps) {
    const a = s.action as { kind?: string; fileId?: string; value?: unknown; sensitive?: boolean };
    if (a.kind === 'upload') {
      const fileId = a.fileId;
      if (!fileId) throw new HttpError(422, 'upload_no_file', 'upload step requires fileId');
      const row = await db.select().from(testAttachments).where(eq(testAttachments.id, fileId));
      if (row.length === 0) throw new HttpError(422, 'upload_unknown_file', `attachment ${fileId} not found`);
      uploadedFileIds.add(fileId);
    }
    if (a.kind === 'fill' && a.sensitive) {
      ensureKeyLoaded(); // fail-fast
    }
  }
```

- `values(...)` 映射改为：

```ts
        body.steps.map((s, i) => {
          const a = s.action as { kind?: string; value?: unknown; sensitive?: boolean };
          let secretCiphertext: string | null = null;
          let secretIv: string | null = null;
          let secretTag: string | null = null;
          let storedAction: unknown = s.action;
          if (a.kind === 'fill' && a.sensitive) {
            const enc = encrypt(String(a.value ?? ''));
            secretCiphertext = enc.ciphertext.toString('base64');
            secretIv = enc.iv.toString('base64');
            secretTag = enc.tag.toString('base64');
            storedAction = { kind: 'fill', locator: a.value, value: '__sensitive__', sensitive: true };
            // 用占位符替换明文：原 action 不再含 plaintext
            storedAction = { ...(s.action as object), value: '__sensitive__' };
          }
          return {
            caseId: req.params.caseId,
            order: i + 1,
            source: s.source,
            action: storedAction as object,
            name: s.name ?? null,
            delayMs: s.delayMs ?? null,
            sensitive: a.kind === 'fill' && !!a.sensitive,
            secretCiphertext,
            secretIv,
            secretTag,
          };
        }),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/api test -- cases`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/steps.ts apps/api/test/cases.test.ts
git commit -m "feat(api): steps PUT encrypts sensitive fills + validates upload.fileId"
```

---

## Task 6: api — 扩展专用 secret 取值接口

**Files:**
- Create: `apps/api/src/routes/secrets.ts`
- Modify: `apps/api/src/index.ts`（挂载新路由）
- Test: 追加到 `apps/api/test/cases.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `apps/api/test/cases.test.ts` describe 内（先用 PUT 步骤拿到 stepId，再调 GET）：

```ts
  it('GET /api/cases/:id/steps/secrets/:stepId returns plaintext for recorder token', async () => {
    process.env.RECORDER_TOKEN_SECRET = 'dev-secret-change-me';
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'SC' });
    const put = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: {
            kind: 'fill',
            locator: [{ strategy: 'css', value: 'input[type=password]' }],
            value: 'open-sesame',
            sensitive: true,
          },
          source: 'manual',
        },
      ],
    });
    const stepId = put.body.steps[0].id;
    const r = await request(app)
      .get(`/api/cases/${c.body.id}/steps/secrets/${stepId}`)
      .set('Authorization', 'Bearer dev-secret-change-me');
    expect(r.status).toBe(200);
    expect(r.body.value).toBe('open-sesame');
  });

  it('GET secrets without token returns 403', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'SN' });
    const put = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: {
            kind: 'fill',
            locator: [{ strategy: 'css', value: '#x' }],
            value: 'v',
            sensitive: true,
          },
          source: 'manual',
        },
      ],
    });
    const stepId = put.body.steps[0].id;
    const r = await request(app).get(`/api/cases/${c.body.id}/steps/secrets/${stepId}`);
    expect(r.status).toBe(403);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- cases`
Expected: FAIL（路由不存在）

- [ ] **Step 3: 实现 secrets.ts**

新建 `apps/api/src/routes/secrets.ts`：

```ts
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testCases, testSteps } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { decrypt } from '../lib/secret-crypto.js';

export const secretsRoute = Router();

const TOKEN = process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me';

secretsRoute.get('/:caseId/steps/secrets/:stepId', async (req, res) => {
  const auth = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (auth !== TOKEN) throw new HttpError(403, 'forbidden', 'recorder token required');
  const caseRow = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (caseRow.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const rows = await db.select().from(testSteps).where(eq(testSteps.id, req.params.stepId));
  const step = rows[0];
  if (!step || step.caseId !== req.params.caseId) throw new HttpError(404, 'not_found', 'step not found');
  if (!step.sensitive || !step.secretCiphertext || !step.secretIv || !step.secretTag) {
    throw new HttpError(422, 'not_sensitive', 'step has no encrypted secret');
  }
  const value = decrypt({
    ciphertext: Buffer.from(step.secretCiphertext, 'base64'),
    iv: Buffer.from(step.secretIv, 'base64'),
    tag: Buffer.from(step.secretTag, 'base64'),
  });
  res.json({ value });
});
```

挂载到 `apps/api/src/index.ts`：

```ts
import { secretsRoute } from './routes/secrets.js';
// ...
app.use('/api/cases', secretsRoute);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/api test -- cases`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/secrets.ts apps/api/src/index.ts apps/api/test/cases.test.ts
git commit -m "feat(api): recorder-only secrets retrieval endpoint"
```

---

## Task 7: api — WS 协议扩展（tabRef/componentKind + 录制模式 + tab-events）

**Files:**
- Modify: `apps/api/src/recorder/ws.ts`
- Test: 追加到新建 `apps/api/test/recorder-ws.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `apps/api/test/recorder-ws.test.ts`：

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { attachRecorderWs, createSession, getSession } from '../src/recorder/ws.js';
import { Server } from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';

let port: number;
let server: Server;

beforeAll(async () => {
  server = new Server();
  attachRecorderWs(server);
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as AddressInfo).port;
});

describe('recorder/ws envelope', () => {
  it('accepts step with tabRef and componentKind', async () => {
    const session = createSession('00000000-0000-0000-0000-000000000aaa');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/recorder?sessionId=${session.sessionId}&token=dev-secret-change-me`);
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    ws.send(JSON.stringify({
      type: 'step',
      step: {
        action: { kind: 'click', locator: [{ strategy: 'css', value: '#x' }] },
        url: 'https://example.com',
        tabRef: `${session.sessionId}|tab#0`,
        componentKind: 'select',
      },
    }));
    await new Promise((r) => setTimeout(r, 50));
    const got = getSession(session.sessionId)!;
    expect(got.steps).toHaveLength(1);
    expect((got.steps[0] as { tabRef: string }).tabRef).toBe(`${session.sessionId}|tab#0`);
    expect((got.steps[0] as { componentKind: string }).componentKind).toBe('select');
    ws.close();
  });

  it('accepts tab-event messages and appends to session.tabs', async () => {
    const session = createSession('00000000-0000-0000-0000-000000000bbb');
    session.mode = 'fresh';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/recorder?sessionId=${session.sessionId}&token=dev-secret-change-me`);
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    ws.send(JSON.stringify({
      type: 'tab-event',
      event: { kind: 'opened', tabRef: `${session.sessionId}|tab#1`, title: 'child', url: 'https://example.com/c' },
    }));
    await new Promise((r) => setTimeout(r, 50));
    const got = getSession(session.sessionId)!;
    expect(got.tabs).toBeDefined();
    expect(got.tabs!.some((t) => t.tabRef === `${session.sessionId}|tab#1`)).toBe(true);
    ws.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- recorder-ws`
Expected: FAIL（tabRef/componentKind/tab-event 不被识别）

- [ ] **Step 3: 修改 ws.ts**

`apps/api/src/recorder/ws.ts`：

`RecorderSession` 接口扩展：

```ts
export interface RecorderTabEvent {
  kind: 'opened' | 'closed';
  tabRef: string;
  title?: string;
  url?: string;
}

export interface RecorderSession {
  sessionId: string;
  caseId: string;
  steps: unknown[];
  ws?: WebSocket;
  mode?: 'fresh' | 'append' | 'resume' | 'incognito';
  incognito?: boolean;
  resumeFromOrder?: number;
  tabs?: RecorderTabEvent[];
}
```

`createSession` 加默认值：

```ts
export function createSession(caseId: string, opts: { mode?: 'fresh'|'append'|'resume'|'incognito'; incognito?: boolean; resumeFromOrder?: number } = {}): RecorderSession {
  const session: RecorderSession = {
    sessionId: crypto.randomUUID(),
    caseId,
    steps: [],
    mode: opts.mode ?? 'fresh',
    incognito: opts.incognito ?? false,
    resumeFromOrder: opts.resumeFromOrder,
    tabs: [],
  };
  sessions.set(session.sessionId, session);
  return session;
}
```

ws.onmessage 改为：

```ts
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'step') session.steps.push(msg.step);
          else if (msg.type === 'tab-event' && session.tabs) session.tabs.push(msg.event);
          else if (msg.type === 'finish') ws.close(1000);
        } catch {
          // ignore malformed
        }
      });
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm --filter @itest/api test -- recorder-ws && pnpm --filter @itest/api typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/recorder/ws.ts apps/api/test/recorder-ws.test.ts
git commit -m "feat(api): recorder ws accepts tabRef/componentKind + tab-events"
```

---

## Task 8: api — 录制 session 创建 + finish 写入元数据

**Files:**
- Modify: `apps/api/src/routes/recorder.ts`
- Test: 追加到 `apps/api/test/cases.test.ts`（用 supertest 直接打 httptest 与 ws）

- [ ] **Step 1: 写失败测试**

新增 `apps/api/test/recorder-route.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { recorderRoute } = await import('../src/routes/recorder.js');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use('/api/cases', casesRoute);
  app.use('/api', recorderRoute);
  app.use(express.json());
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await pg.stop();
});

describe('recorder routes', () => {
  it('POST /api/recorder/sessions accepts mode/incognito/resumeFromOrder', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'R' });
    const r = await request(app).post('/api/recorder/sessions').send({
      caseId: c.body.id,
      mode: 'incognito',
      incognito: true,
      resumeFromOrder: 3,
    });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('incognito');
  });

  it('resume with upload step lacking fileId returns 409', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'RU' });
    await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: { kind: 'click', locator: [{ strategy: 'css', value: '#x' }] },
          source: 'manual',
        },
      ],
    });
    // 强行造一个缺 fileId 的 upload step（绕过 PUT 校验）
    await pool.query(`UPDATE test_steps SET action = $1 WHERE case_id = $2`, [
      JSON.stringify({ kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }] }),
      c.body.id,
    ]);
    const r = await request(app).post('/api/recorder/sessions').send({
      caseId: c.body.id,
      mode: 'resume',
      resumeFromOrder: 1,
    });
    expect(r.status).toBe(409);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- recorder-route`
Expected: FAIL（mode/resume 未识别）

- [ ] **Step 3: 修改 recorder.ts**

`apps/api/src/routes/recorder.ts`：

- import 加 `testSteps, testAttachments`；
- CreateBody 扩展：

```ts
const CreateBody = z.object({
  caseId: z.string().uuid(),
  mode: z.enum(['fresh', 'append', 'resume', 'incognito']).default('fresh'),
  incognito: z.boolean().optional(),
  resumeFromOrder: z.number().int().positive().optional(),
});
```

- `POST /sessions` 改为：

```ts
recorderRoute.post('/sessions', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, body.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  if (body.mode === 'resume') {
    const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, body.caseId));
    const upto = body.resumeFromOrder ?? steps.length;
    const slice = steps.filter((s) => s.order < upto);
    for (const s of slice) {
      const a = (s.action ?? {}) as { kind?: string; fileId?: string };
      if (a.kind === 'upload') {
        if (!a.fileId) throw new HttpError(409, 'upload_unbound', `upload step #${s.order} has no fileId bound`);
        const att = await db.select().from(testAttachments).where(eq(testAttachments.id, a.fileId));
        if (att.length === 0) throw new HttpError(409, 'upload_missing', `attachment ${a.fileId} not found`);
      }
    }
  }
  const resolvedUrl = await resolveCaseUrl(exists[0]!);
  const session = createSession(body.caseId, {
    mode: body.mode,
    incognito: body.incognito ?? body.mode === 'incognito',
    resumeFromOrder: body.resumeFromOrder,
  });
  // 也把会话记录落到 test_sessions 表，便于审计
  await db.insert(testSessions).values({
    caseId: body.caseId,
    mode: body.mode,
    incognito: body.incognito ?? body.mode === 'incognito',
    resumeFromOrder: body.resumeFromOrder ?? null,
  });
  res.json({
    sessionId: session.sessionId,
    wsToken: process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me',
    wsUrl: `ws://127.0.0.1:${process.env.API_PORT ?? 54321}/recorder`,
    resolvedUrl,
    mode: body.mode,
  });
});
```

- import 区加 `testSessions`；
- finish 路由扩展：写 step 时带 tabRef/componentKind（若存在）：

```ts
recorderRoute.post('/sessions/:id/finish', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) throw new HttpError(404, 'not_found', 'session not found');
  session.ws?.close(1000, 'finished');
  await compileAiStepsInPlace(
    session.steps.map((s) => {
      const item = s as { action: unknown; url?: string };
      return { action: item.action, url: item.url };
    }),
  );
  let inserted = 0;
  const existing = await db.select().from(testSteps).where(eq(testSteps.caseId, session.caseId));
  let nextOrder = existing.length > 0 ? Math.max(...existing.map((s) => s.order)) + 1 : 1;
  for (const step of session.steps) {
    const item = step as { action: unknown; tabRef?: string; componentKind?: string };
    StepAction.parse(item.action);
    await db.insert(testSteps).values({
      caseId: session.caseId,
      order: nextOrder++,
      source: 'recorder',
      action: item.action as object,
      tabRef: item.tabRef ?? null,
      componentKind: item.componentKind ?? null,
    });
    inserted++;
  }
  // 写 session.tabs
  if (session.tabs && session.tabs.length > 0) {
    await db.update(testSessions).set({ tabs: session.tabs }).where(eq(testSessions.caseId, session.caseId));
  }
  res.json({ inserted });
});
```

- 新增路由：

```ts
recorderRoute.post('/sessions/:id/tab-events', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) throw new HttpError(404, 'not_found', 'session not found');
  const body = z.object({
    events: z.array(z.object({
      kind: z.enum(['opened', 'closed']),
      tabRef: z.string().min(1).max(64),
      title: z.string().optional(),
      url: z.string().optional(),
    })),
  }).parse(req.body);
  if (!session.tabs) session.tabs = [];
  session.tabs.push(...body.events);
  res.json({ count: session.tabs.length });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/api test -- recorder-route`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/recorder.ts apps/api/test/recorder-route.test.ts
git commit -m "feat(api): recorder session modes + tab-events + tabRef/componentKind persistence"
```

---

## Task 9: api — 执行器 switchTab + upload 真回放 + sensitive 走解密

**Files:**
- Modify: `apps/api/src/execute/cdp.ts`
- Test: 追加到 `apps/api/test/execute-cdp.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `apps/api/test/execute-cdp.test.ts` describe 内：

```ts
  it('switchTab action uses tabMap to switch the page context', async () => {
    const ctxNewPage = vi.fn().mockResolvedValue({ bringToFront: vi.fn().mockResolvedValue(undefined) });
    const ctx = { newPage: ctxNewPage, storageState: vi.fn().mockResolvedValue({}) };
    mocked.__page.bringToFront = vi.fn().mockResolvedValue(undefined);
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000010',
      [{ order: 1, action: { kind: 'switchTab', tabRef: 'session-x|tab#1' } }],
      { reportId: 'r-switch', tabMap: new Map([['session-x|tab#1', mocked.__page]]) },
    );
    expect(mocked.__page.bringToFront).toHaveBeenCalled();
  });

  it('switchTab without matching tabMap entry fails with tab-missing', async () => {
    const r = await executeCaseReal(
      '00000000-0000-0000-0000-000000000011',
      [{ order: 1, action: { kind: 'switchTab', tabRef: 'session-x|tab#9' } }],
      { reportId: 'r-miss', tabMap: new Map() },
    );
    expect(r[0]!.status).toBe('failed');
    expect(r[0]!.error).toMatch(/tab-missing/);
  });

  it('upload action calls setInputFiles with stored_path', async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    const { db } = await import('../src/db/client.js');
    const { testCases, testAttachments } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    // 起一个真实容器跑这一步以写入 attachment
    // 为简化，直接调持久化层：
    const { persistUpload } = await import('../src/lib/attachments.js');
    const { mkdir } = await import('node:fs/promises');
    process.env.UPLOAD_DIR = '/tmp/itest-up-' + Date.now();
    await mkdir(process.env.UPLOAD_DIR!, { recursive: true });
    const { sha256, storedPath, size } = await persistUpload(Buffer.from('X'));
    // 在真实 db 里建一条 attachment 记录
    const seed = await import('./helpers/db.js');
    const { groupId } = await seed.seedProject((await import('pg')).default ? ((globalThis as unknown) as never) : ((globalThis as unknown) as never));
    // fallback：跳过真实 db 写入，直接 mock 文件系统路径解析
    // 直接构造 setInputFiles 用 stub locator
    const setInputFiles = vi.fn().mockResolvedValue(undefined);
    const loc = { setInputFiles };
    mocked.__locator.mockReturnValueOnce(loc as never);
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000012',
      [{ order: 1, action: { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: 'fake-id' } }],
      { reportId: 'r-up', attachmentResolver: async (id: string) => ({ storedPath: storedPath, originalName: 'x' }) },
    );
    expect(setInputFiles).toHaveBeenCalledWith(storedPath);
  });
```

为简化，把 attachmentResolver 作为可选上下文传入 executeCaseReal（默认 fallback 直接报错）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- execute-cdp`
Expected: FAIL（switchTab 未识别；tabMap 参数未声明）

- [ ] **Step 3: 修改 cdp.ts**

`apps/api/src/execute/cdp.ts`：

- import 加：

```ts
import { decrypt } from '../lib/secret-crypto.js';
import { testAttachments } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
```

- `ExecContext` 扩展：

```ts
export interface ExecContext {
  reportId: string;
  /** tabRef → Page */
  tabMap?: Map<string, Page>;
  /** fileId → { storedPath, originalName }，默认走 db 查询 */
  attachmentResolver?: (fileId: string) => Promise<{ storedPath: string; originalName: string } | null>;
  /** stepId → plaintext 解析器；默认从 secret_* 字段解 */
  secretResolver?: (stepId: string) => Promise<string | null>;
}
```

- `executeCaseReal` 签名改为接收 `stepId`（用于 secretResolver 回退）：

```ts
export async function executeCaseReal(
  caseId: string,
  steps: Array<{ order: number; action: unknown; delayMs?: number | null; tabRef?: string | null; componentKind?: string | null; id?: string; sensitive?: boolean; secretCiphertext?: string|null; secretIv?: string|null; secretTag?: string|null }>,
  ctx: ExecContext,
  targetUrl?: string,
): Promise<ExecStepResult[]> {
```

- dispatch 新增分支（case 'switchTab'、case 'upload'、fill sensitive）：

```ts
    case 'switchTab': {
      const page2 = ctx.tabMap?.get(action.tabRef);
      if (!page2) throw new Error(`tab-missing: ${action.tabRef}`);
      await page2.bringToFront();
      return;
    }
    case 'upload': {
      const meta = ctx.attachmentResolver
        ? await ctx.attachmentResolver(action.fileId)
        : ((await db.select().from(testAttachments).where(eq(testAttachments.id, action.fileId)))[0]
            ? { storedPath: (await db.select().from(testAttachments).where(eq(testAttachments.id, action.fileId)))[0]!.storedPath, originalName: (await db.select().from(testAttachments).where(eq(testAttachments.id, action.fileId)))[0]!.originalName }
            : null);
      if (!meta) throw new Error(`attachment-missing: ${action.fileId}`);
      await firstMatch(page, action.locator).setInputFiles(meta.storedPath, { timeout: 5000 });
      return;
    }
```

- fill 改为：检测 sensitive；走 secretResolver；非 sensitive 走原逻辑。

```ts
    case 'fill': {
      let value: string;
      if (action.sensitive) {
        if (!ctx.secretResolver) throw new Error('secret-missing: sensitive step has no secretResolver');
        const v = await ctx.secretResolver(action.sensitiveId ?? '');
        if (v == null) throw new Error(`secret-missing: no resolver value`);
        value = v;
      } else {
        value = materializeValue(action.value, vars);
      }
      await firstMatch(page, action.locator).fill(value, { timeout: 5000 });
      return;
    }
```

需要 FillAction 增加 sensitiveId 字段。先在 `packages/shared/src/step-dsl.ts` 加：

```ts
export const FillAction = z.object({
  kind: z.literal('fill'),
  locator: z.array(Locator).min(1),
  value: FillValue,
  sensitive: z.boolean().optional(),
  sensitiveId: z.string().uuid().optional(),
});
```

在 `apps/api/src/routes/steps.ts` PUT 路径下，给 storedAction 加 `sensitiveId`（指向新建 step 的 id）。

实际做法：在 insert 完成后获取 rows[0].id，更新 storedAction.sensitiveId；但这与 mapping 顺序耦合。简化：保持 storedAction 内的 `value` 为占位符；执行器另需知道 step id 才能调 secretResolver。两条路：

1. executor 接收的 steps 列表里带 `id` 字段（db 主键），由调用方从 db 取并传入；
2. executor 接收 `caseId + stepId-by-order`，自己查。

采用路 1：在 `runCase.ts` 内 select steps 时带上 id，传给 executeCaseReal。

修改 `runCase.ts`：

```ts
      steps.map((s) => ({
        order: s.order,
        action: s.action,
        delayMs: s.delayMs,
        tabRef: s.tabRef,
        componentKind: s.componentKind,
        sensitive: s.sensitive,
        secretCiphertext: s.secretCiphertext,
        secretIv: s.secretIv,
        secretTag: s.secretTag,
        id: s.id,
      })),
```

executor 的 secretResolver 默认实现（按 stepId 查表）：

```ts
async function defaultSecretResolver(stepId: string): Promise<string | null> {
  const rows = await db.select().from(testSteps).where(eq(testSteps.id, stepId));
  const s = rows[0];
  if (!s || !s.sensitive || !s.secretCiphertext) return null;
  return decrypt({
    ciphertext: Buffer.from(s.secretCiphertext, 'base64'),
    iv: Buffer.from(s.secretIv ?? '', 'base64'),
    tag: Buffer.from(s.secretTag ?? '', 'base64'),
  });
}
```

- `executeCaseReal` 主循环：

```ts
    const finalCtx: ExecContext = {
      ...ctx,
      secretResolver: ctx.secretResolver ?? defaultSecretResolver,
    };
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const started = Date.now();
      try {
        if (step.delayMs) await page.waitForTimeout(step.delayMs);
        // switchTab 需要传 tabMap
        const dispatchCtx: DispatchOpts & { tabMap?: Map<string, Page>; attachmentResolver?: ExecContext['attachmentResolver']; secretResolver?: ExecContext['secretResolver'] } = { page, vars, tabMap: ctx.tabMap, attachmentResolver: ctx.attachmentResolver, secretResolver: finalCtx.secretResolver };
        const warning = await dispatch(step.action as StepAction, dispatchCtx);
        ...
```

`dispatch` 签名同步扩展；为简洁，将 `ctx` 合并到 `opts`：

```ts
interface DispatchOpts {
  page: Page;
  vars: Record<string, string>;
  ctx: ExecContext;
}
```

`switchTab`、`upload`、sensitive fill 都从 `opts.ctx` 读。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/api test -- execute-cdp`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execute/cdp.ts apps/api/src/execute/runCase.ts packages/shared/src/step-dsl.ts apps/api/test/execute-cdp.test.ts
git commit -m "feat(api): executor phase2 — switchTab + upload setInputFiles + sensitive decrypt"
```

---

## Task 10: api — execute.ts 与 runPlan 接入新字段

**Files:**
- Modify: `apps/api/src/routes/execute.ts`
- Modify: `apps/api/src/execute/runPlan.ts`

- [ ] **Step 1: 检查 runPlan.ts**

```bash
grep -n "executeCaseReal\|s\.action\|s\.order" /Users/lyq/workdir/codedev/iTest/apps/api/src/execute/runPlan.ts
```

确认 runPlan 是否调用 executeCaseReal；如果调用，要把 step 字段映射扩展（与 Task 9 runCase.ts 一致）。

- [ ] **Step 2: 修改 execute.ts**

`apps/api/src/routes/execute.ts` 不动（不直接调 executeCaseReal）；runCase.ts 已在 Task 9 改。

- [ ] **Step 3: 修改 runPlan.ts（若调用 executeCaseReal）**

把传给 executeCaseReal 的 steps 列表加上 `id/tabRef/componentKind/sensitive/secret*` 字段。

- [ ] **Step 4: typecheck + 全 api 测试**

Run: `pnpm --filter @itest/api typecheck && pnpm --filter @itest/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execute/runPlan.ts
git commit -m "feat(api): runPlan threads phase2 step fields through executor"
```

---

## Task 11: recorder — selector-filter（动态属性过滤）

**Files:**
- Create: `apps/recorder/modules/selector-filter.ts`
- Test: `apps/recorder/test/selector-filter.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `apps/recorder/test/selector-filter.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { isStableCssPath, filterCssPath, stripRuntimeAria } from '../modules/selector-filter.js';

describe('selector-filter', () => {
  it('marks id with hex suffix as unstable', () => {
    expect(isStableCssPath('div#root-7f9c3a')).toBe(false);
    expect(isStableCssPath('div#root')).toBe(true);
  });
  it('filters out __BV_ and ivu- ids', () => {
    expect(isStableCssPath('div#__BV_btn_24')).toBe(false);
    expect(isStableCssPath('div.ivu-btn-large')).toBe(false);
  });
  it('filters state classes from css tokens', () => {
    const out = filterCssPath('button.btn.btn-primary.active');
    expect(out).not.toMatch(/active/);
    expect(out).toMatch(/btn-primary/);
  });
  it('stripRuntimeAria removes aria-controls / aria-describedby / aria-activedescendant', () => {
    expect(stripRuntimeAria('button[aria-controls="m1"][aria-label="x"]')).toBe('button[aria-label="x"]');
  });
  it('keeps css path non-empty after filtering', () => {
    const out = filterCssPath('button.active');
    expect(out.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/recorder test -- selector-filter`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 selector-filter.ts**

```ts
const STATE_CLASSES = new Set([
  'active', 'selected', 'disabled', 'hover', 'focus',
  'loading', 'open', 'show', 'checked', 'expanded',
  'collapsed', 'current',
]);
const RUNTIME_ID_RE = /(?:^|[_-])(?:el|ant|ivu|bv)?[_-]?[a-f0-9]{6,}$/i;
const BV_ID_RE = /__BV_[a-z0-9_]+/i;
const IVU_PREFIX = /^ivu-/;
const EL_HEX_TAIL = /^el-[a-f0-9]{4,}/;
const ANT_HEX_TAIL = /^ant-[a-f0-9]{4,}/;

export function isStableCssPath(path: string): boolean {
  const idMatch = path.match(/#([\w-]+)/);
  if (idMatch) {
    const id = idMatch[1]!;
    if (/^\d+$/.test(id)) return false;
    if (BV_ID_RE.test(id)) return false;
    if (RUNTIME_ID_RE.test(id)) return false;
  }
  if (IVU_PREFIX.test(idMatch?.[1] ?? '')) return false;
  return true;
}

export function filterCssPath(path: string): string {
  return path
    .split(' > ')
    .map((segment) => filterSegment(segment))
    .filter((s) => s.length > 0)
    .join(' > ');
}

function filterSegment(seg: string): string {
  // 移除状态 class
  const parts = seg.split(/(?=[.#[])/);
  const kept = parts.filter((tok) => {
    if (!tok.startsWith('.')) return true;
    const cls = tok.slice(1);
    if (STATE_CLASSES.has(cls)) return false;
    if (IVU_PREFIX.test(cls) && !/^ivu-btn|^ivu-select/.test(cls)) return false;
    if (EL_HEX_TAIL.test(cls)) return false;
    if (ANT_HEX_TAIL.test(cls)) return false;
    return true;
  });
  // 过滤运行时 aria
  const joined = kept.join('');
  return stripRuntimeAria(joined);
}

export function stripRuntimeAria(path: string): string {
  return path
    .replace(/\[aria-controls="[^"]*"\]/g, '')
    .replace(/\[aria-describedby="[^"]*"\]/g, '')
    .replace(/\[aria-activedescendant="[^"]*"\]/g, '');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/recorder test -- selector-filter`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/recorder/modules/selector-filter.ts apps/recorder/test/selector-filter.test.ts
git commit -m "feat(recorder): dynamic attribute filter — unstable id/state class/runtime aria"
```

---

## Task 12: recorder — component-detector（静态嗅探）

**Files:**
- Create: `apps/recorder/modules/component-detector.ts`
- Test: `apps/recorder/test/component-detector.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `apps/recorder/test/component-detector.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { detectComponent } from '../modules/component-detector.js';

let document: Document;
beforeEach(() => {
  document = new JSDOM('<!doctype html><html><body></body></html>').window.document;
});
function makeEl(html: string): Element {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  return wrap.firstElementChild!;
}

describe('component-detector', () => {
  it('detects antd select', () => {
    const el = makeEl('<div><span class="ant-select-selection"></span></div>');
    expect(detectComponent(el.firstElementChild!)).toEqual({ lib: 'antd', kind: 'select' });
  });
  it('detects element-plus select', () => {
    const el = makeEl('<div class="el-select"><input /></div>');
    expect(detectComponent(el)).toEqual({ lib: 'element', kind: 'select' });
  });
  it('detects iview select', () => {
    const el = makeEl('<div class="ivu-select"></div>');
    expect(detectComponent(el)).toEqual({ lib: 'iview', kind: 'select' });
  });
  it('detects antd tree', () => {
    const el = makeEl('<div class="ant-tree"></div>');
    expect(detectComponent(el)).toEqual({ lib: 'antd', kind: 'tree' });
  });
  it('detects element tree-select', () => {
    const el = makeEl('<div class="el-tree-select"></div>');
    expect(detectComponent(el)).toEqual({ lib: 'element', kind: 'treeSelect' });
  });
  it('returns null for vanilla', () => {
    const el = makeEl('<div class="plain"></div>');
    expect(detectComponent(el)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/recorder test -- component-detector`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 component-detector.ts**

```ts
export type ComponentLib = 'antd' | 'element' | 'iview';
export type ComponentKind = 'select' | 'tree' | 'treeSelect';

export interface ComponentInfo {
  lib: ComponentLib;
  kind: ComponentKind;
}

const RULES: Array<{ lib: ComponentLib; kind: ComponentKind; test: (cls: string) => boolean }> = [
  { lib: 'antd', kind: 'treeSelect', test: (c) => c.startsWith('ant-tree-select') },
  { lib: 'antd', kind: 'tree', test: (c) => c.startsWith('ant-tree') },
  { lib: 'antd', kind: 'select', test: (c) => c.startsWith('ant-select') },
  { lib: 'element', kind: 'treeSelect', test: (c) => c.startsWith('el-tree-select') },
  { lib: 'element', kind: 'tree', test: (c) => c.startsWith('el-tree') },
  { lib: 'element', kind: 'select', test: (c) => c.startsWith('el-select') },
  { lib: 'iview', kind: 'treeSelect', test: (c) => c.startsWith('ivu-tree-select') },
  { lib: 'iview', kind: 'tree', test: (c) => c.startsWith('ivu-tree') },
  { lib: 'iview', kind: 'select', test: (c) => c.startsWith('ivu-select') },
];

/** 沿父链向上搜索，直到命中任意一条规则或到根。 */
export function detectComponent(el: Element | null): ComponentInfo | null {
  let cur: Element | null = el;
  while (cur) {
    const cls = (cur.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    for (const c of cls) {
      for (const r of RULES) {
        if (r.test(c)) return { lib: r.lib, kind: r.kind };
      }
    }
    cur = cur.parentElement;
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/recorder test -- component-detector`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/recorder/modules/component-detector.ts apps/recorder/test/component-detector.test.ts
git commit -m "feat(recorder): static component detector — antd/element/iview select/tree"
```

---

## Task 13: recorder — selector-core 接入 filter

**Files:**
- Modify: `apps/recorder/modules/selector-core.ts`
- Modify: `apps/recorder/modules/selector-core.js`（重建）
- Test: 追加到 `apps/recorder/test/selector-core.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `apps/recorder/test/selector-core.test.ts`：

```ts
  it('filters runtime id hash from css locator', () => {
    const el = makeEl('<button id="login-7f9c3a">x</button>');
    const locs = generateLocators(el);
    const css = locs.find((l) => l.strategy === 'css')!;
    expect(css.value).not.toContain('login-7f9c3a');
  });

  it('strips state class active from css locator', () => {
    const el = makeEl('<button class="btn primary active">x</button>');
    const locs = generateLocators(el);
    const css = locs.find((l) => l.strategy === 'css')!.value;
    expect(css).not.toMatch(/active/);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/recorder test -- selector-core`
Expected: FAIL

- [ ] **Step 3: 修改 selector-core.ts**

import 加：

```ts
import { filterCssPath, isStableCssPath, stripRuntimeAria } from './selector-filter.js';
```

`buildCssPath` 后处理：

```ts
export function generateLocators(el: Element): Locator[] {
  // ... existing logic ...
  const rawCss = buildCssPath(el);
  const css = filterCssPath(rawCss);
  // ... push filtered css ...
  const xpath = stripRuntimeAria(buildXPath(el));
  // ... push xpath ...
}
```

具体替换 push css/xpath 那两行：

```ts
  const cssValue = filterCssPath(buildCssPath(el));
  push({ strategy: 'css', value: cssValue });
  push({ strategy: 'xpath', value: stripRuntimeAria(buildXPath(el)) });
```

- [ ] **Step 4: 跑测试确认通过 + build**

Run: `pnpm --filter @itest/recorder test && pnpm --filter @itest/recorder build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/recorder/modules/selector-core.ts apps/recorder/modules/selector-core.js apps/recorder/test/selector-core.test.ts
git commit -m "feat(recorder): selector-core filters unstable attrs from css/xpath"
```

---

## Task 14: recorder — recorder-manager 扩展（tabRef/componentKind/sensitive + upload fileId 留空）

**Files:**
- Modify: `apps/recorder/modules/recorder-manager.ts`
- Test: 追加到 `apps/recorder/test/recorder-manager.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `apps/recorder/test/recorder-manager.test.ts`：

```ts
  it('password input marks step sensitive', () => {
    const { captured } = setup();
    const pwd = document.createElement('input');
    pwd.type = 'password';
    document.body.appendChild(pwd);
    pwd.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(captured[0]!.sensitive).toBe(true);
    pwd.remove();
  });

  it('select change inside antd container sets componentKind=select', () => {
    const { captured } = setup();
    const wrap = document.createElement('div');
    wrap.className = 'ant-select';
    const sel = document.createElement('select');
    wrap.appendChild(sel);
    document.body.appendChild(wrap);
    sel.innerHTML = '<option value="x">x</option>';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const step = captured.find((s) => s.type === 'select');
    expect(step?.componentKind).toBe('select');
    wrap.remove();
  });

  it('file input change emits upload with empty fileId (binding happens later)', () => {
    const { captured } = setup();
    const f = document.createElement('input');
    f.type = 'file';
    document.body.appendChild(f);
    Object.defineProperty(f, 'files', { value: [{ name: 'a.txt' }], configurable: true });
    f.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const u = captured.find((s) => s.type === 'upload');
    expect(u?.fileId).toBeUndefined();
    expect(u?.value).toBe('a.txt');
    f.remove();
  });
```

（`setup` 与 `dom` 沿用文件顶部 fixture；`dom` 在 setup 闭包里访问不到，需要显式 import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/recorder test -- recorder-manager`
Expected: FAIL

- [ ] **Step 3: 修改 recorder-manager.ts**

`RecordedStep` 接口扩展：

```ts
export interface RecordedStep {
  type: RecordedStepType;
  target: Locator[];
  value?: string;
  checked?: boolean;
  url: string;
  timestamp: number;
  tabRef?: string;
  componentKind?: 'select' | 'tree' | 'treeSelect';
  sensitive?: boolean;
  fileId?: string;
}
```

import 加：

```ts
import { detectComponent } from './component-detector.js';
```

`onInput`：password 路径：

```ts
    const onInput = (e: Event) => {
      if (!this.canRecord()) return;
      const target = e.target as HTMLInputElement;
      if (!target) return;
      const tag = (target.tagName ?? '').toLowerCase();
      if (tag === 'select') return;
      if (target.type === 'checkbox' || target.type === 'radio' || target.type === 'file') return;
      const value = (target as { value?: string }).value;
      if (value === undefined) return;
      const isSensitive = target.type === 'password'
        || /password/i.test(target.name ?? '')
        || /password/i.test(target.id ?? '');
      this.lastInputAt = Date.now();
      this.handler?.({
        type: 'fill',
        target: generateLocators(target),
        value,
        url: location.href,
        timestamp: Date.now(),
        sensitive: isSensitive || undefined,
      });
    };
```

`onChange`：select 命中组件类时附 componentKind；file 命中时不带 fileId：

```ts
      if (tag === 'select') {
        const comp = detectComponent(target as Element);
        this.handler?.({
          type: 'select',
          target: generateLocators(target),
          value: target.value,
          url: location.href,
          timestamp: now,
          componentKind: comp?.kind,
        });
      }
```

```ts
        if (t === 'file') {
          const files = (target as HTMLInputElement).files;
          this.handler?.({
            type: 'upload',
            target: generateLocators(target),
            value: files?.[0]?.name ?? '',
            url: location.href,
            timestamp: now,
          });
          return;
        }
```

- [ ] **Step 4: 跑测试确认通过 + build**

Run: `pnpm --filter @itest/recorder test && pnpm --filter @itest/recorder build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/recorder/modules/recorder-manager.ts apps/recorder/test/recorder-manager.test.ts
git commit -m "feat(recorder): recorder-manager adds tabRef/componentKind/sensitive + drops fileId"
```

---

## Task 15: recorder — picker 携带 componentHint

**Files:**
- Modify: `apps/recorder/modules/picker.ts`
- Test: 追加到 `apps/recorder/test/picker.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
  it('returns componentHint when picking inside antd select container', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<span class="ant-select-selection">click</span>';
    document.body.appendChild(wrap);
    const target = wrap.querySelector('.ant-select-selection')!;
    let result: PickResult | null = null;
    picker.start((r) => {
      result = r;
    });
    target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(result).not.toBeNull();
    expect(result!.componentHint).toBeDefined();
    expect(result!.componentHint!.lib).toBe('antd');
    wrap.remove();
  });
```

（`dom` 在测试文件顶部已有。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/recorder test -- picker`
Expected: FAIL

- [ ] **Step 3: 修改 picker.ts**

```ts
import { detectComponent } from './component-detector.js';

export interface PickResult {
  locators: Locator[];
  text: string;
  inputValue: string;
  tagName: string;
  id: string;
  nameAttr: string;
  componentHint?: { lib: 'antd' | 'element' | 'iview'; kind: 'select' | 'tree' | 'treeSelect' };
}
```

```ts
    this.onClick = (e: MouseEvent) => {
      ...
      const componentHint = detectComponent(el) ?? undefined;
      this.teardown();
      onDone({ locators, text, inputValue, tagName: el.tagName.toLowerCase(), id, nameAttr, componentHint });
    };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/recorder test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/recorder/modules/picker.ts apps/recorder/test/picker.test.ts
git commit -m "feat(recorder): picker surfaces componentHint for antd/element/iview"
```

---

## Task 16: recorder — background 状态机（mode/incognito/tab 路由/switch-tab 信封）

**Files:**
- Modify: `apps/recorder/background.js`

- [ ] **Step 1: 整文件替换 background.js**

```js
let ws = null;
let recordingTabId = null;
let paused = false;
let sessionMode = 'fresh';
let sessionIncognito = false;
let sessionId = null;
// tab 路由：opener 派生 tab 的 tabIndex；tab #0 是主 tab
const recordingTabs = new Map(); // tabId -> tabIndex
let nextTabIndex = 1;

function toDSL(step) {
  if (step.type === 'check') return { kind: 'check', locator: step.target, checked: !!step.checked };
  if (step.type === 'select') return { kind: 'select', locator: step.target, value: step.value ?? '' };
  if (step.type === 'upload') {
    // 上传步骤 fileId 由 web 端绑定；此处只占位
    return { kind: 'upload', locator: step.target, fileId: '__pending__' };
  }
  const dsl = { kind: step.type, locator: step.target };
  if (dsl.kind === 'fill') {
    dsl.value = step.value ?? '';
    if (step.sensitive) dsl.sensitive = true;
  }
  return dsl;
}

function attachTabInjector(tabIndex = 0) {
  const onUpdated = (tabId, changeInfo) => {
    if (tabId !== recordingTabId || changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.scripting
      .executeScript({ target: { tabId }, files: ['content/recorder.js'] })
      .then(() => chrome.tabs.sendMessage(tabId, { type: 'start', mode: sessionMode, tabRef: `${sessionId}|tab#${tabIndex}` }))
      .catch(() => {});
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
}

chrome.tabs.onCreated.addListener((tab) => {
  if (recordingTabId === null || tab.openerTabId !== recordingTabId) return;
  const idx = nextTabIndex++;
  recordingTabs.set(tab.id, idx);
  // 上报 tab-event
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'tab-event',
      event: { kind: 'opened', tabRef: `${sessionId}|tab#${idx}`, title: tab.title || '', url: tab.url || '' },
    }));
  }
  // 接管新 tab
  attachTabInjector(idx);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!recordingTabs.has(tabId)) return;
  const idx = recordingTabs.get(tabId);
  recordingTabs.delete(tabId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'tab-event',
      event: { kind: 'closed', tabRef: `${sessionId}|tab#${idx}` },
    }));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start' && msg.session) {
    const { wsUrl, sessionId: sid, mode, incognito } = msg.session;
    sessionId = sid;
    sessionMode = mode || 'fresh';
    sessionIncognito = !!incognito;
    ws = new WebSocket(`${wsUrl}?sessionId=${sessionId}&token=${msg.session.token}`);
    ws.onopen = () => {
      sendResponse({ ok: true });
      const createOpts = { url: msg.targetUrl };
      if (sessionIncognito) createOpts.incognito = true;
      chrome.tabs.create(createOpts, (tab) => {
        recordingTabId = tab.id;
        nextTabIndex = 1;
        attachTabInjector(0);
      });
    };
    ws.onerror = () => sendResponse({ ok: false, error: 'ws failed' });
    return true;
  }

  if (msg.type === 'step' && ws && ws.readyState === 1) {
    const dsl = msg.dsl ?? toDSL(msg.step);
    const url = msg.step?.url ?? msg.url ?? null;
    const tabRef = msg.step?.tabRef ?? msg.tabRef ?? `${sessionId}|tab#0`;
    const componentKind = msg.step?.componentKind ?? null;
    ws.send(JSON.stringify({
      type: 'step',
      step: { action: dsl, url, tabRef, componentKind },
    }));
  }

  if (msg.type === 'switch-tab') {
    if (recordingTabs.has(msg.tabId) || msg.tabId === recordingTabId) {
      chrome.tabs.update(msg.tabId, { active: true });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'tab not in session' });
    }
    return;
  }

  if (msg.type === 'stop') {
    const stopTab = () => {
      if (recordingTabId !== null) {
        chrome.tabs.sendMessage(recordingTabId, { type: 'stop' });
        recordingTabId = null;
      }
      recordingTabs.clear();
      paused = false;
      sessionId = null;
    };
    const sock = ws;
    ws = null;
    if (sock && sock.readyState === 1) {
      let settled = false;
      const done = () => { if (settled) return; settled = true; stopTab(); sendResponse({ ok: true }); };
      sock.onclose = () => done();
      sock.send(JSON.stringify({ type: 'finish' }));
      setTimeout(() => { try { sock.close(); } catch {} done(); }, 3000);
    } else { stopTab(); sendResponse({ ok: true }); }
    return true;
  }

  if (msg.type === 'get-state') {
    sendResponse({
      recording: recordingTabId !== null,
      paused,
      mode: sessionMode,
      tabs: Array.from(recordingTabs.entries()).map(([id, idx]) => ({ tabId: id, tabRef: `${sessionId}|tab#${idx}` })),
    });
    return;
  }

  if (msg.type === 'pause' || msg.type === 'resume') {
    paused = msg.type === 'pause';
    if (recordingTabId !== null) chrome.tabs.sendMessage(recordingTabId, { type: msg.type });
    sendResponse({ recording: recordingTabId !== null, paused });
    return;
  }

  if (msg.type === 'pick' || msg.type === 'emit-step') {
    if (recordingTabId === null) { sendResponse({ ok: false, error: '当前没有录制中的标签页' }); return; }
    chrome.tabs.sendMessage(recordingTabId, msg, (resp) => sendResponse(resp ?? { ok: false }));
    return true;
  }

  return false;
});
```

- [ ] **Step 2: 验证构建**

Run: `pnpm --filter @itest/recorder build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/recorder/background.js
git commit -m "feat(recorder): background mode/incognito/tab router + switch-tab envelope"
```

---

## Task 17: recorder — content script 接线（start 带 mode + emit-step 带 tabRef）

**Files:**
- Modify: `apps/recorder/content/recorder.js`

- [ ] **Step 1: 整文件替换**

```js
(async () => {
  const src = chrome.runtime.getURL('modules/recorder-manager.js');
  const mod = await import(src);
  const manager = new mod.RecorderManager();

  const pickerMod = await import(chrome.runtime.getURL('modules/picker.js'));
  const picker = new pickerMod.ElementPicker();

  let currentTabRef = 'tab#0';
  let lastComponentHint = null;

  const sendStep = (step) => {
    if (lastComponentHint) {
      step.componentHint = lastComponentHint;
      lastComponentHint = null;
    }
    chrome.runtime.sendMessage({ type: 'step', step, tabRef: currentTabRef });
  };
  const startCapture = () => manager.start(sendStep);

  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'ita-web') return;
    if (e.data.type === 'start-recording') {
      startCapture();
    } else if (e.data.type === 'stop-recording') {
      manager.stop();
      picker.stop();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'stop') {
      manager.stop();
      picker.stop();
    } else if (msg?.type === 'start') {
      currentTabRef = msg.tabRef ?? 'tab#0';
      startCapture();
    } else if (msg?.type === 'pause') {
      manager.setPaused(true);
    } else if (msg?.type === 'resume') {
      manager.setPaused(false);
    } else if (msg?.type === 'pick') {
      const prevPaused = manager.isPaused();
      manager.setPaused(true);
      picker.start((result) => {
        manager.setPaused(prevPaused);
        if (result && result.componentHint) {
          lastComponentHint = result.componentHint;
        }
        sendResponse(result ?? { canceled: true });
      });
      return true;
    } else if (msg?.type === 'emit-step') {
      chrome.runtime.sendMessage({ type: 'step', dsl: msg.dsl, url: location.href, tabRef: currentTabRef });
      sendResponse({ ok: true });
    }
  });
})();
```

- [ ] **Step 2: 验证构建**

Run: `pnpm --filter @itest/recorder build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/recorder/content/recorder.js
git commit -m "feat(recorder): content script — start carries tabRef; pick propagates componentHint"
```

---

## Task 18: recorder — popup 模式显示 + tab 切换按钮

**Files:**
- Modify: `apps/recorder/popup/popup.html`
- Modify: `apps/recorder/popup/popup.js`
- Modify: `apps/recorder/popup/popup.css`

- [ ] **Step 1: popup.html 替换**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <div class="container">
      <h1>iTest Recorder</h1>
      <p id="status" class="hint">检查录制状态...</p>
      <p id="mode" class="hint" style="font-weight:600"></p>
      <button id="open">打开中台</button>
      <hr />
      <button id="pause" disabled>暂停录制</button>
      <hr />
      <p class="hint">以下操作会打开一个小窗口，在窗口里完成配置：</p>
      <button class="panel-btn" data-mode="variable" disabled>保存变量</button>
      <button class="panel-btn" data-mode="assert" disabled>添加断言</button>
      <button class="panel-btn" data-mode="hover" disabled>记录悬浮</button>
      <button class="panel-btn" data-mode="ai" disabled>AI 自然语言步骤</button>
      <hr />
      <p class="hint">当前会话接管的多标签页：</p>
      <ul id="tabs" style="list-style:none;padding:0;margin:0;font-size:11px"></ul>
    </div>
    <script src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: popup.js 替换**

```js
const statusEl = document.getElementById('status');
const modeEl = document.getElementById('mode');
const pauseBtn = document.getElementById('pause');
const panelBtns = document.querySelectorAll('.panel-btn');
const tabsEl = document.getElementById('tabs');

document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:5173/' });
});

function openPanel(mode) {
  chrome.windows.create({
    url: chrome.runtime.getURL(`popup/panel.html?mode=${mode}`),
    type: 'popup',
    width: 380,
    height: mode === 'assert' ? 460 : mode === 'ai' ? 300 : 240,
  });
}

panelBtns.forEach((btn) => {
  btn.addEventListener('click', () => openPanel(btn.dataset.mode));
});

pauseBtn.addEventListener('click', () => {
  const next = pauseBtn.dataset.paused === 'true' ? 'resume' : 'pause';
  chrome.runtime.sendMessage({ type: next }, render);
});

function render(state) {
  const { recording, paused, mode, tabs } = state ?? { recording: false, paused: false, mode: 'fresh', tabs: [] };
  statusEl.textContent = recording ? (paused ? '已暂停' : '录制中') : '未在录制（从中台用例详情页发起）';
  modeEl.textContent = recording ? `模式：${mode}` : '';
  pauseBtn.disabled = !recording;
  pauseBtn.dataset.paused = String(paused);
  pauseBtn.textContent = paused ? '继续录制' : '暂停录制';
  panelBtns.forEach((b) => (b.disabled = !recording));
  tabsEl.innerHTML = '';
  (tabs ?? []).forEach((t) => {
    const li = document.createElement('li');
    li.textContent = `${t.tabRef}`;
    li.style.cursor = 'pointer';
    li.addEventListener('click', () => {
      // 需要真实 tabId；这里 panel/popup 不直接传 tabId，改走 get-state 配合
      chrome.runtime.sendMessage({ type: 'switch-tab', tabId: t.tabId });
    });
    tabsEl.appendChild(li);
  });
}

chrome.runtime.sendMessage({ type: 'get-state' }, render);
```

- [ ] **Step 3: popup.css 不变**

- [ ] **Step 4: 验证构建**

Run: `pnpm --filter @itest/recorder build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/recorder/popup/
git commit -m "feat(recorder): popup shows mode + tab list with click-to-switch"
```

---

## Task 19: web — api client 扩展（attachments / secrets / mode / tabRef / componentKind / sensitive）

**Files:**
- Modify: `apps/web/src/api/client.ts`

- [ ] **Step 1: 修改 client.ts**

`TestStep` 接口扩展：

```ts
export interface TestStep {
  id: string;
  order: number;
  source: string;
  action: unknown;
  name?: string | null;
  delayMs?: number | null;
  tabRef?: string | null;
  componentKind?: string | null;
  sensitive?: boolean;
}
```

`recorder.createSession` 改：

```ts
    createSession: (
      caseId: string,
      opts?: { mode?: 'fresh' | 'append' | 'resume' | 'incognito'; incognito?: boolean; resumeFromOrder?: number },
    ) =>
      request<{ sessionId: string; wsUrl: string; wsToken: string; resolvedUrl: string | null; mode: string }>(
        '/recorder/sessions',
        { method: 'POST', body: JSON.stringify({ caseId, ...(opts ?? {}) }) },
      ),
```

`recorder` 块新增：

```ts
    tabEvents: (sessionId: string, events: Array<{ kind: 'opened'|'closed'; tabRef: string; title?: string; url?: string }>) =>
      request<{ count: number }>(`/recorder/sessions/${sessionId}/tab-events`, {
        method: 'POST',
        body: JSON.stringify({ events }),
      }),
```

`cases` 块新增：

```ts
    uploadAttachment: async (caseId: string, file: File) => {
      const buf = await file.arrayBuffer();
      const r = await fetch(`${BASE}/cases/${caseId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name },
        body: buf,
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? `HTTP ${r.status}`);
      return r.json() as Promise<{ id: string; sha256: string; originalName: string; size: number }>;
    },
    listAttachments: (caseId: string) =>
      request<Array<{ id: string; originalName: string; sha256: string; size: number; mime: string | null }>>(
        `/cases/${caseId}/attachments`,
      ),
    getSecret: (caseId: string, stepId: string, token: string) =>
      request<{ value: string }>(`/cases/${caseId}/steps/secrets/${stepId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @itest/web typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api/client.ts
git commit -m "feat(web): api client — attachments/secrets/tabEvents/mode/tabRef/componentKind/sensitive"
```

---

## Task 20: web — CaseDetail 录制模式入口（全新/追加/从这里开始/无痕）

**Files:**
- Modify: `apps/web/src/pages/CaseDetail.tsx`

- [ ] **Step 1: 修改 startRecording**

引入新 mutation 与本地状态：

```ts
  const [mode, setMode] = useState<'fresh'|'append'|'resume'|'incognito'>('fresh');
  const [resumeTarget, setResumeTarget] = useState<{ stepId: string; order: number } | null>(null);

  const startRecording = useMutation({
    mutationFn: async () => {
      const opts: Parameters<typeof api.recorder.createSession>[1] = { mode };
      if (mode === 'resume' && resumeTarget) opts.resumeFromOrder = resumeTarget.order + 1;
      if (mode === 'incognito' || caseDetail?.incognito) opts.incognito = true;
      const session = await api.recorder.createSession(id!, opts);
      recorder.setStatus('recording');
      recorder.setSession(session.sessionId);
      sessionRef.current = session.sessionId;
      if (!targetUrl && session.resolvedUrl) setTargetUrl(session.resolvedUrl);
      // ... 其余 window.postMessage 逻辑保持原样，但 message body 加 mode
      window.postMessage(
        {
          source: 'ita-web',
          type: 'start-recording',
          session: { wsUrl: session.wsUrl, sessionId: session.sessionId, token: session.wsToken, mode: opts.mode, ...(incognito ? { incognito: true } : {}) },
          targetUrl,
        },
        '*',
      );
    },
    // ... 其余
  });
```

把右栏"录制补充"按钮区域改为下拉：

```tsx
            <div className="glass-card rounded-[12px] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                浏览器录制
              </div>
              <select
                className="input-base input-sm mb-2"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
                disabled={recorder.status === 'recording'}
              >
                <option value="fresh">全新录制（覆盖旧步骤）</option>
                <option value="append">追加录制（保留旧步骤）</option>
                <option value="resume">从这里开始</option>
                <option value="incognito">无痕录制</option>
              </select>
              {mode === 'resume' && (
                <p className="text-[11px] mb-2" style={{ color: 'var(--color-info)' }}>
                  请在步骤列表中点「从这里开始」选择目标步骤。
                </p>
              )}
              <Input ... />
              {recorder.status === 'recording' ? (
                <Button variant="secondary" onClick={() => stopRecording.mutate()} className="w-full">停止录制</Button>
              ) : (
                <Button
                  onClick={() => {
                    if (mode === 'resume' && !resumeTarget) {
                      toast('请先在步骤列表里选「从这里开始」指定步骤', 'info');
                      return;
                    }
                    startRecording.mutate();
                  }}
                  className="w-full"
                >录制补充</Button>
              )}
            </div>
```

步骤行末尾加「从这里开始」按钮（操作按钮组，紧贴编辑按钮之前）：

```tsx
                          <button
                            disabled={recorder.status === 'recording'}
                            onClick={async () => {
                              const ok = window.confirm('录制前是否先回放该步骤之前的步骤？');
                              setResumeTarget({ stepId: s.id, order: idx });
                              setMode('resume');
                              if (!ok) {
                                // 不回放：直接 ready 状态（仍然走 resume 模式，但服务端不需要预跑）
                                toast('已选中从此处开始，前置步骤不会回放', 'info');
                              } else {
                                toast('已选中，录制时会先回放前置步骤', 'info');
                              }
                            }}
                            title="从这里开始录制"
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 2 }}
                          >
                            <Icon name="arrowRightToLine" size={12} />
                          </button>
```

注意 Icon name 用仓库现有图标；若没有 `arrowRightToLine`，可换 `cornerDownRight`。

- [ ] **Step 2: typecheck + lint**

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/CaseDetail.tsx
git commit -m "feat(web): recorder mode dropdown + resume from-step entry"
```

---

## Task 21: web — StepEditModal（密码敏感值 + 上传绑定 + tabRef/componentKind 展示）

**Files:**
- Modify: `apps/web/src/components/StepEditModal.tsx`

- [ ] **Step 1: 修改 StepEditModal.tsx**

顶部 import 替换：

```ts
import { useState, useEffect, type CSSProperties } from 'react';
import type { StepClip } from '../stores/stepClipboard';
import { api } from '../api/client';

interface Props {
  initial: StepClip;
  availableVars?: string[];
  /** 当前 case id，用于附件上传接口 */
  caseId?: string;
  /** 扩展 ws token，用于预览上传文件明细（仅展示，不取明文） */
  onSave: (next: StepClip) => void;
  onClose: () => void;
}
```

组件签名加 `caseId`，函数体顶部：

```ts
export default function StepEditModal({ initial, availableVars = [], caseId, onSave, onClose }: Props) {
  ...
  // fill 敏感值
  const initialFill = action as { sensitive?: boolean };
  const [sensitive, setSensitive] = useState(!!initialFill.sensitive);
  const [pwdDraft, setPwdDraft] = useState(''); // 用户重新输入时使用

  // upload
  const [fileId, setFileId] = useState<string | undefined>(
    (action as { fileId?: string }).fileId,
  );
```

在 fill 值编辑区上方加敏感值开关（仅 fill 步骤）：

```tsx
          {kind === 'fill' && (
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
              敏感值（密码，加密保存，明文不显示）
            </label>
          )}
          {kind === 'fill' && sensitive && (
            <input
              type="password"
              style={inputStyle}
              placeholder="输入新密码（修改时填写；留空表示保留原值）"
              value={pwdDraft}
              onChange={(e) => setPwdDraft(e.target.value)}
            />
          )}
```

upload 区域替换：

```tsx
          {kind === 'upload' && (
            <div className="flex flex-col gap-2">
              <span style={labelStyle}>绑定回放文件（按 sha256 复用）</span>
              <input
                type="file"
                style={inputStyle}
                onChange={async (e) => {
                  if (!caseId) return;
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 50 * 1024 * 1024) { setError('文件超过 50MB 上限'); return; }
                  try {
                    const r = await api.cases.uploadAttachment(caseId, f);
                    setFileId(r.id);
                    setError('');
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
              />
              {fileId && (
                <p className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                  已绑定 fileId：<code>{fileId.slice(0, 8)}…</code>
                </p>
              )}
            </div>
          )}
```

`handleSave` 加 sensitive 与 upload 分支：

```ts
  const handleSave = () => {
    const next: Record<string, unknown> = { ...action };
    if (kind === 'fill' || kind === 'select') next.value = buildValue();
    if (kind === 'fill') {
      if (sensitive) {
        if (!pwdDraft) {
          setError('已加密 — 修改时请输入新密码');
          return;
        }
        next.value = pwdDraft;
        next.sensitive = true;
      } else {
        delete next.sensitive;
      }
    }
    if (kind === 'upload') {
      if (!fileId) { setError('请先绑定回放文件'); return; }
      next.fileId = fileId;
    }
    ...
  };
```

`onSave({ action: next, source, name, delayMs })` 中，`StepClip` 加 `tabRef / componentKind / sensitive` 透传（已在 Task 19 调整）。

- [ ] **Step 2: typecheck + lint**

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/StepEditModal.tsx
git commit -m "feat(web): StepEditModal — sensitive fill toggle + upload binding"
```

---

## Task 22: web — ReportDetail 按 tabIndex 分组

**Files:**
- Modify: `apps/web/src/pages/ReportDetail.tsx`

- [ ] **Step 1: 读现状 + 调整**

```bash
cat /Users/lyq/workdir/codedev/iTest/apps/web/src/pages/ReportDetail.tsx | head -100
```

在 step result 渲染处，按 `tabIndex` 分组（每组以 `tab #n` 标题起头）。StepResult 接口加 `tabIndex?: number`。

实际渲染时若有 tabIndex，渲染前按 tabIndex 排序分组；否则不分组。

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @itest/web typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/ReportDetail.tsx
git commit -m "feat(web): ReportDetail groups steps by tabIndex"
```

---

## Task 23: README 与手动 E2E 验收

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README 更新**

「MVP 范围」清单里录制一行扩写为：

```markdown
- Chrome 扩展录制（点击 / 输入 / 悬浮 / 复选框 / 原生下拉 / 文件上传 / 文本与 JSON 断言 / AI 自然语言步骤 / 变量保存；录制模式 全新/追加/从这里开始/无痕；多标签页自动接管；AntD/Element/iView 组件识别与动态属性过滤；密码加密存储）
```

「已知边界」一节追加：

```markdown
- 上传文件：单个文件 ≤ 50MB；按 sha256 跨用例复用；多文件 / 拖拽不支持
- 密码加密：使用 AES-256-GCM；密钥由 ENCRYPTION_KEY 环境变量提供（base64 32 字节），密钥丢失意味着密码不可恢复
- 组件识别仅覆盖 AntD / Element / iView
- 多标签页录制只接管由录制 tab opener 派生的 tab；手动打开的无关 tab 不接管
```

「核心流程」第 4 条扩写：

```markdown
4. 用例详情页：「录制补充」（需 Chrome 扩展，模式 全新/追加/从这里开始/无痕）、「AI 补充步骤」、「执行」；步骤可编辑（名称/等待/随机值/敏感值/上传绑定）、复制粘贴、撤销、AI 步骤失败重编
```

- [ ] **Step 2: 手动 E2E 验收清单**

按 spec「手动 E2E」7 步执行并在 PR 描述勾选。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: phase2 recorder — modes/tabs/components/secret/upload"
```

---

## Self-Review

逐条对照 spec：

| spec 段 | 覆盖 Task |
|---|---|
| DSL 扩展（switchTab/upload.fileId/fill.sensitive） | 1 |
| 加密模块 AES-256-GCM | 2 |
| 数据库迁移（test_steps 新列 + test_attachments + test_sessions） | 3 |
| 附件上传 + sha256 幂等 | 4 |
| 步骤 PUT 加密 + upload.fileId 校验 | 5 |
| 扩展专用 secret 取值 | 6 |
| WS 协议扩展（tabRef/componentKind/tab-event） | 7 |
| 录制 session 创建 + finish | 8 |
| 执行器 switchTab + upload 真回放 + sensitive 走解密 | 9, 10 |
| selector-filter 动态属性过滤 | 11 |
| component-detector 静态嗅探 | 12 |
| selector-core 接入 filter | 13 |
| recorder-manager 加 tabRef/componentKind/sensitive + upload fileId 留空 | 14 |
| picker 携带 componentHint | 15 |
| background 状态机（mode/incognito/tab 路由/switch-tab） | 16 |
| content script start 带 mode + emit-step 带 tabRef | 17 |
| popup 模式显示 + tab 切换 | 18 |
| web api client 扩展 | 19 |
| web CaseDetail 录制模式入口 | 20 |
| web StepEditModal 密码 + 上传 | 21 |
| web ReportDetail tab 分组 | 22 |
| README + E2E | 23 |

类型一致：`switchTab.tabRef`（spec）/ `tabRef` 在 step 列与执行器 tabMap 键名一致；`fileId` 贯穿 shared/api/recorder/web；`sensitive` 与 `secretCiphertext/Iv/Tag` 在 PUT 路径配套；`mode` 在 createSession 与 background 共用枚举。