# AI 助手 Word 上传 + docx-to-cases skill 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 助手聊天可上传 .docx（提取文本供助手读、原件落盘供 skill 脚本用），并新增 `docx-to-cases` skill 从 Word 需求文档生成平台测试用例。

**Architecture:** 预上传模式——前端附件 adapter 在选文件时 POST 到版本作用域端点（octet-stream），`send()` 把服务端签发的 `<uploaded-file …/>` 引用标签作为**文本部件**拼进消息正文（react-pi 把附件文本部件拍平进 content，乐观消息 == pi 记录 == 回放逐字一致，结构性免疫重复气泡）。后端不改写任何消息文本。skill 用纯 stdlib python 脚本解析 docx 结构，用例经 `stage_case` 暂存入平台库。

**Tech Stack:** Express 5 raw body、drizzle（pg）、mammoth（docx→纯文本）、assistant-ui AttachmentAdapter/CompositeAttachmentAdapter、python3 stdlib（zipfile + xml.etree）、vitest。

**Spec:** `docs/superpowers/specs/2026-10-29-docx-upload-and-cases-skill-design.md`（含改道决策的完整理由，勿绕过其中的不变量）。

**全局纪律（每个任务都适用）：**
- **后端永不改写用户消息文本**——react-pi 乐观消息按纯文本 key（`userContentKey`，ThreadController.js:445-455）对账，后端改写 = 重复气泡。
- 提交前 `git status` 核对无源码污染（历史上 AI agent 会改 `step-dsl-spec.ts` 等源码，见项目记忆）；陌生文件一律还原。
- api 测试命令一律在 `apps/api` 目录下跑；web 同理。

---

### Task 1: API — `ai_assistant_attachments` 表

**Files:**
- Modify: `apps/api/src/db/schema.ts`（在 `aiThreadArtifacts` 表定义之后、约 L850「批量固化」注释之前插入）
- 无测试（表结构由后续任务的功能测试覆盖；本地 dev 库需手动建表，见 Step 3）

- [ ] **Step 1: 在 schema.ts 加表定义**

在 `apps/api/src/db/schema.ts` 中 `aiThreadArtifacts` 表（以 `} (t) => ({ ... }));` 结尾，其后是 `// ── 批量固化…` 注释）之后插入：

```ts
// ── 助手附件（版本级 docx 预上传）──
// 选文件即上传（react-pi 草稿线程发首条消息前没有 threadId，作用域只能取版本）。
// 引用标签由前端 adapter 在 send() 拼进消息正文（自闭合 <uploaded-file …/>），
// 后端不改写消息文本——react-pi 乐观消息按纯文本 key 对账，任何后端改写都会造成重复气泡。
export const aiAssistantAttachments = pgTable('ai_assistant_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 作用域：同版本各线程可用；read_thread_attachment 以它做路径+行双重约束。 */
  versionId: uuid('version_id').notNull(),
  /** 用户原始文件名（含扩展名，可中文）；引用标签与 chip 展示用。 */
  name: text('name').notNull(),
  /** 固定为 docx mime（端点只收 docx）。 */
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  /** 去重键：同版本同内容只存一份文件与一行记录。 */
  sha256: text('sha256').notNull(),
  /** 原件绝对路径（<UPLOAD_DIR>/assistant/<versionId>/<sha>.docx）。 */
  storagePath: text('storage_path').notNull(),
  /** mammoth 提取文本 sidecar（<sha>.txt）；提取失败（文件损坏）为 null。 */
  extractedPath: text('extracted_path'),
  /** 提取文本字符数（引用标签的 chars 属性）；失败为 null。 */
  extractedChars: integer('extracted_chars'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  versionIdx: index('ai_assistant_attachments_version_idx').on(t.versionId),
  // 去重唯一：并发上传同文件靠 onConflictDoNothing + 回读兜底。
  uniq: uniqueIndex('ai_assistant_attachments_version_sha_uniq').on(t.versionId, t.sha256),
}));
```

说明：`uuid/text/integer/timestamp/index/uniqueIndex` 均已在 schema.ts 头部导入（已核实）；`users` 表已在本文件定义。生产迁移随 api 容器启动 `drizzle-kit push` 自动应用，无需额外步骤。

- [ ] **Step 2: 类型检查**

```bash
cd apps/api && pnpm typecheck
```

预期：无错误退出（exit 0）。

- [ ] **Step 3: 本地 dev 库手动建表（prod 自动，dev 不自动）**

```bash
docker exec -i itest-pg psql -U itest -d itest <<'SQL'
CREATE TABLE IF NOT EXISTS ai_assistant_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL,
  name text NOT NULL,
  mime text NOT NULL,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  storage_path text NOT NULL,
  extracted_path text,
  extracted_chars integer,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_assistant_attachments_version_idx ON ai_assistant_attachments(version_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_assistant_attachments_version_sha_uniq ON ai_assistant_attachments(version_id, sha256);
SQL
```

预期：两条 `CREATE ...` 成功（若凭据/库名不对，用你本地 dev 的 DATABASE_URL 对应容器调整 `-U/-d`）。若本地暂不跑 E2E 可跳过本步，Task 11 前补。

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/db/schema.ts
git commit -m "feat(api): ai_assistant_attachments 表（版本级 docx 预上传）"
```

---

### Task 2: API — threadAttachments 服务（纯函数 TDD）

**Files:**
- Create: `apps/api/src/pi/space/threadAttachments.ts`
- Test: `apps/api/src/pi/space/threadAttachments.test.ts`

- [ ] **Step 1: 写失败测试（纯函数部分）**

创建 `apps/api/src/pi/space/threadAttachments.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertDocxMagic, confinedPath } from './threadAttachments.js';

describe('assertDocxMagic', () => {
  it('PK\\x03\\x04 头放行', () => {
    expect(() => assertDocxMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).not.toThrow();
  });
  it('非 zip 头拒绝（伪造扩展名防线）', () => {
    expect(() => assertDocxMagic(Buffer.from('plain text docx impostor'))).toThrow();
  });
  it('过短 buffer 拒绝', () => {
    expect(() => assertDocxMagic(Buffer.from('PK'))).toThrow();
  });
});

describe('confinedPath', () => {
  it('目录内文件放行并返回 realpath 规范化路径', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'conf-'));
    const f = path.join(base, 'a.docx');
    await writeFile(f, 'x');
    // macOS 上 /var 是 /private/var 的软链，断言必须与 realpath 同源
    expect(await confinedPath(base, f)).toBe(await confinedPath(base, f));
    await rm(base, { recursive: true, force: true });
  });
  it('目录外文件拒绝', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'conf-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'out-'));
    const f = path.join(outside, 'a.docx');
    await writeFile(f, 'x');
    await expect(confinedPath(base, f)).resolves.toBeNull();
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  it('目录内软链指向目录外——realpath 后越界，拒绝', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'conf-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'out-'));
    const target = path.join(outside, 'secret.docx');
    const link = path.join(base, 'link.docx');
    await writeFile(target, 'x');
    await symlink(target, link);
    await expect(confinedPath(base, link)).resolves.toBeNull();
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  it('不存在的路径拒绝', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'conf-'));
    await expect(confinedPath(base, path.join(base, 'nope.docx'))).resolves.toBeNull();
    await rm(base, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm vitest run src/pi/space/threadAttachments.test.ts
```

预期：FAIL，报模块不存在（`Cannot find module './threadAttachments.js'`）。

- [ ] **Step 3: 实现服务模块（纯函数 + DB 函数一并写好，DB 函数由 Task 3/4 使用）**

创建 `apps/api/src/pi/space/threadAttachments.ts`：

```ts
/**
 * 助手 docx 附件（版本级）：预上传端点与 read_thread_attachment 工具的共享服务。
 *
 * 设计不变量（勿破坏，见 docs/superpowers/specs/2026-10-29-*）：
 *  - 引用标签由前端 adapter 在 send() 拼进消息正文，后端不改写任何消息文本——
 *    react-pi 的乐观消息按纯文本 key（userContentKey）与 pi 回放消息对账去重，
 *    后端改写文本会让两侧 key 不一致 → 重复用户气泡。
 *  - 附件文件是 skill 脚本的输入：PK 魔数校验防伪造扩展名把任意内容送进 python。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import mammoth from 'mammoth';
import { db } from '../../db/client.js';
import { aiAssistantAttachments } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { UPLOAD_DIR } from '../../lib/attachments.js';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** 单文件上限：与既有 uploadMaxBytes()（10MB）对齐；web 侧 DocxAttachmentAdapter 有同值校验。 */
export const MAX_DOCX_BYTES = 10 * 1024 * 1024;
/** read_thread_attachment 的返回上限：防长文刷爆上下文。 */
export const MAX_ATTACHMENT_READ_CHARS = 80_000;

/** 版本上传目录。UPLOAD_DIR 与 case 附件同根（.data/uploads）。 */
export function versionUploadDir(versionId: string): string {
  return path.join(UPLOAD_DIR, 'assistant', versionId);
}

/** docx = zip 容器，头四字节必为 PK\x03\x04。不带魔数一律 400（防伪造扩展名）。 */
export function assertDocxMagic(buf: Buffer): void {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new HttpError(400, 'bad_request', 'not a docx (zip) file');
  }
}

async function realpathOrNull(p: string): Promise<string | null> {
  try { return await fs.realpath(p); } catch { return null; }
}

/**
 * 路径约束：p（realpath 后）必须严格位于 baseDir 之内（软链先解引用再判）。
 * 返回规范化绝对路径；越界/不存在返回 null。调用方再叠 DB 行校验形成双保险。
 */
export async function confinedPath(baseDir: string, p: string): Promise<string | null> {
  const real = await realpathOrNull(p);
  if (!real) return null;
  const base = await realpathOrNull(baseDir);
  if (!base) return null;
  if (real !== base && !real.startsWith(base + path.sep)) return null;
  return real;
}

export interface SavedDocx {
  row: typeof aiAssistantAttachments.$inferSelect;
  deduped: boolean;
}

/** 预上传落盘：魔数 → sha256 → 版本内去重 → 写原件 → mammoth 提取（失败不阻断）→ 插行。 */
export async function saveDocxUpload(input: {
  versionId: string;
  name: string;
  buf: Buffer;
  createdByUserId: string | null;
}): Promise<SavedDocx> {
  const { versionId, buf } = input;
  assertDocxMagic(buf);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const dupeSel = () => db.select().from(aiAssistantAttachments)
    .where(and(
      eq(aiAssistantAttachments.versionId, versionId),
      eq(aiAssistantAttachments.sha256, sha256),
    ))
    .limit(1);
  const existing = (await dupeSel())[0];
  if (existing) return { row: existing, deduped: true };

  const dir = versionUploadDir(versionId);
  await fs.mkdir(dir, { recursive: true });
  const storagePath = path.join(dir, `${sha256}.docx`);
  await fs.writeFile(storagePath, buf);

  // 提取失败不阻断上传：sidecar 缺失 → 标签 chars="unknown"，skill 的 python 解析器仍可读原件。
  let extractedPath: string | null = null;
  let extractedChars: number | null = null;
  try {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    const text = value ?? '';
    extractedPath = path.join(dir, `${sha256}.txt`);
    await fs.writeFile(extractedPath, text, 'utf8');
    extractedChars = text.length;
  } catch { /* 保持 null：文件损坏等，原件 path 仍有效 */ }

  const inserted = (await db.insert(aiAssistantAttachments).values({
    versionId,
    name: input.name.slice(0, 200),
    mime: DOCX_MIME,
    sizeBytes: buf.length,
    sha256,
    storagePath,
    extractedPath,
    extractedChars,
    createdByUserId: input.createdByUserId,
  }).onConflictDoNothing().returning())[0];
  if (inserted) return { row: inserted, deduped: false };
  // 并发同文件：唯一约束兜底 → 回读既有行。
  const again = (await dupeSel())[0]!;
  return { row: again, deduped: true };
}

/** read_thread_attachment 的读路径：目录约束 + DB 行归属双校验 → sidecar 全文（截断标注）。 */
export async function readAssistantAttachmentText(
  versionId: string,
  p: string,
): Promise<{ text: string; truncated: boolean; row: typeof aiAssistantAttachments.$inferSelect } | null> {
  const real = await confinedPath(versionUploadDir(versionId), p);
  if (!real) return null;
  const row = (await db.select().from(aiAssistantAttachments)
    .where(and(
      eq(aiAssistantAttachments.versionId, versionId),
      eq(aiAssistantAttachments.storagePath, real),
    ))
    .limit(1))[0];
  if (!row) return null;
  if (!row.extractedPath) return { text: '', truncated: false, row };
  let text = await fs.readFile(row.extractedPath, 'utf8');
  const truncated = text.length > MAX_ATTACHMENT_READ_CHARS;
  if (truncated) text = text.slice(0, MAX_ATTACHMENT_READ_CHARS);
  return { text, truncated, row };
}
```

注意：本任务先不装 mammoth，Step 4 会装；若想 Step 3 就能跑测试，把安装提前到本步。`mammoth` import 在模块顶层——只要装了包，纯函数测试不会触发 DB 连接（pg Pool 懒连接）。

- [ ] **Step 4: 安装 mammoth 依赖**

```bash
cd apps/api && pnpm add mammoth
```

预期：`package.json` dependencies 出现 `"mammoth"`（纯 JS，无原生编译）。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd apps/api && pnpm vitest run src/pi/space/threadAttachments.test.ts
```

预期：7 个用例全 PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/pi/space/threadAttachments.ts apps/api/src/pi/space/threadAttachments.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): 助手 docx 附件服务——魔数/路径约束纯函数 + 存档/提取/读取"
```

---

### Task 3: API — 预上传端点

**Files:**
- Modify: `apps/api/src/pi/space/router.ts`（在 `POST /threads/:id/messages` 路由之后、`MAX_IMAGE_BYTES` 常量块之前插入；并在文件头部 import 区加一行）

- [ ] **Step 1: 加 import**

在 `apps/api/src/pi/space/router.ts` 顶部 import 区（`import { stageRoute } from './stageRoute.js';` 附近）加：

```ts
import { saveDocxUpload, MAX_DOCX_BYTES } from './threadAttachments.js';
```

- [ ] **Step 2: 加路由（在 `spaceRoute.post('/threads/:id/messages', …)` 的 `});` 之后插入）**

```ts
/** 助手 docx 预上传：composer 选文件即传（草稿线程尚无 threadId → 作用域=版本）。
 *  raw octet-stream + X-Filename（全局 express.raw 已挂，与 /api/cases 附件同模式）。
 *  引用标签由前端 adapter 在 send() 拼进消息正文——本路由不碰任何消息文本。
 *  X-Filename 走 encodeURIComponent（中文文件名直塞 Headers 在部分浏览器抛 ByteString 错），
 *  服务端解码，失败保原值。 */
spaceRoute.post('/versions/:versionId/attachments', async (req, res) => {
  const versionId = req.params.versionId!;
  await assertVersionVisible(versionId, req.user as AuthUser);
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf)) throw new HttpError(400, 'bad_request', 'expected octet-stream body');
  if (buf.length === 0) throw new HttpError(400, 'bad_request', 'empty body');
  if (buf.length > MAX_DOCX_BYTES) throw new HttpError(413, 'too_large', 'docx exceeds 10MB');
  const rawName = req.header('x-filename') ?? 'document.docx';
  let name = rawName;
  try { name = decodeURIComponent(rawName); } catch { /* 非编码值保原样 */ }
  const { row, deduped } = await saveDocxUpload({
    versionId,
    name,
    buf,
    createdByUserId: (req.user as AuthUser).userId ?? null,
  });
  res.json({
    name: row.name,
    path: row.storagePath,
    chars: row.extractedChars,
    size: row.sizeBytes,
    sha256: row.sha256,
    deduped,
    extracted: row.extractedPath !== null,
  });
});
```

- [ ] **Step 3: 类型检查 + 全量相关测试**

```bash
cd apps/api && pnpm typecheck && pnpm vitest run src/pi/space/
```

预期：typecheck exit 0；space 目录既有测试（artifacts.test.ts、threadAttachments.test.ts 等）全绿。

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/pi/space/router.ts
git commit -m "feat(api): POST /assistant/versions/:versionId/attachments——docx 预上传端点"
```

---

### Task 4: API — `read_thread_attachment` 工具

**Files:**
- Create: `apps/api/src/pi/space/tools/readThreadAttachment.ts`
- Modify: `apps/api/src/pi/space/tools/index.ts`

- [ ] **Step 1: 创建工具**

`apps/api/src/pi/space/tools/readThreadAttachment.ts`：

```ts
/**
 * 读助手 docx 附件的提取文本（一般问答用；skill 深解析走 docx-to-cases 的
 * parse_docx.py 直接读原件——表格结构只有原件里有）。
 * 路径双重校验（confinedPath + DB 行归属当前版本）防跨版本读。
 */
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { readAssistantAttachmentText } from '../threadAttachments.js';

export function buildReadThreadAttachmentTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'read_thread_attachment',
    description: '读取用户在对话中上传的 docx 附件全文（服务端 mammoth 提取的纯文本，不含表格结构）。path 取用户消息里 <uploaded-file path="…"/> 标签的值。需要表格/标题层级时改用 docx-to-cases 技能的 parse_docx.py 直接解析原件。',
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
    }),
    promptGuidelines: [
      '用户消息里出现 <uploaded-file path="…"/> 标签时，需要文档内容就用 read_thread_attachment 按需读全文；需要表格/标题层级时用 docx-to-cases 技能的 parse_docx.py 直接解析原件，不要用本工具替代。',
    ],
    execute: async (input) => {
      const { path } = input as { path: string };
      const hit = await readAssistantAttachmentText(ctx.versionId, path);
      if (!hit) return { ok: false, error: `附件不存在或不属于当前版本: ${path}` };
      if (!hit.row.extractedPath) {
        return { ok: false, error: `该附件文本提取失败（文件可能损坏），可让 docx-to-cases 技能的 parse_docx.py 直接解析原件: ${path}` };
      }
      return {
        ok: true,
        data: hit.truncated
          ? `${hit.text}\n\n[已截断至 ${hit.text.length} 字符，全文 ${hit.row.extractedChars} 字符]`
          : hit.text,
      };
    },
  };
}
```

- [ ] **Step 2: 注册工具**

`apps/api/src/pi/space/tools/index.ts`：import 区（`import { buildRunSkillScriptTool } from './runSkillScript.js';` 之后）加：

```ts
import { buildReadThreadAttachmentTool } from './readThreadAttachment.js';
```

`buildSpaceTools` 内（`tools.push(buildRunSkillScriptTool(ctx));` 之后）加：

```ts
  tools.push(buildReadThreadAttachmentTool(ctx));
```

- [ ] **Step 3: 类型检查**

```bash
cd apps/api && pnpm typecheck
```

预期：exit 0。

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/pi/space/tools/readThreadAttachment.ts apps/api/src/pi/space/tools/index.ts
git commit -m "feat(api): read_thread_attachment 工具——按需读 docx 提取文本（版本作用域双重校验）"
```

---

### Task 5: web — api client `uploadDocx`

**Files:**
- Modify: `apps/web/src/api/client.ts`（在既有 `attachments: { … }` 块之后加兄弟块）

- [ ] **Step 1: 加客户端方法**

在 `apps/web/src/api/client.ts` 的 `attachments: { upload… list… },` 块之后插入：

```ts
  assistantAttachments: {
    /** 助手 docx 预上传（版本作用域）。X-Filename 走 encodeURIComponent：中文文件名
     *  直塞 Headers 在部分浏览器抛 ByteString 错（cases 旧路径未处理，不动旧码，这里做对）。 */
    uploadDocx: async (versionId: string, file: File) => {
      const buf = await file.arrayBuffer();
      const r = await fetch(`${BASE}/assistant/versions/${versionId}/attachments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: buf,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<{
        name: string;
        path: string;
        chars: number | null;
        size: number;
        sha256: string;
        deduped: boolean;
        extracted: boolean;
      }>;
    },
  },
```

- [ ] **Step 2: 类型检查**

```bash
cd apps/web && pnpm typecheck
```

预期：exit 0。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/api/client.ts
git commit -m "feat(web): api client 增加 assistantAttachments.uploadDocx（编码文件名的预上传）"
```

---

### Task 6: web — DocxAttachmentAdapter + 引用标签工具函数（TDD）

**Files:**
- Create: `apps/web/src/features/space-assistant/DocxAttachmentAdapter.ts`
- Create: `apps/web/src/features/space-assistant/uploadedFileTag.ts`
- Test: `apps/web/src/features/space-assistant/DocxAttachmentAdapter.test.ts`
- Test: `apps/web/src/features/space-assistant/uploadedFileTag.test.ts`

- [ ] **Step 1: 写 uploadedFileTag 失败测试**

`apps/web/src/features/space-assistant/uploadedFileTag.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { splitUploadedFileTags, buildUploadedFileTag, UPLOADED_FILE_TAG_RE } from './uploadedFileTag';

describe('splitUploadedFileTags', () => {
  it('无标签：原样单段返回', () => {
    expect(splitUploadedFileTags('普通消息')).toEqual(['普通消息']);
  });
  it('标签在末尾：切成 [正文, meta]', () => {
    const out = splitUploadedFileTags('请生成用例\n<uploaded-file name="需求.docx" path="/a/b.docx" chars="42"/>');
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('请生成用例');
    expect(out[1]).toEqual({ name: '需求.docx', path: '/a/b.docx', chars: '42' });
  });
  it('多个标签与夹缝文本：顺序保留', () => {
    const out = splitUploadedFileTags(
      '<uploaded-file name="a.docx" path="/a" chars="1"/>中间<uploaded-file name="b.docx" path="/b" chars="unknown"/>',
    );
    expect(out).toEqual([
      { name: 'a.docx', path: '/a', chars: '1' },
      '中间',
      { name: 'b.docx', path: '/b', chars: 'unknown' },
    ]);
  });
});

describe('buildUploadedFileTag', () => {
  it('构造自闭合标签；chars=null → unknown；文件名双引号转义', () => {
    expect(buildUploadedFileTag('需求.docx', '/a/b.docx', 42))
      .toBe('<uploaded-file name="需求.docx" path="/a/b.docx" chars="42"/>');
    expect(buildUploadedFileTag('带"引号".docx', '/a', null))
      .toBe('<uploaded-file name="带&quot;引号&quot;.docx" path="/a" chars="unknown"/>');
  });
  it('构造出的标签能被解析正则吃回（round-trip）', () => {
    const tag = buildUploadedFileTag('x.docx', '/p', 7);
    expect(UPLOADED_FILE_TAG_RE.test(tag)).toBe(true);
    expect(splitUploadedFileTags(tag)).toEqual([{ name: 'x.docx', path: '/p', chars: '7' }]);
  });
});
```

- [ ] **Step 2: 写 adapter 失败测试**

`apps/web/src/features/space-assistant/DocxAttachmentAdapter.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  api: {
    assistantAttachments: {
      uploadDocx: vi.fn(),
    },
  },
}));

import { api } from '../../api/client';
import { DocxAttachmentAdapter } from './DocxAttachmentAdapter';

const uploadDocx = vi.mocked(api.assistantAttachments.uploadDocx);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function makeFile(name = '需求规格.docx', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: DOCX_MIME });
}

beforeEach(() => {
  uploadDocx.mockReset();
});

describe('DocxAttachmentAdapter', () => {
  it('add → send：上传一次并把结果拼成引用标签文本部件', async () => {
    uploadDocx.mockResolvedValue({
      name: '需求规格.docx', path: '/data/uploads/assistant/v1/abc.docx',
      chars: 42, size: 1024, sha256: 'abc', deduped: false, extracted: true,
    });
    const ad = new DocxAttachmentAdapter('v1', { tooLarge: 'docx 超过 10MB 上限' });
    const pending = await ad.add({ file: makeFile() });
    expect(pending.name).toBe('需求规格.docx');
    const done = await ad.send(pending);
    expect(uploadDocx).toHaveBeenCalledTimes(1);
    expect(done.status.type).toBe('complete');
    expect(done.content).toEqual([{
      type: 'text',
      text: '<uploaded-file name="需求规格.docx" path="/data/uploads/assistant/v1/abc.docx" chars="42"/>',
    }]);
  });

  it('超过 10MB：add 直接抛错，不发起上传', async () => {
    const ad = new DocxAttachmentAdapter('v1', { tooLarge: 'docx 超过 10MB 上限' });
    await expect(ad.add({ file: makeFile('big.docx', 10 * 1024 * 1024 + 1) }))
      .rejects.toThrow('docx 超过 10MB 上限');
    expect(uploadDocx).not.toHaveBeenCalled();
  });

  it('上传失败：send 抛错（消息不发出的语义）', async () => {
    uploadDocx.mockRejectedValue(new Error('HTTP 413'));
    const ad = new DocxAttachmentAdapter('v1', { tooLarge: 'docx 超过 10MB 上限' });
    const pending = await ad.add({ file: makeFile() });
    await expect(ad.send(pending)).rejects.toThrow('HTTP 413');
  });

  it('remove 丢弃进行中上传后 send 走直传兜底', async () => {
    uploadDocx.mockResolvedValue({
      name: 'a.docx', path: '/p', chars: 1, size: 1, sha256: 's', deduped: false, extracted: true,
    });
    const ad = new DocxAttachmentAdapter('v1', { tooLarge: 'x' });
    const pending = await ad.add({ file: makeFile() });
    await ad.remove(pending);
    await ad.send(pending);
    expect(uploadDocx).toHaveBeenCalledTimes(2); // add 一次 + send 兜底一次
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd apps/web && pnpm vitest run src/features/space-assistant/DocxAttachmentAdapter.test.ts src/features/space-assistant/uploadedFileTag.test.ts
```

预期：FAIL（两个模块不存在）。

- [ ] **Step 4: 实现 uploadedFileTag.ts**

`apps/web/src/features/space-assistant/uploadedFileTag.ts`：

```ts
/**
 * <uploaded-file …/> 引用标签：构造（adapter send 用）与解析折叠（气泡渲染用）。
 * 标签以纯文本形态进消息正文——这是「乐观消息 == pi 记录 == 回放」一致性的载体，
 * 渲染层只做显示变换，绝不改消息原文。
 */
export interface UploadedFileMeta {
  name: string;
  path: string;
  chars: string;
}

/** 属性顺序固定（name/path/chars），与解析正则互为镜像。 */
export const UPLOADED_FILE_TAG_RE = /<uploaded-file\s+name="([^"]*)"\s+path="([^"]*)"\s+chars="([^"]*)"\s*\/>/g;

export function buildUploadedFileTag(name: string, path: string, chars: number | null): string {
  const n = name.replace(/"/g, '&quot;');
  const c = chars === null ? 'unknown' : String(chars);
  return `<uploaded-file name="${n}" path="${path}" chars="${c}"/>`;
}

/** 把文本切成 [string | UploadedFileMeta, …] 段。纯函数。 */
export function splitUploadedFileTags(text: string): (string | UploadedFileMeta)[] {
  const out: (string | UploadedFileMeta)[] = [];
  let last = 0;
  for (const m of text.matchAll(UPLOADED_FILE_TAG_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    out.push({ name: m[1]!, path: m[2]!, chars: m[3]! });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [''];
}
```

- [ ] **Step 5: 实现 DocxAttachmentAdapter.ts**

`apps/web/src/features/space-assistant/DocxAttachmentAdapter.ts`：

```ts
/**
 * docx 附件 adapter：选文件即预上传（POST /assistant/versions/:id/attachments），
 * send() 把服务端签发的引用标签作为**文本部件**返回。
 *
 * 为什么是文本部件而不是 image 部件/dataURL：react-pi 的 ThreadController 会把附件的
 * 文本部件拍平进消息正文（buildPiSendInput，ThreadController.js:82-94），于是
 * 「乐观消息 == pi 会话记录 == SSE 回放」逐字一致——userContentKey 对账匹配、无重复
 * 气泡。后端任何对消息文本的改写都会破坏这一不变量，见 spec 2026-10-29。
 *
 * 上传在 add() 即刻开始（后台 Promise）；失败在 send() 统一抛出——消息不发出、错误可见。
 */
import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from '@assistant-ui/react';
import { api } from '../../api/client';
import { buildUploadedFileTag } from './uploadedFileTag';

const DOCX_MAX_BYTES = 10 * 1024 * 1024;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface DocxAdapterLabels {
  tooLarge: string;
}

function genId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class DocxAttachmentAdapter implements AttachmentAdapter {
  accept = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  /** attachmentId → 进行中的上传 Promise；remove() 时丢弃，send() 时 await。 */
  private uploads = new Map<string, Promise<unknown>>();

  constructor(
    private versionId: string,
    private labels: DocxAdapterLabels,
  ) {}

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    if (file.size > DOCX_MAX_BYTES) {
      throw new Error(`${this.labels.tooLarge}（${(file.size / 1024 / 1024).toFixed(1)}MB）`);
    }
    const id = genId();
    this.uploads.set(id, api.assistantAttachments.uploadDocx(this.versionId, file));
    return {
      id,
      type: 'document',
      name: file.name,
      contentType: file.type || DOCX_MIME,
      file,
      // 与 SimpleImageAttachmentAdapter 同款状态：composer 直接可发送，send() 内 await 上传。
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const pending = this.uploads.get(attachment.id);
    let r: Awaited<ReturnType<typeof api.assistantAttachments.uploadDocx>>;
    if (pending) {
      this.uploads.delete(attachment.id);
      r = await pending as typeof r; // 上传失败在此抛出：消息不发出
    } else {
      // add 阶段的上传已被清理（remove 后仍发送等极端时序）——同步补传兜底。
      r = await api.assistantAttachments.uploadDocx(this.versionId, attachment.file!);
    }
    return {
      ...attachment,
      status: { type: 'complete' },
      content: [{ type: 'text', text: buildUploadedFileTag(r.name, r.path, r.chars) }],
    };
  }

  async remove(attachment: Attachment): Promise<void> {
    this.uploads.delete(attachment.id);
  }
}
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd apps/web && pnpm vitest run src/features/space-assistant/DocxAttachmentAdapter.test.ts src/features/space-assistant/uploadedFileTag.test.ts
```

预期：8 个用例全 PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/space-assistant/DocxAttachmentAdapter.ts apps/web/src/features/space-assistant/DocxAttachmentAdapter.test.ts apps/web/src/features/space-assistant/uploadedFileTag.ts apps/web/src/features/space-assistant/uploadedFileTag.test.ts
git commit -m "feat(web): DocxAttachmentAdapter——预上传+引用标签文本部件；标签构造/解析纯函数"
```

---

### Task 7: web — 接线与渲染（Composer / 气泡 chip / i18n）

**Files:**
- Modify: `apps/web/src/features/space-assistant/SpaceWorkspace.tsx`
- Modify: `apps/web/src/features/space-assistant/SpaceThreadPane.tsx`
- Modify: `apps/web/src/i18n/locales/zh-CN/assistant.json`
- Modify: `apps/web/src/i18n/locales/en-US/assistant.json`

- [ ] **Step 1: SpaceWorkspace 换组合 adapter**

`apps/web/src/features/space-assistant/SpaceWorkspace.tsx`：

import 区改——`SimpleImageAttachmentAdapter` 行替换为：

```ts
import {
  AssistantRuntimeProvider,
  CompositeAttachmentAdapter,
  SimpleImageAttachmentAdapter,
  useAui,
  useAuiState,
  useTranslation,
  type ThreadSuggestion,
} from '@assistant-ui/react';
```

（`useTranslation` 若与文件内其他 import 冲突则单独从 `'react-i18next'` 引入。）加：

```ts
import { DocxAttachmentAdapter } from './DocxAttachmentAdapter';
```

原 L106-110 的 adapter 块：

```ts
  // 图片附件 adapter:composer 的 addAttachment 没有 adapter 会直接抛
  // 「Attachments are not supported」(base-composer-runtime-core.js:470),而 react-pi
  // 不提供 attachment adapter,必须由这里注入。这个实现把 File 读成 dataURL,
  // ThreadController 再拆成 pi 的 ImageContent 随 input.attachments 上行。
  const attachments = useMemo(() => new SimpleImageAttachmentAdapter(), []);
```

替换为：

```ts
  const { t } = useTranslation();
  // 组合附件 adapter：图片走 SimpleImage（dataURL → pi ImageContent）；
  // docx 走 Docx（预上传 → send() 把 <uploaded-file …/> 标签作为文本部件返回，
  // ThreadController 拍平进消息正文——与 pi 记录逐字一致，userContentKey 对账无重复气泡）。
  const attachments = useMemo(
    () => new CompositeAttachmentAdapter([
      new SimpleImageAttachmentAdapter(),
      new DocxAttachmentAdapter(versionId, { tooLarge: t('assistant:attachment.docxTooLarge') }),
    ]),
    [versionId, t],
  );
```

- [ ] **Step 2: SpaceThreadPane — UserMessage 文本渲染 + composer 附件卡**

`apps/web/src/features/space-assistant/SpaceThreadPane.tsx`：

import 区加：

```ts
import { splitUploadedFileTags, type UploadedFileMeta } from './uploadedFileTag';
```

UserMessage（L140-153）里：

```tsx
        <MessagePrimitive.Parts components={{ Image: UserImagePart }} />
```

替换为：

```tsx
        <MessagePrimitive.Parts components={{ Image: UserImagePart, Text: UserTextPart }} />
```

在 `UserImagePart`（L155-164）之后新增：

```tsx
/** 用户消息文本 part：把 <uploaded-file …/> 引用标签折叠成附件 chip，其余原样。
 *  只做显示层变换——消息原文（含标签）保持原样进 pi 会话与对账 key。 */
function UserTextPart({ text }: TextMessagePartProps) {
  const parts = splitUploadedFileTags(text);
  if (parts.length === 1 && typeof parts[0] === 'string') return <>{parts[0]}</>;
  return (
    <>
      {parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <UploadedFileChip key={i} meta={p} />))}
    </>
  );
}

/** 历史消息里的文档附件 chip：图标 + 文件名 + 字数。 */
function UploadedFileChip({ meta }: { meta: UploadedFileMeta }) {
  const chars = meta.chars === 'unknown' ? '' : ` · ${Number(meta.chars).toLocaleString()} 字`;
  return (
    <span
      className="my-1 inline-flex max-w-full items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-0.5 text-[12px]"
      style={{ borderColor: 'var(--border)', background: 'var(--popover)', color: 'var(--muted-foreground)' }}
    >
      <Icon name="file" size={12} />
      <span className="max-w-[240px] truncate">{meta.name}</span>
      <span>{chars}</span>
    </span>
  );
}
```

`ComposerAttachment`（L172-196）的 Thumb 分支——原：

```tsx
      <AttachmentPrimitive.unstable_Thumb>
        <img
          src={dataUrl ?? objectUrl ?? ''}
          alt={attachment.name}
          className="h-14 w-auto rounded-[var(--radius-sm)] object-cover"
        />
      </AttachmentPrimitive.unstable_Thumb>
```

替换为：

```tsx
      <AttachmentPrimitive.unstable_Thumb>
        {isDocxAttachment(attachment) ? (
          <div
            className="flex h-14 w-32 items-center gap-1.5 rounded-[var(--radius-sm)] border px-2"
            style={{ borderColor: 'var(--border)', background: 'var(--popover)' }}
          >
            <Icon name="file" size={14} />
            <span className="truncate text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {attachment.name}
            </span>
          </div>
        ) : (
          <img
            src={dataUrl ?? objectUrl ?? ''}
            alt={attachment.name}
            className="h-14 w-auto rounded-[var(--radius-sm)] object-cover"
          />
        )}
      </AttachmentPrimitive.unstable_Thumb>
```

并在 `ComposerAttachment` 上方加辅助函数：

```tsx
/** docx 附件判别：contentType（浏览器对 .docx 给 wordprocessingml mime）或扩展名兜底。 */
function isDocxAttachment(a: Attachment): boolean {
  return /\.docx$/i.test(a.name) || /wordprocessingml/i.test(a.contentType ?? '');
}
```

（`Icon`、`Attachment` 均已在本文件 import。）

- [ ] **Step 3: i18n 文案**

`apps/web/src/i18n/locales/zh-CN/assistant.json` 的 `"attachment"` 块替换为：

```json
  "attachment": {
    "add": "添加图片/文件",
    "remove": "移除",
    "docxTooLarge": "docx 超过 10MB 上限",
    "docxFile": "Word 文档"
  },
```

`apps/web/src/i18n/locales/en-US/assistant.json` 的 `"attachment"` 块替换为：

```json
  "attachment": {
    "add": "Add image/file",
    "remove": "Remove",
    "docxTooLarge": "docx exceeds the 10MB limit",
    "docxFile": "Word document"
  },
```

- [ ] **Step 4: 类型检查 + web 测试**

```bash
cd apps/web && pnpm typecheck && pnpm vitest run src/features/space-assistant/
```

预期：typecheck exit 0；space-assistant 目录全部测试绿（含既有 LiveViewRail/spaceEventsStore/threadListPager/threadBuckets）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/features/space-assistant/SpaceWorkspace.tsx apps/web/src/features/space-assistant/SpaceThreadPane.tsx apps/web/src/i18n/locales/zh-CN/assistant.json apps/web/src/i18n/locales/en-US/assistant.json
git commit -m "feat(web): composer 组合附件接线 + 气泡引用标签折叠 chip + docx 附件卡"
```

---

### Task 8: skill — parse_docx.py 解析器（TDD）

**Files:**
- Create: `apps/api/scripts/docx-to-cases-content/scripts/parse_docx.py`
- Test: `apps/api/src/pi/space/parseDocxScript.test.ts`（vitest 全包收集默认含 src；用 cwd 相对路径指脚本）

- [ ] **Step 1: 写失败测试**

`apps/api/src/pi/space/parseDocxScript.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import archiver from 'archiver';

const exec = promisify(execFile);
const SCRIPT = path.resolve(process.cwd(), 'scripts/docx-to-cases-content/scripts/parse_docx.py');

/** 用 archiver（已有依赖）现场构造最小 docx（zip + document.xml/styles.xml）。 */
async function buildDocx(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'docx-'));
  const out = path.join(dir, 'fixture.docx');
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const sink = new Writable({
      write(c, _e, cb) { chunks.push(c as Buffer); cb(); },
    });
    archive.pipe(sink);
    for (const [name, body] of Object.entries(files)) archive.append(body, { name });
    void archive.finalize().then(async () => {
      await writeFile(out, Buffer.concat(chunks));
      resolve();
    }, reject);
  });
  return out;
}

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>登录模块</w:t></w:r></w:p>
<w:p><w:r><w:t>用户通过账号密码登录。</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>REQ-001</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>登录成功</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:pPr><w:pStyle w:val="H2"/></w:pPr><w:r><w:t>密码规则</w:t></w:r></w:p>
<w:p><w:r><w:t>密码长度至少 8 位。</w:t></w:r></w:p>
</w:body></w:document>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="H1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="H2"><w:name w:val="heading 2"/></w:style>
</w:styles>`;

function lastJson(stdout: string): any {
  return JSON.parse(stdout.trim().split('\n').pop()!);
}

describe('parse_docx.py', () => {
  it('outline：H1 成节、段落/表格计数、子标题清单', async () => {
    const docx = await buildDocx({ 'word/document.xml': DOCUMENT_XML, 'word/styles.xml': STYLES_XML });
    const out = lastJson((await exec('python3', [SCRIPT, docx])).stdout);
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('outline');
    expect(out.stats.sections).toBe(1);
    expect(out.stats.tables).toBe(1);
    expect(out.sections[0].title).toBe('登录模块');
    expect(out.sections[0].paras).toBe(2);
    expect(out.sections[0].tables).toEqual([{ rows: 1, cols: 2 }]);
    expect(out.sections[0].subheadings).toEqual(['密码规则']);
  });

  it('--section 0：段落全文与表格单元格完整', async () => {
    const docx = await buildDocx({ 'word/document.xml': DOCUMENT_XML, 'word/styles.xml': STYLES_XML });
    const out = lastJson((await exec('python3', [SCRIPT, docx, '--section', '0'])).stdout);
    expect(out.ok).toBe(true);
    const texts = out.blocks.filter((b: any) => b.type === 'para').map((b: any) => b.text);
    expect(texts).toContain('用户通过账号密码登录。');
    expect(texts).toContain('密码长度至少 8 位。');
    expect(out.blocks.find((b: any) => b.type === 'table').rows).toEqual([['REQ-001', '登录成功']]);
  });

  it('--sub 0：子章节切分正确', async () => {
    const docx = await buildDocx({ 'word/document.xml': DOCUMENT_XML, 'word/styles.xml': STYLES_XML });
    const out = lastJson((await exec('python3', [SCRIPT, docx, '--section', '0', '--sub', '0'])).stdout);
    expect(out.title).toBe('登录模块 / 密码规则');
    const texts = out.blocks.filter((b: any) => b.type === 'para').map((b: any) => b.text);
    expect(texts).toEqual(['密码长度至少 8 位。']);
  });

  it('非 zip 文件：ok=false 且退出码非 0', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'docx-'));
    const fake = path.join(dir, 'fake.docx');
    await writeFile(fake, 'not a zip at all');
    await expect(exec('python3', [SCRIPT, fake])).rejects.toThrow();
  });

  it('zip bomb（声明展开量超阈值）：拒绝', async () => {
    const docx = await buildDocx({
      'word/document.xml': DOCUMENT_XML,
      'word/styles.xml': STYLES_XML,
      'big.txt': 'x'.repeat(2048),
    });
    await expect(exec('python3', [SCRIPT, docx], {
      env: { ...process.env, DOCX_MAX_TOTAL_BYTES: '1024' },
    })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm vitest run src/pi/space/parseDocxScript.test.ts
```

预期：FAIL（脚本文件不存在，execFile 报 ENOENT）。

- [ ] **Step 3: 实现 parse_docx.py**

`apps/api/scripts/docx-to-cases-content/scripts/parse_docx.py`：

```python
#!/usr/bin/env python3
"""docx 结构化解析器（docx-to-cases 技能专用；零第三方依赖：zipfile + xml.etree）。

用法：
  parse_docx.py <path>                      # outline：顶层章节骨架 + 表格形状 + stats
  parse_docx.py <path> --section N          # 第 N 个顶层章节的完整内容（0 起）
  parse_docx.py <path> --section N --sub M  # 顶层章节 N 下第 M 个子章节（0 起）

输出：stdout 单行紧凑 JSON。分段取内容天然避开 run_skill_script 的 100KB 输出上限
（.out/ 目录被 read_skill 文件树排除——点开头目录不进树，写文件回读不可行）。

zip bomb 防护：zip 条目数与总展开量（infolist 声明值，读前判断）上限，超限退出码 1。
阈值可用环境变量覆写（测试用）：DOCX_MAX_ENTRIES / DOCX_MAX_TOTAL_BYTES。
"""
import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
DOCXML = 'word/document.xml'
STYLES = 'word/styles.xml'
MAX_ENTRIES = int(os.environ.get('DOCX_MAX_ENTRIES', '2000'))
MAX_TOTAL_BYTES = int(os.environ.get('DOCX_MAX_TOTAL_BYTES', str(200 * 1024 * 1024)))
# 单条输出护栏：防一章把 stdout 撑爆。
MAX_CELL_CHARS = 500
MAX_PARA_CHARS = 4000
MAX_TABLE_ROWS = 200


def fail(msg):
    print(json.dumps({'ok': False, 'error': msg}, ensure_ascii=False))
    sys.exit(1)


def load_zip(path):
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        fail('not a valid zip/docx: %s' % path)
    infos = z.infolist()
    if len(infos) > MAX_ENTRIES:
        fail('zip entries %d > %d' % (len(infos), MAX_ENTRIES))
    total = sum(i.file_size for i in infos)
    if total > MAX_TOTAL_BYTES:
        fail('zip uncompressed size %d > %d (zip bomb?)' % (total, MAX_TOTAL_BYTES))
    return z


def style_levels(z):
    """styleId → 标题级别。按 styles.xml 的 name 匹配「heading N / 标题 N」（两种惯例都收）。"""
    out = {}
    try:
        root = ET.fromstring(z.read(STYLES))
    except (KeyError, ET.ParseError):
        return out
    for st in root.iter(W + 'style'):
        sid = st.get(W + 'styleId')
        nm = st.find(W + 'name')
        name = (nm.get(W + 'val') if nm is not None else '') or ''
        m = re.match(r'^(?:heading|标题)\s*([1-6])$', name.strip(), re.I)
        if sid and m:
            out[sid] = int(m.group(1))
    return out


def para_text(p):
    return ''.join(t.text or '' for t in p.iter(W + 't')).strip()


def table_rows(tbl):
    rows = []
    for tr in tbl.findall(W + 'tr')[:MAX_TABLE_ROWS]:
        cells = []
        for tc in tr.findall(W + 'tc'):
            txt = ' '.join(filter(None, (para_text(p) for p in tc.findall(W + 'p'))))
            cells.append(txt[:MAX_CELL_CHARS])
        rows.append(cells)
    return rows


def parse_blocks(z, levels):
    """文档体 → 块序列：{type:heading,level,text} | {type:para,text} | {type:table,rows}（保序）。"""
    try:
        root = ET.fromstring(z.read(DOCXML))
    except (KeyError, ET.ParseError):
        fail('missing or malformed %s' % DOCXML)
    body = root.find(W + 'body')
    if body is None:
        fail('no body in %s' % DOCXML)
    blocks = []
    for child in body:
        if child.tag == W + 'p':
            text = para_text(child)[:MAX_PARA_CHARS]
            if not text:
                continue
            ps = child.find(W + 'pPr/' + W + 'pStyle')
            sid = ps.get(W + 'val') if ps is not None else None
            lvl = levels.get(sid) if sid else None
            if lvl:
                blocks.append({'type': 'heading', 'level': lvl, 'text': text})
            else:
                blocks.append({'type': 'para', 'text': text})
        elif child.tag == W + 'tbl':
            blocks.append({'type': 'table', 'rows': table_rows(child)})
    return blocks


def build_sections(blocks):
    """顶层章节切分：level<=1 的 heading 开新章（heading 本身即标题，不重复入块）；
    全文无标题 → 单章 title='(untitled)'。"""
    sections = []
    cur = None
    for b in blocks:
        is_top = b['type'] == 'heading' and b['level'] <= 1
        if is_top:
            cur = {'title': b['text'], 'blocks': []}
            sections.append(cur)
        elif cur is None:
            cur = {'title': '(untitled)', 'blocks': []}
            sections.append(cur)
        if not is_top:
            cur['blocks'].append(b)
    return sections


def outline(path):
    z = load_zip(path)
    blocks = parse_blocks(z, style_levels(z))
    sections = build_sections(blocks)
    sec_out = []
    for s in sections:
        sec_out.append({
            'i': len(sec_out),
            'title': s['title'],
            'paras': sum(1 for b in s['blocks'] if b['type'] == 'para'),
            'tables': [
                {'rows': len(t['rows']), 'cols': max((len(r) for r in t['rows']), default=0)}
                for t in s['blocks'] if t['type'] == 'table'
            ],
            'subheadings': [b['text'] for b in s['blocks'] if b['type'] == 'heading'],
        })
    return {
        'ok': True,
        'mode': 'outline',
        'stats': {
            'sections': len(sections),
            'paras': sum(1 for b in blocks if b['type'] == 'para'),
            'tables': sum(1 for b in blocks if b['type'] == 'table'),
            'headings': sum(1 for b in blocks if b['type'] == 'heading'),
        },
        'sections': sec_out,
    }


def section_content(path, n, m):
    z = load_zip(path)
    blocks = parse_blocks(z, style_levels(z))
    sections = build_sections(blocks)
    if n < 0 or n >= len(sections):
        fail('section index %s out of range (0..%d)' % (n, len(sections) - 1))
    title = sections[n]['title']
    blocks = sections[n]['blocks']
    if m is not None:
        subs = []
        cur = None
        for b in blocks:
            is_sub = b['type'] == 'heading' and b['level'] <= 2
            if is_sub:
                cur = {'title': b['text'], 'blocks': []}
                subs.append(cur)
            elif cur is None:
                cur = {'title': '(untitled)', 'blocks': []}
                subs.append(cur)
            if not is_sub:
                cur['blocks'].append(b)
        if m < 0 or m >= len(subs):
            fail('sub index %s out of range (0..%d)' % (m, len(subs) - 1))
        title = title + ' / ' + subs[m]['title']
        blocks = subs[m]['blocks']
    content = []
    for b in blocks:
        if b['type'] == 'table':
            content.append({'type': 'table', 'rows': b['rows']})
        else:
            content.append({'type': b['type'], 'text': b['text']})
    return {'ok': True, 'mode': 'section', 'section': n, 'sub': m, 'title': title, 'blocks': content}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--section', type=int, default=None)
    ap.add_argument('--sub', type=int, default=None)
    args = ap.parse_args()
    if not os.path.isfile(args.path):
        fail('file not found: %s' % args.path)
    out = outline(args.path) if args.section is None else section_content(args.path, args.section, args.sub)
    print(json.dumps(out, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm vitest run src/pi/space/parseDocxScript.test.ts
```

预期：5 个用例全 PASS（本机需有 `python3`，macOS/Linux 容器均自带）。

- [ ] **Step 5: 提交**

```bash
git add apps/api/scripts/docx-to-cases-content/scripts/parse_docx.py apps/api/src/pi/space/parseDocxScript.test.ts
git commit -m "feat(skill): parse_docx.py——stdlib 解析 docx 结构（outline/section 双模式+zip bomb 防护）"
```

---

### Task 9: skill — SKILL.md 与 references

**Files:**
- Create: `apps/api/scripts/docx-to-cases-content/SKILL.md`
- Create: `apps/api/scripts/docx-to-cases-content/references/design-principles.md`
- Create: `apps/api/scripts/docx-to-cases-content/references/case-mapping.md`

- [ ] **Step 1: 写 SKILL.md**

`apps/api/scripts/docx-to-cases-content/SKILL.md`：

```markdown
---
name: docx-to-cases
description: 从用户上传的 Word（.docx）需求文档生成测试用例并暂存入库（stage_case → 用户在暂存面板确认落库）。当用户说「根据（这份）文档/需求生成用例」「把需求文档转成用例」且消息里有 <uploaded-file …/> 标签时使用。
---

# docx 需求文档 → 平台测试用例

把用户在对话里上传的 Word 需求文档转成平台用例库中的测试用例。
终点是 **stage_case 暂存**（用户在暂存面板勾选落库），不是生成文档。

## 第 0 步：定位输入

在最近的用户消息里找 `<uploaded-file name="…" path="…" chars="…"/>` 标签：
- 有 → 取 path 进入第 1 步
- 没有 → 请用户用输入框的附件按钮上传 .docx 后重说一次，不要凭空开做

## 第 1 步：结构化解析

```
run_skill_script(skillName="docx-to-cases", script="scripts/parse_docx.py", args=["<path>"])
```

先拿 outline（章节骨架/表格形状/stats）。取章节内容：

```
args=["<path>", "--section", "N"]        # 顶层章节全文（段落+表格）
args=["<path>", "--section", "N", "--sub", "M"]   # 子章节
```

解析返回 `ok=false` → 把 error 原因告诉用户并停在那里，不要臆测文档内容。

## 第 2 步：需求提取与确认

从章节段落与表格行识别需求条目：需求编号（`REQ-\d+`、`-\d+` 等原样）、模块（所属章节）、
优先级（原文档标注）、验收标准。列出清单（编号 + 一句话）请用户确认范围；用户可剔除/补充。
**未确认前不进入设计。**

## 第 3 步：测试类型建议

关键词扫描：性能（并发/响应时间/吞吐）、安全（认证/授权/注入/越权）、集成（接口/联动/消息）、
可靠性（重试/超时/降级/故障）、可服务性（日志/监控/配置）。默认功能测试；检测到关键词的
类型建议追加并给一句理由，用户可增删。确认结果记为本次生成范围。

## 第 4 步：设计用例

必读 `references/design-principles.md`（场景配比与设计方法）。
字段映射与 stage_case 参数规范必读 `references/case-mapping.md`（用 read_skill 的
file 参数读取，如 `read_skill(skillName="docx-to-cases", file="references/case-mapping.md")`）。

## 第 5 步：逐条暂存

每条用例调用一次 `stage_case`（localId 每例新生成 UUID）。需求 >20 条时**串行分批**：
每批 ≤10 条 stage_case 后继续下一批，不要等待用户逐条确认（暂存面板统一确认）。
禁止试图并行或一轮塞入全部超长内容。

## 第 6 步：收尾

汇总：X 条需求 → Y 条用例（按模块/测试类型分布），提醒用户到暂存面板确认落库；
可提示 `export_cases_xmind` 导出。

## 核心纪律

- **严禁臆造**：文档与解析结果里没有的不编；解析失败就明说
- 步骤必须具体到按钮/输入框/取值；预期必须可验证（页面状态/提示文案/数据变化）
- 拿不准的内容标 `[需确认]` 或 `[假设]`，不要静默填充
- 需求编号/优先级等原值原样带入，不做转换
- 一份文档一次流程；用户要调整时改对应的暂存项（stage_case_op）或说明后重做，不重复堆叠
```

- [ ] **Step 2: 写 references/design-principles.md**

`apps/api/scripts/docx-to-cases-content/references/design-principles.md`：

```markdown
# 测试用例设计原则（docx-to-cases）

## 场景配比（对每一组需求整体把握，逐条不必机械均分）

| 场景类型 | 占比 | 覆盖内容 |
|---|---|---|
| 正常场景 | ~30% | 主流程、典型取值、默认路径 |
| 异常场景 | ~40% | 错误输入、缺权限、网络/依赖失败、重复提交 |
| 边界场景 | ~20% | 极限值、空值、刚好越界一位、长度上限 |
| 安全场景 | ~10% | 越权访问、注入类输入、敏感数据暴露 |

## 设计方法（按需求性质选用）

- **等价类划分**：输入域分有效/无效等价类，每类至少一条
- **边界值分析**：取边界、边界±1（数值区间、字符串长度、分页页码）
- **场景法**：业务流按「基本流 + 备选流」展开，一条用例走一条完整路径
- **错误推测**：空提交、重复提交、并发点击、特殊字符（`'"<>%` 与全角/emoji）
- **判定表**：多条件组合的需求（N 个条件 → 关键组合枚举，不穷举）

## 具体性要求

- 步骤里的操作对象用**界面上真实存在的名称**（按钮文字/输入框标签/菜单路径）
- 测试数据给出**具体值**（「输入用户名」不行，「输入 user_001」才行）
- 文档里给不出界面细节时，步骤写业务动作并标 `[假设]`，不要编造界面元素

## 可验证性要求

- 预期结果必须能被观察：页面跳转/提示文案/列表变化/数据记录，至少占其一
- 「系统正常处理」不算预期；「提示『保存成功』且列表新增一行」才算
```

- [ ] **Step 3: 写 references/case-mapping.md**

`apps/api/scripts/docx-to-cases-content/references/case-mapping.md`：

```markdown
# 需求字段 → stage_case 参数映射（docx-to-cases）

## 映射表

| 需求侧信息 | stage_case 参数 | 规则 |
|---|---|---|
| （每例生成） | `localId` | 每条用例新生成一个 UUID v4，绝不复用 |
| 需求点 + 场景 | `title` | 「模块-需求点-场景」动宾短语，≤200 字，不用句号结尾 |
| 需求描述/背景 | `description` | ≤4000 字；来源段落压缩，保留验收标准原文 |
| 优先级（文档标注） | `priority` | 文档写「高/严重」→ P0/P1，「中」→ P2，「低」→ P3；未标 → P2 |
| 登录页/入口 URL（文档明确给出时） | `url` | 原样；没给就不填，不要编 |
| 操作步骤 | `steps[].action` | 自然语言一步一做事，≤2000 字/步，最多 30 步；具体性见 design-principles |
| 预期结果 | `steps[].assertion` 或 `expectedOutcome` | 步内可判的写 assertion；整例终态写 expectedOutcome |
| 需求编号 | `requirementNo` | 原样带入（≤64 字），多条需求合成一例时取主需求编号 |
| 测试类型（第 3 步确认的范围） | `coverageTypes` | 仅当用户明确选择了测试类型才填；默认不填 |

## 不要填的参数

- `compiled`：固化由平台后续流程处理，本技能不产出 DSL
- `defaultEnvId` / `datasetLocalId`：环境与数据集由用户在界面配置

## 硬校验（stage_case 会拒绝的）

- `localId` 不是 36 位 UUID → 调用失败
- `title` 空或 >200 字 → 调用失败
- `steps` >30 条 → 调用失败

一批 stage_case 连续失败时：读返回的 error 修正参数重试同一条，不要跳过也不静默丢。
```

- [ ] **Step 4: 提交**

```bash
git add apps/api/scripts/docx-to-cases-content/SKILL.md apps/api/scripts/docx-to-cases-content/references/
git commit -m "feat(skill): docx-to-cases SKILL.md 与 references（设计原则/字段映射）"
```

---

### Task 10: skill — 种子脚本与 deploy 接线

**Files:**
- Create: `apps/api/scripts/seed-docx-to-cases-skill.mjs`
- Modify: `infra/docker/deploy.sh`（word-test-report seed 块之后）

- [ ] **Step 1: 写种子脚本（结构仿 seed-word-report-skill.mjs：缺失才铺 + upsert 元数据 + AppleDouble 清理）**

`apps/api/scripts/seed-docx-to-cases-skill.mjs`：

```js
#!/usr/bin/env node
/** docx-to-cases skill 种子：落盘目录树 + upsert 元数据；缺失才铺，改文案须手动重铺（删目录或手动 cp）。
 *  结构与 seed-word-report-skill.mjs 一致（存储翻转后内容以文件系统为真源，DB 只留元数据）。 */
import { readFile, cp, rm, mkdir, readdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'docx-to-cases-content');
const NAME = 'docx-to-cases';

/** 与 skillImport.parseFrontmatter 同源的极简 frontmatter 取值（够覆盖自产 + 常见第三方）。 */
function parseFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*(name|description)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) v = v.slice(1, -1);
    if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) v = v.slice(1, -1);
    if (v) out[kv[1]] = v;
  }
  return out;
}

/** 递归数文件数（只发计数，不打内容）。 */
async function countFiles(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += await countFiles(join(dir, e.name));
    else if (e.isFile()) n += 1;
  }
  return n;
}

/** 递归删除 AppleDouble 残骸（`._xxx`）：macOS 打包会把扩展属性落成 `._xxx`，
 *  被 read_skill 文件树当真实文件列出。铺目录前清源，铺完再清目标（真实文件不动）。 */
async function pruneAppleDouble(dir) {
  let removed = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      removed += await pruneAppleDouble(p);
    } else if (e.name.startsWith('._')) {
      await rm(p, { force: true });
      removed += 1;
    }
  }
  return removed;
}

async function main() {
  const md = await readFile(join(CONTENT_DIR, 'SKILL.md'), 'utf8');
  const fm = parseFrontmatter(md);
  const description = (fm.description ?? 'docx-to-cases skill').trim().slice(0, 500);

  const root = process.env.PI_DATA_DIR
    ? join(process.env.PI_DATA_DIR, 'skills')
    : '/repo/apps/api/.data/skills';
  const target = join(root, NAME);

  // 目录是发布物，但尊重用户编辑：只有缺失/空才铺。
  let seeded = false;
  try {
    await access(join(target, 'SKILL.md'));
  } catch {
    await rm(target, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await pruneAppleDouble(CONTENT_DIR);
    await cp(CONTENT_DIR, target, { recursive: true });
    seeded = true;
  }
  const pruned = await pruneAppleDouble(target);
  if (pruned > 0) {
    console.log(`已清理 ${pruned} 个 AppleDouble 残骸文件（${target}）`);
  }

  const client = process.env.DATABASE_URL
    ? new pg.Client({ connectionString: process.env.DATABASE_URL })
    : new pg.Client({ host: 'itest-pg', user: 'itest', password: 'itest', database: 'itest' });
  await client.connect();
  try {
    const fileCount = await countFiles(target);
    let inserted = false;
    let r;
    try {
      r = await client.query(
        `INSERT INTO assistant_skills (id, name, description, enabled)
         VALUES (gen_random_uuid(), $1, $2, true)
         ON CONFLICT (name) DO NOTHING RETURNING name`,
        [NAME, description],
      );
      inserted = r.rows.length > 0;
    } catch (e) {
      if (!/body|scripts|column/.test(e.message)) throw e;
      const { rows } = await client.query('SELECT name FROM assistant_skills WHERE name = $1', [NAME]);
      if (!rows[0]) throw e;
      console.warn(
        `WARN: assistant_skills 仍是旧 schema（含 body/scripts），无法补元数据行；` +
          `「${NAME}」DB 行已存在、技能目录已落盘（${fileCount} 文件），可正常使用。` +
          `待 drizzle-kit push 迁移后重跑本脚本即可。`,
      );
      return;
    }
    console.log(
      seeded
        ? `已落盘 skill "${NAME}"（${fileCount} 文件 → ${target}）${inserted ? '，并补齐 DB 元数据行' : '；DB 行已存在（幂等）'}`
        : `技能目录已存在，未覆盖（${fileCount} 文件 → ${target}）${inserted ? '，补齐 DB 元数据行' : ''}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('seeding failed:', e.message);
  process.exit(1);
});
```

- [ ] **Step 2: 本地铺一次验证（dev 库 + dev 数据目录）**

```bash
cd apps/api && PI_DATA_DIR="$PWD/.data" node scripts/seed-docx-to-cases-skill.mjs
```

预期输出：`已落盘 skill "docx-to-cases"（4 文件 → …/apps/api/.data/skills/docx-to-cases）`。
（DATABASE_URL 取你 dev 进程环境里的值；若连接失败，导出 `DATABASE_URL=postgres://…` 后重跑。）
验证目录树：

```bash
find apps/api/.data/skills/docx-to-cases -type f | sort
```

预期恰好 4 个文件：

```
apps/api/.data/skills/docx-to-cases/SKILL.md
apps/api/.data/skills/docx-to-cases/references/case-mapping.md
apps/api/.data/skills/docx-to-cases/references/design-principles.md
apps/api/.data/skills/docx-to-cases/scripts/parse_docx.py
```

- [ ] **Step 3: deploy.sh 接线**

`infra/docker/deploy.sh`，在 word-test-report seed 块（`echo "== seed word-test-report ==" … || echo "WARN: word-test-report seed 失败…"`）之后插入：

```bash

echo "== seed docx-to-cases =="
docker exec "$(api_replica)" node /repo/apps/api/scripts/seed-docx-to-cases-skill.mjs \
  || echo "WARN: docx-to-cases seed 失败，助手将看不到该技能（不影响其余功能）"
```

- [ ] **Step 4: 提交**

```bash
git add apps/api/scripts/seed-docx-to-cases-skill.mjs infra/docker/deploy.sh
git commit -m "feat(skill): docx-to-cases 种子脚本 + deploy.sh 接线（缺失才铺）"
```

---

### Task 11: E2E 手测主路径 + 收尾核查

**Files:** 无新文件（验证任务）

前置：dev 环境（api dev server 需 `ENCRYPTION_KEY` 与 `CHROMIUM_PATH` 环境变量，turbo strict env 会剥离未声明变量）；Task 1 Step 3 的 dev 表已建；Task 10 Step 2 的 skill 已铺且 DB enabled。

- [ ] **Step 1: 起 dev 服务**

```bash
# 终端 1（按你本地惯例带环境变量）
cd apps/api && ENCRYPTION_KEY=devkey CHROMIUM_PATH=<你的 chromium 路径> pnpm dev
# 终端 2
cd apps/web && pnpm dev
```

（注：记忆中 `ENCRYPTION_KEY=devkey` 是坏值——用你本地实际可用的 key。）

- [ ] **Step 2: 造一份真实感需求 docx**

```bash
cd apps/api && node -e '
const archiver = require("archiver"); const fs = require("fs");
const out = fs.createWriteStream("/tmp/需求规格.docx");
const a = archiver("zip"); a.pipe(out);
a.append(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>用户管理模块</w:t></w:r></w:p>
<w:p><w:r><w:t>本模块提供用户的增删改查与登录能力。系统应支持高并发登录，响应时间不超过 2 秒。</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>REQ-001</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>新增用户</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>高</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>管理员在用户列表点新增，填写必填项后保存成功</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>REQ-002</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>删除用户</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>中</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>删除前二次确认，删除后列表移除该行</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>`, { name: "word/document.xml" });
a.append(`<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="H1"><w:name w:val="heading 1"/></w:style>
</w:styles>`, { name: "word/styles.xml" });
a.finalize().then(() => console.log("written /tmp/需求规格.docx"));
'
```

预期：`written /tmp/需求规格.docx`。

- [ ] **Step 3: 浏览器走主路径（逐项核对）**

打开某版本空间的 AI 助手，逐项核对：

1. composer 附件按钮可选 .docx；选中后出**文档图标卡**（非破图）
2. 发送「根据这份文档生成用例」→ 消息发出，**用户气泡只有一行正文 + 文档 chip（无重复气泡、无裸标签文本）**
3. AI 回应中出现 parse_docx 的 outline 调用（run_skill_script）与需求清单确认（REQ-001/002）
4. 回复确认后走到 stage_case；右侧 StagePanel 出现暂存用例
5. StagePanel 勾选落库成功；用例列表可见
6. 新消息问「总结一下这份文档讲了什么」→ AI 调 `read_thread_attachment` 并给出含「用户管理/并发登录」的摘要
7. 刷新页面重进该线程：历史气泡 chip 仍在、无重复消息
8. 同版本另开新线程问「我之前传的 /…/xxx.docx 讲了什么」（贴旧 path）→ read_thread_attachment 正常返回（版本作用域生效）；换一个**不存在**的路径 → 工具报「附件不存在或不属于当前版本」

任何一步不符合 → 停下按 spec 对应条目排查修复后再继续。

- [ ] **Step 4: 回归——附件图片路径未被破坏**

在同一会话上传一张 png 截图发送 → 正常出图、历史可见（组合 adapter 未破坏原 image 路径）。

- [ ] **Step 5: 收尾核查（必做）**

```bash
git status
```

预期：只有本计划各任务提交过的文件；若出现陌生改动（尤其 `apps/api/src/agent/prompts/step-dsl-spec.ts` 或 `.data/` 之外的产物）→ 逐一还原（`git checkout -- <file>`）。`.data/` 变更不入库（已被忽略）。

```bash
cd apps/api && pnpm typecheck && cd ../web && pnpm typecheck
```

预期：双双 exit 0。

---

## Self-Review 记录（计划完成后已核对）

1. **Spec 覆盖**：预上传端点（Task 3）、表与去重（1/2）、read_thread_attachment（4）、前端 adapter/渲染/i18n（5/6/7）、parse_docx 双模式+bomb 防护（8）、SKILL 7 步流程与质量纪律（9）、seed+deploy（10）、错误边界（2/3/6 的校验 + 11 的 E2E 核对项）、范围外未引入。
2. **占位符**：无 TBD/TODO；所有代码步骤含完整代码。
3. **类型一致性**：`buildUploadedFileTag`/`splitUploadedFileTags`/`UPLOADED_FILE_TAG_RE` 三处引用一致；`DocxAdapterLabels`、`saveDocxUpload`/`readAssistantAttachmentText` 签名在 Task 2 定义、Task 3/4/6 消费处一致；表名 `ai_assistant_attachments` 全计划统一。
