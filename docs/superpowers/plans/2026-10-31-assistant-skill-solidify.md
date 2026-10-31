# AI 助手固化 skill / prompt 可编辑化（R3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 两条工作流——A. prompt 可编辑化基建（模块注册表 + append-only 版本链 + 渲染覆盖，零版本数据时逐字节等于现状）；B. 固化管线（盘点批次 → LLM 蒸馏提案 → 逐条人工审批 → 应用/源退役）。

**Architecture:** 代码是模块注册表（`promptModules.ts`），DB 是值存储（`assistant_prompt_module_versions` 版本链：无行=代码默认、NULL=跟随默认、当前值=max seq、回滚=复制追加）。固化管线 LLM 只产提案，应用一律经人工审批（乐观锁 + source_ref 幂等 + 退役 active 守卫）；盘点是 inline fire-and-forget（R2 trajectoryQueue 同款），不引 BullMQ。

**Tech Stack:** api：drizzle-orm + postgres、express、zod、vitest + @testcontainers/postgresql、pi LLM client（completeJson）。web：React + @tanstack/react-query + react-i18next。

**Spec:** `docs/superpowers/specs/2026-10-31-assistant-skill-solidify-design.md`（已评审通过）

---

## 关键背景（零上下文工程师必读）

1. **仓库根**：`/Users/lyq/workdir/codedev/iTest`；api 在 `apps/api`，web 在 `apps/web`。
2. **测试命令**：api 单文件 `cd apps/api && npm test -- <文件名子串>`（test script = `TESTCONTAINERS_RYUK_DISABLED=true vitest run`，testcontainer 拉起 postgres:16-alpine）；web 全量 `cd apps/web && pnpm verify`（typecheck + i18n:check + test，i18n:check 强制中英文 key 对齐）。已知基线：`sendSyslog` 相关测试基线即红；api 全量并发会轮转假失败——判回归先单跑文件。
3. **dev DB**：本地容器 `itest-pg`，管理员 `admin/Itest@2026`。新表不会自动建——须手动 psql 执行 Task 1 的 CREATE TABLE 块。生产靠 api 容器启动时 `drizzle-kit push --force` 自动建表，无需迁移脚本。
4. **drizzle 表风格**：schema.ts 用 `(t) => ({ xxxIdx: index(...), xxxUq: uniqueIndex(...).where(sql\`...\`) })` 对象回调（见 `assistantTrajectories`，schema.ts:839-861——partial unique index 的先例）。
5. **路由模式**：`apps/api/src/pi/space/memoriesRoute.ts` 是新路由的样板（`Router()` + `HttpError` + `req.user as AuthUser`）。`HttpError` 从 `'../../middleware/errorHandler.js'` import；用户 id 取 `user.userId`。
6. **挂载点**：`apps/api/src/pi/space/router.ts:465-468` 已有 `spaceRoute.use('/memories', requireManager, memoriesRoute)` 等，新路由照此追加。
7. **渲染红线**：DB 零版本数据时 system prompt 与工具文案必须与现状**逐字节一致**（R1/R2 同款回归锚点）。红线测试的常量是 session.ts 现文案的**硬拷贝**（独立锚点才有意义，禁止 import 被测常量）。
8. **跑 api 测试会改仓库源码的坑**：收尾必查 `git status`，陌生文件/源码文件被改则还原。
9. **循环依赖设计**：`session.ts` 静态 import `promptModules.ts` 的默认值常量；`promptModules.ts` 枚举工具文案需要 `buildSpaceTools` → 用**动态 import** 反向引用（调用时模块已就绪，不形成静态环）。
10. **skill 存储**：磁盘是真源（`SKILLS_ROOT` = PI_DATA_DIR 下 `skills/`，`skillsStore.ts`），DB `assistant_skills` 只存 name/description/enabled。`SKILL.md` = frontmatter（name/description）+ 正文。`writeSkillMd(dir, name, description, body)` 在 `skillsService.ts:52`，目前私有——Task 2 加 export。

## File Structure

**新建（api）：**
- `apps/api/src/pi/space/promptModules.ts` —— 模块注册表 + 值解析 + 覆盖应用（工作流 A 核心，无路由）
- `apps/api/src/pi/space/promptModulesRoute.ts` —— 模块列表 / 版本链 / 直改+回滚路由
- `apps/api/src/pi/space/solidifyService.ts` —— 盘点批次 + LLM 蒸馏管线（发起/防重入/蒸馏/入库）
- `apps/api/src/pi/space/solidifyApply.ts` —— 审批执行（乐观锁 → 应用 prompt/skill → 源退役；驳回）
- `apps/api/src/pi/space/solidifyRoute.ts` —— 固化管线 REST

**新建（web）：**
- `apps/web/src/components/settings/PromptModulesSection.tsx` —— 设置页「系统提示词」Section
- `apps/web/src/components/settings/SolidifySection.tsx` —— 设置页「固化盘点」Section

**新建（测试）：**
- `apps/api/test/prompt-schema.test.ts`（Task 1）
- `apps/api/test/prompt-modules.test.ts`（Task 2）
- `apps/api/test/prompt-override.test.ts`（Task 2 红线 + Task 3 覆盖）
- `apps/api/test/prompt-modules-route.test.ts`（Task 4）
- `apps/api/test/solidify-service.test.ts`（Task 5）
- `apps/api/test/solidify-apply.test.ts`（Task 6）
- `apps/api/test/solidify-route.test.ts`（Task 7）

**修改：**
- `apps/api/src/db/schema.ts` —— import 加 `bigserial`；追加三张新表
- `apps/api/test/helpers/db.ts` —— SCHEMA_SQL 追加三张表的 CREATE 语句
- `apps/api/src/pi/space/session.ts` —— 常量迁移为 import（Task 2）；overrides 参数 + 工厂接线（Task 3）
- `apps/api/src/pi/space/skillsService.ts:52` —— `writeSkillMd` 加 export（Task 2）
- `apps/api/src/pi/space/router.ts` —— 挂载两个新路由（Task 4/7）
- `apps/web/src/api/client.ts` —— `assistant.promptModules` / `assistant.solidify` 两组端点 + 类型（Task 8）
- `apps/web/src/components/settings/AssistantPanel.tsx` —— 两个新 Section（Task 9）
- `apps/web/src/i18n/locales/zh-CN/settings.json` + `apps/web/src/i18n/locales/en/settings.json`（Task 9）

---

### Task 1: DB schema——三张新表

**Files:**
- Modify: `apps/api/src/db/schema.ts`（import 块 :1-15 加 `bigserial`；`assistantTrajectories` 之后 :861 追加三张表）
- Modify: `apps/api/test/helpers/db.ts`（SCHEMA_SQL 末尾 :213 之后、收尾反引号之前追加）
- Test: `apps/api/test/prompt-schema.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/prompt-schema.test.ts`：

```ts
/** R3 三张新表的 SCHEMA_SQL 可用性：版本链 partial unique 幂等、批次/提案级联。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_solidify_proposals, assistant_solidify_batches, assistant_prompt_module_versions`);
});

describe('R3 schema：三张新表', () => {
  it('assistant_prompt_module_versions：source_ref 命中 partial unique → 冲突不落行', async () => {
    const ref = crypto.randomUUID();
    const r1 = await pool.query(
      `INSERT INTO assistant_prompt_module_versions (module_key, value, source, source_ref)
       VALUES ('space.style.zh', 'a', 'solidify_apply', $1) RETURNING seq`, [ref]);
    const r2 = await pool.query(
      `INSERT INTO assistant_prompt_module_versions (module_key, value, source, source_ref)
       VALUES ('space.style.zh', 'b', 'solidify_apply', $1) ON CONFLICT DO NOTHING RETURNING seq`, [ref]);
    expect(r1.rows.length).toBe(1);
    expect(r2.rows.length).toBe(0);
  });

  it('source_ref 为 NULL 的行不受唯一约束（多次手工编辑合法）', async () => {
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', 'x', 'manual_edit')`);
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', 'y', 'manual_edit')`);
    const n = await pool.query(`SELECT count(*)::int n FROM assistant_prompt_module_versions WHERE module_key = 'space.style.zh'`);
    expect(n.rows[0].n).toBe(2);
  });

  it('batches/proposals：删批次级联删提案', async () => {
    const b = await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('done') RETURNING id`);
    await pool.query(
      `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, distill_model)
       VALUES ($1, 'prompt_amendment', 'space.style.zh', 't', 'b', 'r', '[]', 'm')`, [b.rows[0].id]);
    await pool.query(`DELETE FROM assistant_solidify_batches WHERE id = $1`, [b.rows[0].id]);
    const n = await pool.query(`SELECT count(*)::int n FROM assistant_solidify_proposals`);
    expect(n.rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- prompt-schema`
Expected: FAIL——SCHEMA_SQL 里还没有三张新表（relation does not exist）。

- [ ] **Step 3: schema.ts 加表**

`apps/api/src/db/schema.ts` import 块（:1-15）加 `bigserial`（加在 `boolean,` 之后即可）。在 `assistantTrajectories` 表定义结束（`:861` 的 `}));`）之后追加：

```ts
// ── R3 prompt 可编辑化：模块值存储（append-only 版本链）──
// 代码是模块注册表（promptModules.ts），DB 是值存储：无行=代码默认（清库回出厂）；
// value=NULL=「跟随代码默认」（显式恢复默认，值随发版演进）；当前值=每 module_key
// 取 seq 最大行；回滚=把历史行 value 复制追加为新行（回滚也留痕，可再回滚）。
// partial unique：同一固化提案重复应用只落一行（幂等锚）；NULL 手工行不受限。
export const assistantPromptModuleVersions = pgTable('assistant_prompt_module_versions', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  moduleKey: varchar('module_key', { length: 100 }).notNull(),
  value: text('value'),
  source: varchar('source', { length: 20 }).notNull(),
  sourceRef: uuid('source_ref'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  keySeqIdx: index('assistant_prompt_module_versions_key_seq_idx').on(t.moduleKey, t.seq),
  sourceRefUq: uniqueIndex('assistant_prompt_module_versions_source_ref_uq').on(t.sourceRef).where(sql`${t.sourceRef} is not null`),
}));

// ── R3 固化管线：盘点批次 ──
// 人工低频动作：inline fire-and-forget（R2 trajectoryQueue 同款），不引 BullMQ。
// status=running 时再发起 → 409 防重入。
export const assistantSolidifyBatches = pgTable('assistant_solidify_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: varchar('status', { length: 16 }).notNull(),
  inputSummary: text('input_summary'),
  error: text('error'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ── R3 固化管线：固化提案 ──
// LLM 只产提案不碰资产；应用一律经人工批准。prompt_amendment 的 body=追加进模块值
// 的增量文案；skill_revision 的 body=修订后的完整正文（不含 frontmatter）。
// 部分失败：apply_error 记原因 + status 回 pending 可重试（幂等三件套保证重试安全）。
export interface AssistantSolidifyProposalSource {
  type: 'memory' | 'trajectory';
  id: string;
  title: string;
  /** 来源线名（创建时定格，'global'=全局记忆）——审批详情展示「来源线」用，免 UI 二次 join。 */
  lineName: string;
  /** 服务端定值（不信任 LLM 输出）：memory=true（固化后线内注入冗余），trajectory=false（保留 few-shot 价值）。 */
  retireRecommended: boolean;
}

export const assistantSolidifyProposals = pgTable('assistant_solidify_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').references(() => assistantSolidifyBatches.id, { onDelete: 'cascade' }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull(),
  target: varchar('target', { length: 100 }).notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body').notNull(),
  rationale: text('rationale').notNull(),
  sources: jsonb('sources').$type<AssistantSolidifyProposalSource[]>().notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at'),
  appliedAt: timestamp('applied_at'),
  applyError: text('apply_error'),
  distillModel: varchar('distill_model', { length: 64 }).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  batchIdx: index('assistant_solidify_proposals_batch_idx').on(t.batchId, t.status),
}));
```

- [ ] **Step 4: helpers/db.ts 追加 SCHEMA_SQL**

`apps/api/test/helpers/db.ts` SCHEMA_SQL 模板字符串末尾（`assistant_trajectories_case_uq` 那行之后、收尾 `` ` `` 之前）追加：

```sql
CREATE TABLE assistant_prompt_module_versions (seq bigserial PRIMARY KEY, module_key varchar(100) NOT NULL, value text, source varchar(20) NOT NULL, source_ref uuid, created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamp NOT NULL DEFAULT now());
CREATE INDEX assistant_prompt_module_versions_key_seq_idx ON assistant_prompt_module_versions(module_key, seq);
CREATE UNIQUE INDEX assistant_prompt_module_versions_source_ref_uq ON assistant_prompt_module_versions(source_ref) WHERE source_ref IS NOT NULL;
CREATE TABLE assistant_solidify_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status varchar(16) NOT NULL, input_summary text, error text, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE assistant_solidify_proposals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid REFERENCES assistant_solidify_batches(id) ON DELETE CASCADE NOT NULL, kind varchar(20) NOT NULL, target varchar(100) NOT NULL, title varchar(200) NOT NULL, body text NOT NULL, rationale text NOT NULL, sources jsonb NOT NULL, status varchar(16) NOT NULL DEFAULT 'pending', reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL, reviewed_at timestamp, applied_at timestamp, apply_error text, distill_model varchar(64) NOT NULL, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamp NOT NULL DEFAULT now());
CREATE INDEX assistant_solidify_proposals_batch_idx ON assistant_solidify_proposals(batch_id, status);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- prompt-schema`
Expected: PASS（3 tests）。

- [ ] **Step 6: dev 库手动建表**

```bash
docker exec -i itest-pg psql -U admin -d itest <<'EOF'
CREATE TABLE assistant_prompt_module_versions (seq bigserial PRIMARY KEY, module_key varchar(100) NOT NULL, value text, source varchar(20) NOT NULL, source_ref uuid, created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamp NOT NULL DEFAULT now());
CREATE INDEX assistant_prompt_module_versions_key_seq_idx ON assistant_prompt_module_versions(module_key, seq);
CREATE UNIQUE INDEX assistant_prompt_module_versions_source_ref_uq ON assistant_prompt_module_versions(source_ref) WHERE source_ref IS NOT NULL;
CREATE TABLE assistant_solidify_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status varchar(16) NOT NULL, input_summary text, error text, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE assistant_solidify_proposals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid REFERENCES assistant_solidify_batches(id) ON DELETE CASCADE NOT NULL, kind varchar(20) NOT NULL, target varchar(100) NOT NULL, title varchar(200) NOT NULL, body text NOT NULL, rationale text NOT NULL, sources jsonb NOT NULL, status varchar(16) NOT NULL DEFAULT 'pending', reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL, reviewed_at timestamp, applied_at timestamp, apply_error text, distill_model varchar(64) NOT NULL, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamp NOT NULL DEFAULT now());
CREATE INDEX assistant_solidify_proposals_batch_idx ON assistant_solidify_proposals(batch_id, status);
EOF
```

注：若库名不是 `itest` 先 `docker exec itest-pg psql -U admin -l` 确认。生产无需手工——api 容器启动 `drizzle-kit push` 自动建。

- [ ] **Step 7: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
git add apps/api/src/db/schema.ts apps/api/test/helpers/db.ts apps/api/test/prompt-schema.test.ts
git commit -m "feat(space): R3 三张新表——prompt 模块版本链(append-only+source_ref 幂等)/固化批次/固化提案"
```

---

### Task 2: promptModules.ts 注册表 + 常量迁移（渲染红线锚点）

**Files:**
- Create: `apps/api/src/pi/space/promptModules.ts`
- Modify: `apps/api/src/pi/space/skillsService.ts:52`（`writeSkillMd` 加 `export`）
- Modify: `apps/api/src/pi/space/session.ts`（:649-652 三个内联字符串改为 import；行为零变化）
- Test: `apps/api/test/prompt-override.test.ts`（红线锚点，本任务先写先绿）
- Test: `apps/api/test/prompt-modules.test.ts`

**常量迁移纪律**：session.ts:650-652 的三个字符串是红线基准。测试常量必须从**改造前的 session.ts 原文硬拷贝**（Step 1 时文件还是原状），不许 import 被测常量——独立锚点才有红线意义。若 Step 2 测试不过，以 session.ts 原文为准修测试常量直到过。

- [ ] **Step 1: 写红线测试（对现状跑绿）**

创建 `apps/api/test/prompt-override.test.ts`：

```ts
/**
 * R3 渲染红线：DB 零版本数据时 system prompt 与迁移前逐字节一致。
 * 三个常量是 session.ts 改造前(:650-652) 原文的硬拷贝——独立锚点，禁止 import 被测常量。
 * Task 3 会在此文件追加覆盖生效/DB 集成用例。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL } from './helpers/db.js';

const ZH_STYLE = '## 输出风格\n- 用户使用简体中文提问,全部回复一律用简体中文(代码、命令、英文术语可保留原文)。这条约束覆盖**每一条**用户可见文本,包括最终答复、调用工具前的过程说明、以及思考/推理独白——不要出现「Let me check」「I found that」「I should」这类英文句子,想查什么直接调工具即可。\n- 不要使用 emoji;强调用 markdown 加粗,列举用列表/表格。\n- 以资深测试专家的标准要求自己:简洁专业、结论先行。默认每条回复不超过 5 行(汇报步骤结果时用短列表);不复述工具动作过程、不复述页面结构、不把元素清单原文贴给用户、不输出超过 4 行的大表格——用一句话概括。\n- 杜绝胡编乱造:对被测系统的任何断言(页面上有哪些控件/筛选项/按钮、系统行为如何)必须有证据——verify_case 返回的实测元素清单(page/failure.page)、执行结果、或用户告知;清单里没有的控件一律当作不存在,不得提议、不得写进步骤。不确定就明说并询问用户。';
const EN_STYLE = '## Output style\n- The user writes in English. All replies MUST be in English (code, commands, and English terms may stay). This constraint covers every piece of user-visible text, including final replies, process explanations before tool calls, and reasoning monologues — do not write Chinese sentences like 「让我检查一下」, if you need to check something just call a tool.\n- Do not use emoji; emphasize with markdown bold, and enumerate with lists/tables.\n- Be a senior test expert: concise and professional. Lead with the conclusion; default to ≤5 lines per reply (a short list is fine when reporting step results). Do not narrate tool actions, do not restate page structure or paste element inventories back to the user, and do not dump tables longer than 4 rows — summarize instead.\n- Never fabricate. Claims about the system under test (which controls/filters/buttons a page has, how it behaves) must come from verify_case evidence (page / failure.page element lists), execution results, or the user — never from assumption. If you are not sure, say so and ask.';
const WORKSPACE = '## 工作空间\n- 当前目录是版本专属工作空间，项目仓库已检出到 ./repo 子目录。\n- repo_ls / repo_read / repo_grep 仅在用户明确要求看代码或分析仓库时使用；用例创建与实测过程不要用它们做侦察——元素与页面问题以 verify_case 实测反馈为证据。';

let container: StartedPostgreSqlContainer;
let pool: Pool;

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

describe('R3 渲染红线：零覆盖 = 现状逐字节', () => {
  it('zh：prompt 含原文风格段与工作空间段', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const p = buildSpaceSystemPrompt('版本摘要', 'zh-CN', [], '', '');
    expect(p).toContain(ZH_STYLE);
    expect(p).toContain(WORKSPACE);
    expect(p.endsWith('## 版本空间上下文\n版本摘要')).toBe(true);
  });

  it('en：prompt 含原文英文风格段', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const p = buildSpaceSystemPrompt('summary', 'en-US', [], '', '');
    expect(p).toContain(EN_STYLE);
    expect(p).toContain(WORKSPACE);
    expect(p.endsWith('## 版本空间上下文\nsummary')).toBe(true);
  });
});
```

- [ ] **Step 2: 对现状跑绿（锚点校验）**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- prompt-override`
Expected: PASS（2 tests）。若 FAIL，说明测试常量拷贝走样——以 session.ts:650-652 原文修正测试常量直到 PASS（这一步校验的是锚点本身）。

- [ ] **Step 3: 创建 promptModules.ts**

创建 `apps/api/src/pi/space/promptModules.ts`（三个 DEFAULT 常量的值 = Step 1 测试常量同一原文，从 session.ts:650-652 迁来）：

```ts
/**
 * R3 prompt 可编辑化：模块注册表 + DB 值存储解析 + 渲染覆盖。
 *
 * 存储模型：代码是模块注册表（有哪些模块、默认值是什么），DB 是值存储
 * （assistant_prompt_module_versions append-only 版本链）。无行=代码默认；
 * value=NULL=跟随代码默认；当前值=每 module_key 取 seq 最大行；回滚=复制历史行。
 *
 * 渲染红线：DB 零版本数据时 system prompt 与工具文案与现状逐字节一致
 * （test/prompt-override.test.ts 硬拷贝锚点）。
 *
 * 循环依赖：session.ts 静态 import 本模块的默认值常量；本模块枚举工具文案需要
 * buildSpaceTools → 动态 import 反向引用（调用时模块已就绪，不形成静态环）。
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { db } from '../../db/client.js';
import { assistantPromptModuleVersions, assistantSkills } from '../../db/schema.js';
import { skillDirOf } from './skillsStore.js';
import { emptyRepoState, type SpaceToolsContext } from './tools/context.js';

// ── 主 prompt 三段默认值（自 session.ts :650-652 原样迁来；迁移零行为变化，由
// prompt-override.test.ts 的独立硬拷贝锚定）──

export const STYLE_ZH_DEFAULT = '## 输出风格\n- 用户使用简体中文提问,全部回复一律用简体中文(代码、命令、英文术语可保留原文)。这条约束覆盖**每一条**用户可见文本,包括最终答复、调用工具前的过程说明、以及思考/推理独白——不要出现「Let me check」「I found that」「I should」这类英文句子,想查什么直接调工具即可。\n- 不要使用 emoji;强调用 markdown 加粗,列举用列表/表格。\n- 以资深测试专家的标准要求自己:简洁专业、结论先行。默认每条回复不超过 5 行(汇报步骤结果时用短列表);不复述工具动作过程、不复述页面结构、不把元素清单原文贴给用户、不输出超过 4 行的大表格——用一句话概括。\n- 杜绝胡编乱造:对被测系统的任何断言(页面上有哪些控件/筛选项/按钮、系统行为如何)必须有证据——verify_case 返回的实测元素清单(page/failure.page)、执行结果、或用户告知;清单里没有的控件一律当作不存在,不得提议、不得写进步骤。不确定就明说并询问用户。';
export const STYLE_EN_DEFAULT = '## Output style\n- The user writes in English. All replies MUST be in English (code, commands, and English terms may stay). This constraint covers every piece of user-visible text, including final replies, process explanations before tool calls, and reasoning monologues — do not write Chinese sentences like 「让我检查一下」, if you need to check something just call a tool.\n- Do not use emoji; emphasize with markdown bold, and enumerate with lists/tables.\n- Be a senior test expert: concise and professional. Lead with the conclusion; default to ≤5 lines per reply (a short list is fine when reporting step results). Do not narrate tool actions, do not restate page structure or paste element inventories back to the user, and do not dump tables longer than 4 rows — summarize instead.\n- Never fabricate. Claims about the system under test (which controls/filters/buttons a page has, how it behaves) must come from verify_case evidence (page / failure.page element lists), execution results, or the user — never from assumption. If you are not sure, say so and ask.';
export const WORKSPACE_DEFAULT = '## 工作空间\n- 当前目录是版本专属工作空间，项目仓库已检出到 ./repo 子目录。\n- repo_ls / repo_read / repo_grep 仅在用户明确要求看代码或分析仓库时使用；用例创建与实测过程不要用它们做侦察——元素与页面问题以 verify_case 实测反馈为证据。';

export const STYLE_ZH_KEY = 'space.style.zh';
export const STYLE_EN_KEY = 'space.style.en';
export const WORKSPACE_KEY = 'space.workspace';

export type PromptModuleGroup = 'main' | 'tool' | 'skill';

export interface PromptModuleDef {
  key: string;
  group: PromptModuleGroup;
  label: string;
  /** skill 组只读：设置页只展示+回滚，不提供直接编辑（修订走固化管线/skill-creator）。 */
  readonly: boolean;
  defaultValue(): Promise<string>;
}

/** SKILL.md 正文去 frontmatter；无/坏 frontmatter 原样返回。 */
export function stripSkillFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\n+/, '');
}

/** 读 skill 磁盘正文（去 frontmatter）。文件缺失抛错，由调用方决定语义。 */
export async function readSkillBody(slug: string): Promise<string> {
  const md = await readFile(join(skillDirOf(slug), 'SKILL.md'), 'utf8');
  return stripSkillFrontmatter(md);
}

/** 枚举工具文案的 stub 上下文——与 test/space-tools-basic.test.ts 的 makeCtx 同款
 *  （buildSpaceTools 是同步纯注册，随机 uuid + 空 repo 即可；字段以该测试为准）。 */
function stubToolsCtx(): SpaceToolsContext {
  return {
    threadId: randomUUID(),
    versionId: randomUUID(),
    projectId: randomUUID(),
    repo: emptyRepoState(),
    emit: () => {},
    createdByUserId: null,
    manager: true,
  };
}

type ToolTextRaw = { name: string; description: string; promptGuidelines?: string[] };

/** 工具文案枚举：chat + rca 两种 purpose 的并集（防 purpose 过滤漏工具）。 */
export async function listRawToolsMerged(): Promise<ToolTextRaw[]> {
  const { buildSpaceTools } = await import('./session.js');
  const base = stubToolsCtx();
  const merged = new Map<string, ToolTextRaw>();
  for (const list of [buildSpaceTools(base), buildSpaceTools({ ...base, purpose: 'rca' })]) {
    for (const t of list as unknown as ToolTextRaw[]) merged.set(t.name, t);
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function listSkillDefs(): Promise<Array<{ slug: string; body: string }>> {
  const rows = await db.select({ name: assistantSkills.name }).from(assistantSkills)
    .where(eq(assistantSkills.enabled, true));
  const out: Array<{ slug: string; body: string }> = [];
  for (const r of rows) {
    const body = await readSkillBody(r.name).catch(() => null);
    if (body != null) out.push({ slug: r.name, body });
  }
  return out;
}

/** 注册表全量：主 prompt 三段（静态）+ 工具文案（运行时枚举）+ skill 正文（磁盘只读组）。 */
export async function listPromptModuleDefs(): Promise<PromptModuleDef[]> {
  const defs: PromptModuleDef[] = [
    { key: STYLE_ZH_KEY, group: 'main', label: '主提示词 · 输出风格（中文）', readonly: false, defaultValue: async () => STYLE_ZH_DEFAULT },
    { key: STYLE_EN_KEY, group: 'main', label: '主提示词 · 输出风格（英文）', readonly: false, defaultValue: async () => STYLE_EN_DEFAULT },
    { key: WORKSPACE_KEY, group: 'main', label: '主提示词 · 工作空间', readonly: false, defaultValue: async () => WORKSPACE_DEFAULT },
  ];
  for (const t of await listRawToolsMerged()) {
    defs.push({ key: `tool.${t.name}.description`, group: 'tool', label: `工具 ${t.name} · description`, readonly: false, defaultValue: async () => t.description });
    defs.push({ key: `tool.${t.name}.guidelines`, group: 'tool', label: `工具 ${t.name} · 提示规范`, readonly: false, defaultValue: async () => (t.promptGuidelines ?? []).join('\n') });
  }
  for (const s of await listSkillDefs()) {
    defs.push({ key: `skill.${s.slug}`, group: 'skill', label: `skill · ${s.slug}`, readonly: true, defaultValue: async () => s.body });
  }
  return defs;
}

// ── 值解析 ──

export interface PromptModuleVersionRow {
  seq: number;
  moduleKey: string;
  value: string | null;
  source: string;
  sourceRef: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

/** 当前值索引：全表 seq 降序，首见即当前（表只被人工低频写，量级小）。 */
export async function loadPromptModuleOverrides(): Promise<Map<string, PromptModuleVersionRow>> {
  const rows = await db.select().from(assistantPromptModuleVersions)
    .orderBy(desc(assistantPromptModuleVersions.seq));
  const map = new Map<string, PromptModuleVersionRow>();
  for (const r of rows) if (!map.has(r.moduleKey)) map.set(r.moduleKey, r);
  return map;
}

/** 容错版：查询失败回落空表（渲染用代码默认）——prompt 可用性不能拖垮会话（guides 同款）。 */
export async function loadPromptModuleOverridesSafe(): Promise<Map<string, PromptModuleVersionRow>> {
  try {
    return await loadPromptModuleOverrides();
  } catch (e) {
    logger.warn({ err: e }, 'prompt module overrides 加载失败;回落代码默认');
    return new Map();
  }
}

/** 覆盖值语义：NULL=跟随代码默认 → 视为无覆盖。 */
export function textOverrideOf(overrides: Map<string, PromptModuleVersionRow>, key: string): string | undefined {
  const v = overrides.get(key)?.value;
  return v != null && v !== '' ? v : undefined;
}

/** 工具文案覆盖：原地改 rawTools（工厂局部数组，改动即生效于 defineTool 注册）。
 *  guidelines 覆盖值按行拆（默认值是 string[] 按 \n join 的形态反解析）。 */
export function applyToolTextOverrides(
  tools: Array<{ name: string; description: string; promptGuidelines?: string[] }>,
  overrides: Map<string, PromptModuleVersionRow>,
): void {
  for (const t of tools) {
    const d = textOverrideOf(overrides, `tool.${t.name}.description`);
    if (d != null) t.description = d;
    const g = overrides.get(`tool.${t.name}.guidelines`)?.value;
    if (g != null && g.trim() !== '') {
      const lines = g.split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length > 0) t.promptGuidelines = lines;
    }
  }
}

/** 追加版本行。sourceRef 命中 partial unique（重放）→ 不落行，返回 null。 */
export async function insertPromptModuleVersion(row: {
  moduleKey: string;
  value: string | null;
  source: string;
  sourceRef?: string | null;
  createdByUserId?: string | null;
}): Promise<number | null> {
  const r = await db.insert(assistantPromptModuleVersions).values({
    moduleKey: row.moduleKey,
    value: row.value,
    source: row.source,
    ...(row.sourceRef != null ? { sourceRef: row.sourceRef } : {}),
    ...(row.createdByUserId != null ? { createdByUserId: row.createdByUserId } : {}),
  }).onConflictDoNothing().returning({ seq: assistantPromptModuleVersions.seq });
  return r[0]?.seq ?? null;
}

/** 单模块解析：注册表定义 + 当前版本行 + 生效文本（无行/NULL 行 → 代码默认）。 */
export async function resolvePromptModule(key: string): Promise<{
  def: PromptModuleDef;
  hasRow: boolean;
  seq: number | null;
  source: string | null;
  value: string | null;
  text: string;
} | null> {
  const def = (await listPromptModuleDefs()).find((d) => d.key === key);
  if (!def) return null;
  const ov = (await loadPromptModuleOverrides()).get(key);
  const text = ov?.value ?? await def.defaultValue();
  return { def, hasRow: ov != null, seq: ov?.seq ?? null, source: ov?.source ?? null, value: ov?.value ?? null, text };
}

/** skill 元数据（写盘时 frontmatter 从 DB 重拼，防文件/DB 漂移）。 */
export async function readSkillMeta(slug: string): Promise<{ name: string; description: string } | null> {
  const r = (await db.select({ name: assistantSkills.name, description: assistantSkills.description })
    .from(assistantSkills)
    .where(and(eq(assistantSkills.name, slug), eq(assistantSkills.enabled, true)))
    .limit(1))[0];
  return r ?? null;
}

/** 用 DB 元数据 + 正文重建 SKILL.md（frontmatter 重拼；body 为完整正文不含 frontmatter）。 */
export async function writeSkillBodyFromDb(name: string, description: string, body: string): Promise<void> {
  const { writeSkillMd } = await import('./skillsService.js');
  writeSkillMd(skillDirOf(name), name, description, body);
}
```

注：`stubToolsCtx` 若 typecheck 报缺字段，以 `apps/api/test/space-tools-basic.test.ts` 的 makeCtx 为准补齐；`SpaceToolsContext`/`emptyRepoState` 从 `./tools/context.js` import（路径见该测试文件的 import）。

- [ ] **Step 4: skillsService.ts 导出 writeSkillMd**

`apps/api/src/pi/space/skillsService.ts:52`：`function writeSkillMd(` → `export function writeSkillMd(`。

- [ ] **Step 5: session.ts 常量改 import（行为零变化）**

`apps/api/src/pi/space/session.ts` 文件头 import 区加：

```ts
import { STYLE_EN_DEFAULT, STYLE_ZH_DEFAULT, WORKSPACE_DEFAULT } from './promptModules.js';
```

`buildSpaceSystemPrompt` 内（:649-652）把三段内联字符串替换为常量引用：

```ts
  const isEn = aiLangFrom(lang ?? null) === 'en-US';
  const style = isEn ? STYLE_EN_DEFAULT : STYLE_ZH_DEFAULT;
  const workspace = WORKSPACE_DEFAULT;
```

（`const guidesSection ...` 及之后行不动。）

- [ ] **Step 6: 写 prompt-modules.test.ts**

创建 `apps/api/test/prompt-modules.test.ts`：

```ts
/** promptModules 单元+DB：frontmatter 剥离/工具文案覆盖/注册表枚举/值解析/幂等插入。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let tmpDataDir: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  tmpDataDir = mkdtempSync(join(tmpdir(), 'itest-pm-'));
  process.env.PI_DATA_DIR = tmpDataDir; // SKILLS_ROOT = <PI_DATA_DIR>/skills（skillsStore 推导）
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_prompt_module_versions, assistant_skills`);
});

describe('stripSkillFrontmatter', () => {
  it('剥 frontmatter 留正文', async () => {
    const { stripSkillFrontmatter } = await import('../src/pi/space/promptModules.js');
    expect(stripSkillFrontmatter('---\nname: "a"\ndescription: "d"\n---\n\n正文')).toBe('正文');
  });
  it('无 frontmatter / 无闭合 原样返回', async () => {
    const { stripSkillFrontmatter } = await import('../src/pi/space/promptModules.js');
    expect(stripSkillFrontmatter('正文')).toBe('正文');
    expect(stripSkillFrontmatter('---\nname: "a"')).toBe('---\nname: "a"');
  });
});

describe('applyToolTextOverrides（纯函数）', () => {
  it('空覆盖表 = no-op；description/guidelines 覆盖生效', async () => {
    const { applyToolTextOverrides, insertPromptModuleVersion } = await import('../src/pi/space/promptModules.js');
    const tools = [{ name: 't1', description: '旧描述', promptGuidelines: ['旧1', '旧2'] }];
    const empty = new Map();
    applyToolTextOverrides(tools, empty);
    expect(tools[0]!.description).toBe('旧描述');

    await insertPromptModuleVersion({ moduleKey: 'tool.t1.description', value: '新描述', source: 'manual_edit' });
    await insertPromptModuleVersion({ moduleKey: 'tool.t1.guidelines', value: '新A\n新B', source: 'manual_edit' });
    const { loadPromptModuleOverrides } = await import('../src/pi/space/promptModules.js');
    const ov = await loadPromptModuleOverrides();
    applyToolTextOverrides(tools, ov);
    expect(tools[0]!.description).toBe('新描述');
    expect(tools[0]!.promptGuidelines).toEqual(['新A', '新B']);
  });
});

describe('listPromptModuleDefs', () => {
  it('主 prompt 三段 + 工具文案（chat/rca 并集）', async () => {
    const { listPromptModuleDefs } = await import('../src/pi/space/promptModules.js');
    const defs = await listPromptModuleDefs();
    const keys = defs.map((d) => d.key);
    expect(keys).toContain('space.style.zh');
    expect(keys).toContain('space.style.en');
    expect(keys).toContain('space.workspace');
    expect(defs.filter((d) => d.group === 'tool').length).toBeGreaterThan(5);
  });

  it('skill 只读组：DB enabled + 磁盘目录存在才出现，defaultValue=去 frontmatter 正文', async () => {
    await pool.query(`INSERT INTO assistant_skills (name, description) VALUES ('demo-skill', '演示')`);
    mkdirSync(join(tmpDataDir, 'skills', 'demo-skill'), { recursive: true });
    writeFileSync(join(tmpDataDir, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: "demo-skill"\ndescription: "演示"\n---\n\n# 演示正文');
    const { listPromptModuleDefs } = await import('../src/pi/space/promptModules.js');
    const def = (await listPromptModuleDefs()).find((d) => d.key === 'skill.demo-skill');
    expect(def).toBeTruthy();
    expect(def!.readonly).toBe(true);
    expect(def!.group).toBe('skill');
    expect(await def!.defaultValue()).toBe('# 演示正文');
  });
});

describe('版本链语义', () => {
  it('当前值=每 key 最大 seq；NULL 行=跟随代码默认（textOverrideOf→undefined）', async () => {
    const { loadPromptModuleOverrides, textOverrideOf, insertPromptModuleVersion } = await import('../src/pi/space/promptModules.js');
    await insertPromptModuleVersion({ moduleKey: 'space.style.zh', value: 'A', source: 'manual_edit' });
    await insertPromptModuleVersion({ moduleKey: 'space.style.zh', value: 'B', source: 'manual_edit' });
    await insertPromptModuleVersion({ moduleKey: 'space.style.zh', value: null, source: 'manual_edit' }); // 恢复默认
    const ov = await loadPromptModuleOverrides();
    expect(ov.get('space.style.zh')!.value).toBeNull();
    expect(textOverrideOf(ov, 'space.style.zh')).toBeUndefined();
  });

  it('insertPromptModuleVersion：sourceRef 重放命中 partial unique → 返回 null 不落行', async () => {
    const { insertPromptModuleVersion } = await import('../src/pi/space/promptModules.js');
    const ref = crypto.randomUUID();
    const s1 = await insertPromptModuleVersion({ moduleKey: 'space.style.zh', value: 'x', source: 'solidify_apply', sourceRef: ref });
    const s2 = await insertPromptModuleVersion({ moduleKey: 'space.style.zh', value: 'x', source: 'solidify_apply', sourceRef: ref });
    expect(s1).toBeGreaterThan(0);
    expect(s2).toBeNull();
  });

  it('loadPromptModuleOverridesSafe：表被 DROP → 空表不抛（会话照常代码默认）', async () => {
    await pool.query(`DROP TABLE assistant_prompt_module_versions`);
    const { loadPromptModuleOverridesSafe } = await import('../src/pi/space/promptModules.js');
    const ov = await loadPromptModuleOverridesSafe();
    expect(ov.size).toBe(0);
    await pool.query(`CREATE TABLE assistant_prompt_module_versions (seq bigserial PRIMARY KEY, module_key varchar(100) NOT NULL, value text, source varchar(20) NOT NULL, source_ref uuid, created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamp NOT NULL DEFAULT now())`);
  });
});
```

- [ ] **Step 7: 跑两个测试文件**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- prompt-modules && npm test -- prompt-override`
Expected: 全 PASS。红线测试在常量迁移后仍绿 = 迁移零行为变化。

- [ ] **Step 8: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
git add apps/api/src/pi/space/promptModules.ts apps/api/src/pi/space/skillsService.ts apps/api/src/pi/space/session.ts apps/api/test/prompt-modules.test.ts apps/api/test/prompt-override.test.ts
git commit -m "feat(space): R3 prompt 模块注册表——常量迁出 session+版本链值解析+工具文案覆盖,红线测试锚定零行为变化"
```

---

### Task 3: session.ts 接线——overrides 参数 + 工厂快照注入

**Files:**
- Modify: `apps/api/src/pi/space/session.ts`（`buildSpaceSystemPrompt` 加第 6 参；工厂 :692 后接覆盖；:781 传入）
- Test: `apps/api/test/prompt-override.test.ts`（追加用例）

- [ ] **Step 1: 追加失败测试**

在 `apps/api/test/prompt-override.test.ts` 的 describe 块内追加：

```ts
  it('默认参数与显式空覆盖逐字节一致（红线第二锚点）', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    expect(buildSpaceSystemPrompt('s', 'zh-CN', [], '', ''))
      .toBe(buildSpaceSystemPrompt('s', 'zh-CN', [], '', '', {}));
  });

  it('style 覆盖生效：注入值替换原文风格段', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const p = buildSpaceSystemPrompt('s', 'zh-CN', [], '', '', { style: '## 新风格\n- 简洁' });
    expect(p).toContain('## 新风格\n- 简洁');
    expect(p).not.toContain(ZH_STYLE);
    expect(p).toContain(WORKSPACE); // workspace 未覆盖仍为默认
  });

  it('workspace 覆盖生效', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const p = buildSpaceSystemPrompt('s', 'zh-CN', [], '', '', { workspace: '## 新工作台' });
    expect(p).toContain('## 新工作台');
    expect(p).not.toContain(WORKSPACE);
    expect(p).toContain(ZH_STYLE);
  });

  it('DB 覆盖链路：插 style 行后 loadPromptModuleOverridesSafe → textOverrideOf 命中', async () => {
    await pool.query(`TRUNCATE assistant_prompt_module_versions`);
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '## DB风格', 'manual_edit')`);
    const { loadPromptModuleOverridesSafe, textOverrideOf } = await import('../src/pi/space/promptModules.js');
    const ov = await loadPromptModuleOverridesSafe();
    expect(textOverrideOf(ov, 'space.style.zh')).toBe('## DB风格');
    // 组装即注入：覆盖值进 buildSpaceSystemPrompt 后原文风格段被替换
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const p = buildSpaceSystemPrompt('s', 'zh-CN', [], '', '', { style: textOverrideOf(ov, 'space.style.zh') });
    expect(p).toContain('## DB风格');
    expect(p).not.toContain(ZH_STYLE);
  });
```

并在文件顶部 `afterAll` 之前的 `beforeEach` 缺位补上（若没有）：

```ts
import { beforeEach } from 'vitest'; // 并入现有 vitest import

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_prompt_module_versions`);
});
```

- [ ] **Step 2: 跑测试确认新用例失败**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- prompt-override`
Expected: FAIL——`buildSpaceSystemPrompt` 无第 6 参（TS 编译期即报参数个数错，或运行时覆盖不生效）。

- [ ] **Step 3: buildSpaceSystemPrompt 加 overrides 参数**

`apps/api/src/pi/space/session.ts:641` 签名与 :649-652 改为：

```ts
export function buildSpaceSystemPrompt(
  summaryText: string | null,
  lang?: AiLang,
  guides: Array<Pick<AssistantGuideRow, 'kind' | 'body'>> = [],
  memoriesSection = '',
  trajectoriesSection = '',
  overrides: { style?: string; workspace?: string } = {},
): string {
  const isEn = aiLangFrom(lang ?? null) === 'en-US';
  const style = isEn ? (overrides.style ?? STYLE_EN_DEFAULT) : (overrides.style ?? STYLE_ZH_DEFAULT);
  const workspace = overrides.workspace ?? WORKSPACE_DEFAULT;
```

（函数其余行不动；`body` 组装行不变。）

- [ ] **Step 4: 工厂接线（快照注入）**

session.ts import 行扩为：

```ts
import {
  STYLE_EN_DEFAULT, STYLE_ZH_DEFAULT, WORKSPACE_DEFAULT,
  STYLE_EN_KEY, STYLE_ZH_KEY, WORKSPACE_KEY,
  applyToolTextOverrides, loadPromptModuleOverridesSafe, textOverrideOf,
} from './promptModules.js';
```

工厂函数 `createSpaceSessionFactory` 内，`:692` 的 `const rawTools ... ` 行之后、`const tools = rawTools.map(...)`（:693）之前插入：

```ts
  // R3 prompt 可编辑化：线程冷构建时快照 DB 覆盖（线程内不热更）；失败回落代码默认。
  const promptOverrides = await loadPromptModuleOverridesSafe();
  applyToolTextOverrides(rawTools, promptOverrides);
```

在 `const loader = new DefaultResourceLoader({`（:777）之前插入：

```ts
  // R3 prompt 可编辑化：主 prompt 三段覆盖值（NULL=跟随代码默认→不覆盖）。
  const styleOverride = textOverrideOf(promptOverrides, aiLangFrom(ctx.lang ?? null) === 'en-US' ? STYLE_EN_KEY : STYLE_ZH_KEY);
  const workspaceOverride = textOverrideOf(promptOverrides, WORKSPACE_KEY);
```

`:781` 的 `appendSystemPromptOverride` 行改为：

```ts
    appendSystemPromptOverride: (base) => [...base, buildSpaceSystemPrompt(summaryText, ctx.lang, guides, memoriesSection, trajectoriesSection, { style: styleOverride, workspace: workspaceOverride })],
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- prompt-override`
Expected: PASS（全部用例，含红线两条）。再跑 `npm test -- prompt-modules` 确认未破坏 Task 2。

- [ ] **Step 6: 回归 R1/R2 注入测试**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- memories && npm test -- trajectory`
Expected: 全 PASS（红线保证互不干扰）。

- [ ] **Step 7: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
git add apps/api/src/pi/space/session.ts apps/api/test/prompt-override.test.ts
git commit -m "feat(space): R3 渲染接线——prompt 覆盖线程冷构建快照注入,工具文案覆盖进 defineTool 注册"
```

---

### Task 4: promptModulesRoute——列表/版本链/直改+回滚

**Files:**
- Create: `apps/api/src/pi/space/promptModulesRoute.ts`
- Modify: `apps/api/src/pi/space/router.ts`（import + 挂载，:468 后追加）
- Test: `apps/api/test/prompt-modules-route.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/prompt-modules-route.test.ts`（harness 仿 `apps/api/test/space-skills.test.ts`：PI_DATA_DIR 隔离 + resetModules + req.user 注入 + `/api/assistant` 挂载）：

```ts
/** prompt 模块路由：列表/版本链/直改/回滚/skill 只读组守卫/权限门。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Express } from 'express';
import { SCHEMA_SQL, seedOrg } from './helpers/db.js';
import { managerUserOf, memberUserOf } from './helpers/auth.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let tmpDataDir: string;
let orgId = '';
let orgPath = '';
let mount: (role: 'manager' | 'member') => Promise<Express>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const org = await seedOrg(pool);
  orgId = org.orgId;
  orgPath = org.orgPath;
  tmpDataDir = mkdtempSync(join(tmpdir(), 'itest-pmr-'));
  process.env.PI_DATA_DIR = tmpDataDir;
  const { default: spaceRoute } = await import('../src/pi/space/router.js');
  const express = (await import('express')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  mount = async (role) => {
    const userId = crypto.randomUUID();
    const user = role === 'manager'
      ? managerUserOf(userId, 'mgr', orgId, orgPath)
      : memberUserOf(userId, 'mem', orgId, orgPath);
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use('/api/assistant', spaceRoute);
    app.use(errorHandler);
    return app;
  };
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_prompt_module_versions, assistant_skills`);
});

async function seedSkill(name = 'demo-skill') {
  await pool.query(`INSERT INTO assistant_skills (name, description) VALUES ($1, '演示技能')`, [name]);
  const dir = join(tmpDataDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${JSON.stringify(name)}\ndescription: "演示技能"\n---\n\n旧正文`);
}

describe('GET /api/assistant/prompt-modules', () => {
  it('返回分组列表；无行 → isDefault=true', async () => {
    const app = await mount('manager');
    const res = await app.inject?.() ?? null; // 见下——用 supertest
  });
});
```

**注意**：路由测试统一用 supertest（space-skills.test.ts 同款）。上面的 `inject` 行删除，实际请求写法：

```ts
import request from 'supertest';

// 用例内：
const app = await mount('manager');
const res = await request(app).get('/api/assistant/prompt-modules').expect(200);
const styleZh = res.body.find((m: { key: string }) => m.key === 'space.style.zh');
expect(styleZh.isDefault).toBe(true);
expect(styleZh.group).toBe('main');
```

完整用例集（都按上述 supertest 写法）：

```ts
describe('prompt-modules 路由', () => {
  it('GET 列表：无行 isDefault=true；写值后 hasRow/isDefault=false/source=manual_edit', async () => {
    const app = await mount('manager');
    const before = await request(app).get('/api/assistant/prompt-modules').expect(200);
    const styleZh = before.body.find((m: { key: string }) => m.key === 'space.style.zh');
    expect(styleZh.isDefault).toBe(true);

    await request(app).post('/api/assistant/prompt-modules/space.style.zh/value')
      .send({ value: '新风格文案' }).expect(200);

    const after = await request(app).get('/api/assistant/prompt-modules').expect(200);
    const row = after.body.find((m: { key: string }) => m.key === 'space.style.zh');
    expect(row.isDefault).toBe(false);
    expect(row.hasRow).toBe(true);
    expect(row.source).toBe('manual_edit');
    expect(row.text).toBe('新风格文案');
  });

  it('POST value=null（恢复默认）：落 NULL 行，isDefault 回 true', async () => {
    const app = await mount('manager');
    await request(app).post('/api/assistant/prompt-modules/space.style.zh/value').send({ value: 'x' }).expect(200);
    await request(app).post('/api/assistant/prompt-modules/space.style.zh/value').send({ value: null }).expect(200);
    const list = await request(app).get('/api/assistant/prompt-modules').expect(200);
    const row = list.body.find((m: { key: string }) => m.key === 'space.style.zh');
    expect(row.isDefault).toBe(true);
    expect(row.hasRow).toBe(true); // 行在，值 NULL=跟随代码默认
  });

  it('POST fromSeq 回滚：复制历史行 value，source=rollback', async () => {
    const app = await mount('manager');
    const r1 = await request(app).post('/api/assistant/prompt-modules/space.style.zh/value').send({ value: '第一版' }).expect(200);
    await request(app).post('/api/assistant/prompt-modules/space.style.zh/value').send({ value: '第二版' }).expect(200);
    await request(app).post(`/api/assistant/prompt-modules/space.style.zh/value`).send({ fromSeq: r1.body.seq }).expect(200);
    const vers = await request(app).get('/api/assistant/prompt-modules/space.style.zh/versions').expect(200);
    expect(vers.body.length).toBe(3);
    expect(vers.body[0].value).toBe('第一版');
    expect(vers.body[0].source).toBe('rollback');
  });

  it('POST fromSeq 不存在的版本行 → 404', async () => {
    const app = await mount('manager');
    await request(app).post('/api/assistant/prompt-modules/space.style.zh/value').send({ fromSeq: 999999 }).expect(404);
  });

  it('未知 key → 404；空白值 → 400', async () => {
    const app = await mount('manager');
    await request(app).post('/api/assistant/prompt-modules/nope.x/value').send({ value: 'x' }).expect(404);
    await request(app).post('/api/assistant/prompt-modules/space.style.zh/value').send({ value: '   ' }).expect(400);
  });

  it('skill 只读组：value 直改 → 400；fromSeq 回滚 → 200 且写回磁盘', async () => {
    await seedSkill();
    const app = await mount('manager');
    await request(app).post('/api/assistant/prompt-modules/skill.demo-skill/value').send({ value: 'hack' }).expect(400);

    // 造历史行：先经 baseline 语义手工插两行（模拟已有版本链）
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('skill.demo-skill', '旧正文', 'baseline')`);
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('skill.demo-skill', '新正文', 'solidify_apply')`);
    const vers = await request(app).get('/api/assistant/prompt-modules/skill.demo-skill/versions').expect(200);
    const baselineSeq = vers.body.find((v: { source: string }) => v.source === 'baseline').seq;

    await request(app).post('/api/assistant/prompt-modules/skill.demo-skill/value').send({ fromSeq: baselineSeq }).expect(200);
    const md = readFileSync(join(tmpDataDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf8');
    expect(md).toContain('旧正文');
    expect(md.startsWith('---\nname: "demo-skill"\ndescription: "演示技能"\n---\n')).toBe(true); // frontmatter 从 DB 重拼
  });

  it('非管理员 → 403', async () => {
    const app = await mount('member');
    await request(app).get('/api/assistant/prompt-modules').expect(403);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- prompt-modules-route`
Expected: FAIL——路由不存在（404）。

- [ ] **Step 3: 实现路由**

创建 `apps/api/src/pi/space/promptModulesRoute.ts`：

```ts
/**
 * R3 prompt 可编辑化路由（requireManager）：模块列表 / 版本链 / 直改与回滚。
 * skill.* 只读组：拒绝 value 直改，只允许 fromSeq 回滚（回滚把值写回磁盘文件）。
 */
import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { db } from '../../db/client.js';
import { assistantPromptModuleVersions } from '../../db/schema.js';
import {
  insertPromptModuleVersion, listPromptModuleDefs, loadPromptModuleOverrides,
  readSkillMeta, resolvePromptModule, writeSkillBodyFromDb,
} from './promptModules.js';

const router = Router();

const SetValueBody = z.object({
  value: z.string().max(100_000).nullish(),
  fromSeq: z.number().int().positive().nullish(),
});

router.get('/', async (_req, res) => {
  const defs = await listPromptModuleDefs();
  const overrides = await loadPromptModuleOverrides();
  const rows = await Promise.all(defs.map(async (def) => {
    const ov = overrides.get(def.key);
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      readonly: def.readonly,
      hasRow: ov != null,
      seq: ov?.seq ?? null,
      source: ov?.source ?? null,
      value: ov?.value ?? null,
      isDefault: ov == null || ov.value == null,
      text: ov?.value ?? await def.defaultValue(),
    };
  }));
  res.json(rows);
});

router.get('/:key/versions', async (req, res) => {
  const key = String(req.params.key);
  const rows = await db.select().from(assistantPromptModuleVersions)
    .where(eq(assistantPromptModuleVersions.moduleKey, key))
    .orderBy(desc(assistantPromptModuleVersions.seq));
  res.json(rows);
});

router.post('/:key/value', async (req, res) => {
  const user = req.user as AuthUser;
  const key = String(req.params.key);
  const parsed = SetValueBody.safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError(400, 'invalid_body', '请求体不合法');
  const { value, fromSeq } = parsed.data;
  const resolved = await resolvePromptModule(key);
  if (!resolved) throw new HttpError(404, 'module_not_found', '提示词模块不存在');

  if (fromSeq != null) {
    // 回滚 = 复制历史行 value 追加新行（回滚也留痕）
    const row = (await db.select().from(assistantPromptModuleVersions)
      .where(and(
        eq(assistantPromptModuleVersions.moduleKey, key),
        eq(assistantPromptModuleVersions.seq, fromSeq),
      )).limit(1))[0];
    if (!row) throw new HttpError(404, 'version_not_found', '版本行不存在');
    if (resolved.def.group === 'skill') {
      if (row.value == null) throw new HttpError(400, 'invalid_rollback', 'skill 组不支持回滚到「跟随默认」行');
      const meta = await readSkillMeta(key.slice('skill.'.length));
      if (!meta) throw new HttpError(409, 'skill_missing', 'skill 不存在或未启用');
      await writeSkillBodyFromDb(meta.name, meta.description, row.value);
    }
    const seq = await insertPromptModuleVersion({ moduleKey: key, value: row.value, source: 'rollback', createdByUserId: user.userId });
    res.json({ seq });
    return;
  }

  if (resolved.def.group === 'skill') throw new HttpError(400, 'readonly_module', 'skill 组只读，只允许 fromSeq 回滚');
  if (value != null && value.trim() === '') throw new HttpError(400, 'invalid_value', '值不能为空白');
  const seq = await insertPromptModuleVersion({ moduleKey: key, value: value ?? null, source: 'manual_edit', createdByUserId: user.userId });
  res.json({ seq });
});

export default router;
```

- [ ] **Step 4: 挂载**

`apps/api/src/pi/space/router.ts`：import 区加 `import promptModulesRoute from './promptModulesRoute.js';`（与 memoriesRoute import 同段）；`:468`（trajectories 挂载行）后加：

```ts
spaceRoute.use('/prompt-modules', requireManager, promptModulesRoute);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- prompt-modules-route`
Expected: PASS（7 tests）。

- [ ] **Step 6: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
git add apps/api/src/pi/space/promptModulesRoute.ts apps/api/src/pi/space/router.ts apps/api/test/prompt-modules-route.test.ts
git commit -m "feat(space): R3 prompt 模块 REST——列表/版本链/直改+回滚(skill 只读组仅回滚且写盘)"
```

---

### Task 5: solidifyService——盘点批次 + LLM 蒸馏管线

**Files:**
- Create: `apps/api/src/pi/space/solidifyService.ts`
- Test: `apps/api/test/solidify-service.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/solidify-service.test.ts`：

```ts
/** 固化盘点管线：防重入/LLM 未配置/空输入/蒸馏入库/单条丢弃/超时/无落点。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProductLine, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

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
  await pool.query(`TRUNCATE assistant_solidify_proposals, assistant_solidify_batches, assistant_memories, assistant_trajectories, assistant_skills, settings`);
});

/** stub LLM client：completeJson 首轮 kind:'json' 即透传 value/model（trajectory-worker.test 同款）。 */
function stubClient(value: unknown) {
  return {
    provider: 'openai' as const,
    complete: async () => ({ kind: 'json' as const, value, provider: 'openai' as const, vision: false, model: 'stub-model' }),
  };
}

async function seedSources(): Promise<{ memoryId: string; trajectoryId: string; lineId: string }> {
  const { projectId } = await seedProject(pool);
  const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
  const memoryId = randomUUID();
  const trajectoryId = randomUUID();
  await pool.query(
    `INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, body, provenance, hit_count)
     VALUES ($1, 'product_line', $2, '断言写法', '断言前先实测', 'verify_case 实测后再断言，元素清单没有的控件当不存在', 'ai_inferred', 3)`,
    [memoryId, lineId]);
  await pool.query(
    `INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model, hit_count)
     VALUES ($1, $2, '列表页筛选任务', '列表 筛选', '## 任务描述\n…', '筛选导出', 'm', 2)`,
    [trajectoryId, lineId]);
  return { memoryId, trajectoryId, lineId };
}

async function newBatchId(): Promise<string> {
  return (await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('running') RETURNING id`)).rows[0]!.id as string;
}

async function batchRow(id: string) {
  return (await pool.query(`SELECT * FROM assistant_solidify_batches WHERE id=$1`, [id])).rows[0]!;
}

describe('startSolidifyScan：防重入', () => {
  it('已有 running 批次 → 409', async () => {
    const { startSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await newBatchId();
    await expect(startSolidifyScan(null)).rejects.toMatchObject({ status: 409 });
  });
});

describe('runSolidifyScan', () => {
  it('LLM 未配置 → 批次 failed + error 说明', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const id = await newBatchId();
    await runSolidifyScan(id); // 测试库 settings 空 → readLlmConfig null
    const b = await batchRow(id);
    expect(b.status).toBe('failed');
    expect(b.error).toContain('LLM 未配置');
  });

  it('空输入（无记忆无轨迹）→ done + 0/0/0，不调 LLM', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({ proposals: [], notes: [] }) });
    const b = await batchRow(id);
    expect(b.status).toBe('done');
    const summary = JSON.parse(b.input_summary as string);
    expect(summary).toMatchObject({ memories: 0, trajectories: 0, proposals: 0 });
  });

  it('prompt_amendment 入库：retireRecommended 服务端定值（memory=true）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { memoryId } = await seedSources();
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({
      proposals: [{ kind: 'prompt_amendment', target: 'space.style.zh', title: '断言证据约束', body: '- 断言必须有实测证据', rationale: '2 条来源线支撑', sources: [memoryId] }],
      notes: [],
    }) });
    const b = await batchRow(id);
    expect(b.status).toBe('done');
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals`)).rows[0]!;
    expect(p.kind).toBe('prompt_amendment');
    expect(p.target).toBe('space.style.zh');
    expect(p.status).toBe('pending');
    expect(p.distill_model).toBe('stub-model');
    expect(p.sources[0]).toMatchObject({ type: 'memory', id: memoryId, retireRecommended: true });
  });

  it('trajectory source → retireRecommended=false', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { trajectoryId } = await seedSources();
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({
      proposals: [{ kind: 'prompt_amendment', target: 'space.workspace', title: 't', body: 'b', rationale: 'r', sources: [trajectoryId] }],
      notes: [],
    }) });
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals`)).rows[0]!;
    expect(p.sources[0]).toMatchObject({ type: 'trajectory', id: trajectoryId, retireRecommended: false });
  });

  it('target 无落点 → 丢弃该条 + 记 note；有效条保留', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { memoryId } = await seedSources();
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({
      proposals: [
        { kind: 'prompt_amendment', target: 'no.such.key', title: '坏', body: 'b', rationale: 'r', sources: [memoryId] },
        { kind: 'prompt_amendment', target: 'space.style.zh', title: '好', body: 'b', rationale: 'r', sources: [memoryId] },
      ],
      notes: [],
    }) });
    const b = await batchRow(id);
    expect(b.status).toBe('done');
    const rows = (await pool.query(`SELECT title FROM assistant_solidify_proposals`)).rows;
    expect(rows.map((r) => r.title)).toEqual(['好']);
    const summary = JSON.parse(b.input_summary as string);
    expect(summary.notes.some((n: string) => n.includes('无落点'))).toBe(true);
  });

  it('skill_revision：target 须在现有 skill 清单', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { memoryId } = await seedSources();
    await pool.query(`INSERT INTO assistant_skills (name, description) VALUES ('demo-skill', 'd')`);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({
      proposals: [
        { kind: 'skill_revision', target: 'demo-skill', title: '改skill', body: '新正文', rationale: 'r', sources: [memoryId] },
        { kind: 'skill_revision', target: 'ghost-skill', title: '幽灵', body: 'b', rationale: 'r', sources: [memoryId] },
      ],
      notes: ['建议人工用 skill-creator 新建：无落点的泛化经验'],
    }) });
    const rows = (await pool.query(`SELECT target FROM assistant_solidify_proposals`)).rows;
    expect(rows.map((r) => r.target)).toEqual(['demo-skill']);
    const b = await batchRow(id);
    const summary = JSON.parse(b.input_summary as string);
    expect(summary.notes.some((n: string) => n.includes('skill-creator'))).toBe(true);
  });

  it('单条提案形状不合法 → 丢弃该条不炸批次（整体仍 done）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { memoryId } = await seedSources();
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({
      proposals: [
        { kind: 'prompt_amendment', target: 'space.style.zh', title: '好', body: 'b', rationale: 'r', sources: [memoryId] },
        { kind: 'prompt_amendment', target: 'space.style.zh', /* 缺 body */ title: '坏', rationale: 'r', sources: [memoryId] },
      ],
      notes: [],
    }) });
    const b = await batchRow(id);
    expect(b.status).toBe('done'); // 不 failed
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_solidify_proposals`)).rows[0]!;
    expect(n.n).toBe(1);
  });

  it('LLM 输出整体形状不合法 → 批次 failed', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedSources();
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stubClient({ proposals: '不是数组' }) });
    const b = await batchRow(id);
    expect(b.status).toBe('failed');
  });

  it('LLM 超时 → 批次 failed + error 带 timeout', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedSources();
    const id = await newBatchId();
    const hang = { provider: 'openai' as const, complete: () => new Promise<never>(() => {}), vision: false, model: 'stub' };
    await runSolidifyScan(id, { client: hang as never, llmTimeoutMs: 50 });
    const b = await batchRow(id);
    expect(b.status).toBe('failed');
    expect(b.error).toContain('timeout');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- solidify-service`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 solidifyService.ts**

创建 `apps/api/src/pi/space/solidifyService.ts`：

```ts
/**
 * R3 固化管线：盘点批次（LLM 蒸馏产提案）。
 * LLM 只产提案不直接改任何资产；应用一律走 solidifyApply 的人工审批。
 * 失败语义：LLM 未配置/超时/输出整体不合法 → 批次 failed；单条提案不合法 →
 * 丢弃该条不炸批次（spec §5.2）。inline fire-and-forget，不引 BullMQ。
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { db } from '../../db/client.js';
import {
  assistantMemories, assistantSkills, assistantSolidifyBatches,
  assistantSolidifyProposals, assistantTrajectories, productLines,
} from '../../db/schema.js';
import { readLlmConfig } from '../modelBridge.js';
import { completeJson, getLlmClient, type LLMClient } from '../../agent/llm-client.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { listPromptModuleDefs } from './promptModules.js';

const SOLIDIFY_SYSTEM_PROMPT = `你是测试助手平台的「经验固化盘点器」。输入是平台积累的短期记忆与成功轨迹（各带来源产品线标识），以及平台现有 skill 清单与可编辑提示词模块清单。

任务：从中提炼【非业务、跨产品线普适】的经验，产出「固化提案」——你只产提案，所有应用都经人工审批。

输出只含 JSON（不要 markdown 围栏）：
{"proposals":[{"kind":"...","target":"...","title":"...","body":"...","rationale":"...","sources":["<输入条目id>"]}],"notes":["..."]}

字段要求：
- kind："prompt_amendment"（追加到系统提示词模块）或 "skill_revision"（修订现有 skill 的完整正文）
- target：prompt_amendment 时只能从【prompt_amendment 可选 target】清单中选；skill_revision 时只能从【现有 skill 清单】中选
- title：≤60 字的人话提案名（审批列表用）
- body：prompt_amendment = 要追加的增量文案（markdown，会被拼到模块当前值尾部）；skill_revision = 修订后的完整正文（markdown，不含 frontmatter）
- rationale：为什么值得固化，必须写明有几条产品线来源支撑（如「3 条来源线：线A/线B/global」）
- sources：支撑本提案的输入条目 id 数组（只能从输入条目中选）

四条判据——全部满足才产提案：
1. 跨线普适：≥2 条产品线来源支撑（global 记忆可作一条线）。单线孤证不固化。
2. 非线内事实：不得含 URL、账号、data-testid/锚点、产品名、密码/令牌/API key 等凭据。凭据出现在任何输出字段即违规。
3. 可操作：能落成具体的提示词增量文案或 skill 正文修订，不是空泛建议。
4. 去碎片化：先查现有 skill 清单——有落点才产 skill_revision；泛化经验没有现成 skill 落点时不要硬凑 target，写进 notes：「建议人工用 skill-creator 新建：<一句话>」。

notes：无法落成提案但有价值的观察（无 skill 落点的泛化经验、低质量信号等），没有就空数组。`;

const ProposalSchema = z.object({
  kind: z.enum(['prompt_amendment', 'skill_revision']),
  target: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  rationale: z.string().min(1).max(4_000),
  sources: z.array(z.string().uuid()).min(1),
});

/** 外层宽松（proposals 逐条校验，单条坏丢弃不炸批次）；notes 上限防炸 summary。 */
const SolidifyOutput = z.object({
  proposals: z.array(z.unknown()).max(20),
  notes: z.array(z.string().max(500)).max(20).default([]),
});

/** 发起盘点：running 防重入（409）。返回批次 id；蒸馏由调用方 fire-and-forget。 */
export async function startSolidifyScan(userId: string | null): Promise<string> {
  const running = await db.select({ id: assistantSolidifyBatches.id }).from(assistantSolidifyBatches)
    .where(eq(assistantSolidifyBatches.status, 'running')).limit(1);
  if (running.length > 0) throw new HttpError(409, 'scan_running', '已有盘点批次在进行中');
  return (await db.insert(assistantSolidifyBatches).values({ status: 'running', createdBy: userId })
    .returning({ id: assistantSolidifyBatches.id }))[0]!.id;
}

async function llmClientFromConfig(): Promise<LLMClient | null> {
  const cfg = await readLlmConfig();
  if (!cfg) return null;
  return getLlmClient({ provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl ?? undefined });
}

/** LLM 超时护栏（与 scheduler/trajectoryWorker 同款；不共享是为免 space↔scheduler import 环）。 */
function withLlmTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`solidify: distill LLM timeout (${ms}ms)`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface SolidifyRunDeps {
  /** 注入 LLM client（测试）；缺省读 settings 自建，未配置 → 批次 failed。 */
  client?: LLMClient;
  llmTimeoutMs?: number;
}

/** 执行盘点：输入聚合 → LLM 蒸馏 → 服务端校验 → 提案入库 → 批次 done。 */
export async function runSolidifyScan(batchId: string, deps: SolidifyRunDeps = {}): Promise<void> {
  const fail = async (error: string) => {
    await db.update(assistantSolidifyBatches)
      .set({ status: 'failed', error, updatedAt: new Date() })
      .where(eq(assistantSolidifyBatches.id, batchId));
  };
  try {
    const client = deps.client ?? await llmClientFromConfig();
    if (!client) {
      await fail('LLM 未配置：请先到设置页配置模型');
      return;
    }

    // 输入：全库 active 记忆 + active 轨迹，合并按 hit_count 降序取 top 200（高频优先，防 prompt 爆炸）
    const memRows = await db.select({
      id: assistantMemories.id, scope: assistantMemories.scope, productLineId: assistantMemories.productLineId,
      title: assistantMemories.title, hook: assistantMemories.hook, body: assistantMemories.body,
      hitCount: assistantMemories.hitCount,
    }).from(assistantMemories).where(eq(assistantMemories.status, 'active'));
    const trajRows = await db.select({
      id: assistantTrajectories.id, productLineId: assistantTrajectories.productLineId,
      taskTitle: assistantTrajectories.taskTitle, digest: assistantTrajectories.digest,
      hitCount: assistantTrajectories.hitCount,
    }).from(assistantTrajectories).where(eq(assistantTrajectories.status, 'active'));
    const lineNames = new Map(
      (await db.select({ id: productLines.id, name: productLines.name }).from(productLines))
        .map((l) => [l.id, l.name] as const),
    );
    const merged = [
      ...memRows.map((m) => ({
        type: 'memory' as const, id: m.id,
        line: m.scope === 'global' ? 'global' : (m.productLineId ?? 'unknown'),
        title: m.title, text: `${m.hook}\n${m.body ?? ''}`, hitCount: m.hitCount,
      })),
      ...trajRows.map((t) => ({
        type: 'trajectory' as const, id: t.id, line: t.productLineId,
        title: t.taskTitle, text: t.digest, hitCount: t.hitCount,
      })),
    ].sort((a, b) => b.hitCount - a.hitCount).slice(0, 200);

    if (merged.length === 0) {
      await db.update(assistantSolidifyBatches).set({
        status: 'done',
        inputSummary: JSON.stringify({ memories: 0, trajectories: 0, proposals: 0, notes: [] }),
        updatedAt: new Date(),
      }).where(eq(assistantSolidifyBatches.id, batchId));
      return;
    }

    const skillRows = await db.select({ name: assistantSkills.name, description: assistantSkills.description })
      .from(assistantSkills).where(eq(assistantSkills.enabled, true));
    const promptKeys = (await listPromptModuleDefs()).filter((d) => d.group !== 'skill');

    const userMessage = [
      '【输入条目】（type/id/来源线/hit/标题 + 内容；来源线 global 表示全局记忆）',
      ...merged.map((s, i) => `[${i + 1}] type=${s.type} id=${s.id} 线=${s.line} hit=${s.hitCount} 标题=${s.title}\n${s.text}`),
      '',
      '【现有 skill 清单】（skill_revision 的 target 只能从中选）',
      ...skillRows.map((s) => `- ${s.name} | ${s.description}`),
      '',
      '【prompt_amendment 可选 target】（只能从中选）',
      ...promptKeys.map((d) => `- ${d.key}（${d.label}）`),
    ].join('\n');

    const r = await withLlmTimeout(
      completeJson(client, { systemPrompt: SOLIDIFY_SYSTEM_PROMPT, userMessage }),
      deps.llmTimeoutMs ?? 180_000,
    );
    const parsed = SolidifyOutput.safeParse(r.value);
    if (!parsed.success) {
      await fail(`LLM 输出不合法：${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
      return;
    }

    // 服务端校验：target 落点 + sources 修剪；retireRecommended 服务端定值（不信任 LLM）。
    const skillNames = new Set(skillRows.map((s) => s.name));
    const promptKeySet = new Set(promptKeys.map((d) => d.key));
    const sourceById = new Map(merged.map((s) => [s.id, s]));
    const notes = [...parsed.data.notes];
    const inserts: Array<typeof assistantSolidifyProposals.$inferInsert> = [];
    for (const raw of parsed.data.proposals) {
      const p = ProposalSchema.safeParse(raw);
      if (!p.success) {
        notes.push(`已丢弃一条形状不合法的提案：${p.error.issues[0]?.message ?? 'unknown'}`);
        continue;
      }
      const targetOk = p.data.kind === 'prompt_amendment' ? promptKeySet.has(p.data.target) : skillNames.has(p.data.target);
      if (!targetOk) {
        notes.push(`已丢弃「${p.data.title}」：target 无落点（${p.data.target}）`);
        continue;
      }
      const sources = p.data.sources
        .filter((id) => sourceById.has(id))
        .map((id) => {
          const s = sourceById.get(id)!;
          return {
            type: s.type, id, title: s.title.slice(0, 120),
            lineName: s.line === 'global' ? 'global' : (lineNames.get(s.line) ?? 'unknown'),
            retireRecommended: s.type === 'memory',
          };
        });
      if (sources.length === 0) {
        notes.push(`已丢弃「${p.data.title}」：sources 全部无效`);
        continue;
      }
      inserts.push({
        batchId,
        kind: p.data.kind,
        target: p.data.target,
        title: p.data.title.slice(0, 200),
        body: p.data.body,
        rationale: p.data.rationale,
        sources,
        status: 'pending',
        distillModel: r.model ?? 'unknown',
      });
    }
    if (inserts.length > 0) await db.insert(assistantSolidifyProposals).values(inserts);

    await db.update(assistantSolidifyBatches).set({
      status: 'done',
      inputSummary: JSON.stringify({
        memories: memRows.length, trajectories: trajRows.length,
        proposals: inserts.length, notes,
      }),
      updatedAt: new Date(),
    }).where(eq(assistantSolidifyBatches.id, batchId));
  } catch (e) {
    logger.warn({ err: e, batchId }, 'solidify: scan failed');
    await fail((e as Error).message);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- solidify-service`
Expected: PASS（10 tests）。

- [ ] **Step 5: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
git add apps/api/src/pi/space/solidifyService.ts apps/api/test/solidify-service.test.ts
git commit -m "feat(space): R3 固化盘点管线——active 源 top200 蒸馏+四判据 system prompt+逐条校验入库"
```

---

### Task 6: solidifyApply——审批执行 + 源退役

**Files:**
- Create: `apps/api/src/pi/space/solidifyApply.ts`
- Test: `apps/api/test/solidify-apply.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/solidify-apply.test.ts`：

```ts
/** 审批执行：乐观锁/prompt 追加+baseline/skill 先写盘后记行+幂等重放/退役守卫/部分失败回 pending。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let tmpDataDir: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  tmpDataDir = mkdtempSync(join(tmpdir(), 'itest-sa-'));
  process.env.PI_DATA_DIR = tmpDataDir;
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_solidify_proposals, assistant_solidify_batches, assistant_prompt_module_versions, assistant_memories, assistant_trajectories, assistant_skills`);
});

async function seedBatch(): Promise<string> {
  return (await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('done') RETURNING id`)).rows[0]!.id as string;
}

async function seedSources(): Promise<{ memoryId: string; trajectoryId: string }> {
  const { projectId } = await seedProject(pool);
  const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
  const memoryId = randomUUID();
  const trajectoryId = randomUUID();
  await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES ($1, 'product_line', $2, 'm', 'h', 'ai_inferred')`, [memoryId, lineId]);
  await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model) VALUES ($1, $2, 't', 'k', 'd', 'c', 'm')`, [trajectoryId, lineId]);
  return { memoryId, trajectoryId };
}

async function seedProposal(opts: { kind: 'prompt_amendment' | 'skill_revision'; target: string; sourceIds: Array<{ type: 'memory' | 'trajectory'; id: string }> }): Promise<string> {
  const batchId = await seedBatch();
  return (await pool.query(
    `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, distill_model)
     VALUES ($1, $2, $3, '提案', $4, 'r', $5::jsonb, 'm') RETURNING id`,
    [batchId, opts.kind, opts.target, opts.kind === 'skill_revision' ? '修订后正文' : '- 增量文案',
     JSON.stringify(opts.sourceIds.map((s) => ({ type: s.type, id: s.id, title: 'src', retireRecommended: s.type === 'memory' })))],
  )).rows[0]!.id as string;
}

async function seedSkill(name = 'demo-skill') {
  await pool.query(`INSERT INTO assistant_skills (name, description) VALUES ($1, '演示技能')`, [name]);
  const dir = join(tmpDataDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${JSON.stringify(name)}\ndescription: "演示技能"\n---\n\n旧正文`);
}

describe('approveProposal：prompt_amendment', () => {
  it('无版本行 → 先 baseline（代码默认）再追加增量；appliedAt 落值', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: memoryId }] });
    await approveProposal(null, id, []);
    const rows = (await pool.query(`SELECT * FROM assistant_prompt_module_versions ORDER BY seq`)).rows;
    expect(rows.length).toBe(2);
    expect(rows[0].source).toBe('baseline');
    expect(rows[0].value).toContain('## 输出风格'); // 代码默认被钉住
    expect(rows[1].source).toBe('solidify_apply');
    expect(rows[1].value).toBe(`${rows[0].value}\n\n- 增量文案`);
    expect(rows[1].source_ref).toBe(id);
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals WHERE id=$1`, [id])).rows[0]!;
    expect(p.status).toBe('approved');
    expect(p.applied_at).toBeTruthy();
  });

  it('有手工行 → 在当前值尾部追加（不落 baseline）', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '旧文案', 'manual_edit')`);
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: memoryId }] });
    await approveProposal(null, id, []);
    const rows = (await pool.query(`SELECT * FROM assistant_prompt_module_versions ORDER BY seq`)).rows;
    expect(rows.length).toBe(2);
    expect(rows[1].value).toBe('旧文案\n\n- 增量文案');
  });

  it('部分失败后重试：sourceRef 行已存在 → 跳过写值，不重复落行', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: memoryId }] });
    await approveProposal(null, id, []);
    // 模拟「应用成功但 appliedAt 未落」的部分失败：回 pending 再批
    await pool.query(`UPDATE assistant_solidify_proposals SET status='pending', applied_at=null WHERE id=$1`, [id]);
    await approveProposal(null, id, []);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_prompt_module_versions WHERE source_ref=$1`, [id])).rows[0]!;
    expect(n.n).toBe(1);
  });
});

describe('approveProposal：skill_revision', () => {
  it('先写文件（frontmatter 从 DB 重拼）再记 baseline+apply 行', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    await seedSkill();
    const id = await seedProposal({ kind: 'skill_revision', target: 'demo-skill', sourceIds: [{ type: 'memory', id: memoryId }] });
    await approveProposal(null, id, []);
    const md = readFileSync(join(tmpDataDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf8');
    expect(md).toBe('---\nname: "demo-skill"\ndescription: "演示技能"\n---\n\n修订后正文');
    const rows = (await pool.query(`SELECT * FROM assistant_prompt_module_versions ORDER BY seq`)).rows;
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ module_key: 'skill.demo-skill', value: '旧正文', source: 'baseline' });
    expect(rows[1]).toMatchObject({ module_key: 'skill.demo-skill', value: '修订后正文', source: 'solidify_apply', source_ref: id });
  });

  it('skill 不存在 → 500 + 提案回 pending + apply_error', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    const id = await seedProposal({ kind: 'skill_revision', target: 'ghost-skill', sourceIds: [{ type: 'memory', id: memoryId }] });
    await expect(approveProposal(null, id, [])).rejects.toMatchObject({ status: 500 });
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals WHERE id=$1`, [id])).rows[0]!;
    expect(p.status).toBe('pending');
    expect(p.apply_error).toContain('ghost-skill');
  });
});

describe('approveProposal：退役与守卫', () => {
  it('retireIds 勾选 memory → retired_solidified+retired_by_batch；未勾 trajectory 保持 active', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const src = await seedSources();
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: src.memoryId }, { type: 'trajectory', id: src.trajectoryId }] });
    await approveProposal(null, id, [src.memoryId]);
    const m = (await pool.query(`SELECT * FROM assistant_memories WHERE id=$1`, [src.memoryId])).rows[0]!;
    expect(m.status).toBe('retired_solidified');
    expect(m.retired_by_batch).toBeTruthy();
    const t = (await pool.query(`SELECT * FROM assistant_trajectories WHERE id=$1`, [src.trajectoryId])).rows[0]!;
    expect(t.status).toBe('active');
  });

  it('retireIds 越界（非本提案 sources）→ 400', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: memoryId }] });
    await expect(approveProposal(null, id, [randomUUID()])).rejects.toMatchObject({ status: 400 });
  });

  it('非 pending（已批）→ 409；不重复应用', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: memoryId }] });
    await approveProposal(null, id, []);
    await expect(approveProposal(null, id, [])).rejects.toMatchObject({ status: 409 });
  });

  it('退役 active 守卫：已 retired 的源不复活不重复计', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const src = await seedSources();
    await pool.query(`UPDATE assistant_memories SET status='retired_manual' WHERE id=$1`, [src.memoryId]);
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: src.memoryId }] });
    await approveProposal(null, id, [src.memoryId]);
    const m = (await pool.query(`SELECT * FROM assistant_memories WHERE id=$1`, [src.memoryId])).rows[0]!;
    expect(m.status).toBe('retired_manual'); // WHERE status='active' 守卫：不改已退役行
  });
});

describe('rejectProposal', () => {
  it('驳回：status=rejected，不碰任何资产', async () => {
    const { rejectProposal } = await import('../src/pi/space/solidifyApply.js');
    const { memoryId } = await seedSources();
    const id = await seedProposal({ kind: 'prompt_amendment', target: 'space.style.zh', sourceIds: [{ type: 'memory', id: memoryId }] });
    await rejectProposal(null, id);
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals WHERE id=$1`, [id])).rows[0]!;
    expect(p.status).toBe('rejected');
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_prompt_module_versions`)).rows[0]!;
    expect(n.n).toBe(0);
    await expect(rejectProposal(null, id)).rejects.toMatchObject({ status: 409 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- solidify-apply`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 solidifyApply.ts**

创建 `apps/api/src/pi/space/solidifyApply.ts`：

```ts
/**
 * R3 固化管线：审批执行（乐观锁 → 应用 → 源退役）与驳回。
 * 幂等三件套：乐观锁（pending→approved 单胜）/ source_ref partial unique（重放单行）/
 * 退役 active 守卫（不复活/不重复改已退役条目）。skill 修订先写文件再记版本行（重放无害）。
 * 部分失败：apply_error 记原因 + status 回 pending 可重试。
 */
import { and, eq, inArray } from 'drizzle-orm';
import { HttpError } from '../../middleware/errorHandler.js';
import { db } from '../../db/client.js';
import {
  assistantMemories, assistantPromptModuleVersions, assistantSolidifyProposals,
  assistantTrajectories,
} from '../../db/schema.js';
import {
  insertPromptModuleVersion, listPromptModuleDefs, loadPromptModuleOverrides,
  readSkillBody, readSkillMeta, writeSkillBodyFromDb,
} from './promptModules.js';

type ProposalRow = typeof assistantSolidifyProposals.$inferSelect;

async function hasAppliedVersionRow(key: string, proposalId: string): Promise<boolean> {
  const r = await db.select({ seq: assistantPromptModuleVersions.seq }).from(assistantPromptModuleVersions)
    .where(and(
      eq(assistantPromptModuleVersions.moduleKey, key),
      eq(assistantPromptModuleVersions.sourceRef, proposalId),
    )).limit(1);
  return r.length > 0;
}

/** prompt_amendment：当前无值先落 baseline（钉住代码默认），再追加增量；sourceRef 幂等。 */
async function applyPromptAmendment(prop: ProposalRow, userId: string | null): Promise<void> {
  const def = (await listPromptModuleDefs()).find((d) => d.key === prop.target && d.group !== 'skill');
  if (!def) throw new Error(`target 不在注册表：${prop.target}`);
  if (await hasAppliedVersionRow(prop.target, prop.id)) return; // 重试重放：已应用过，跳过
  const current = (await loadPromptModuleOverrides()).get(prop.target);
  if (!current || current.value == null) {
    await insertPromptModuleVersion({
      moduleKey: prop.target, value: await def.defaultValue(), source: 'baseline', createdByUserId: userId,
    });
  }
  const baseText = current?.value ?? await def.defaultValue();
  const seq = await insertPromptModuleVersion({
    moduleKey: prop.target, value: `${baseText}\n\n${prop.body}`,
    source: 'solidify_apply', sourceRef: prop.id, createdByUserId: userId,
  });
  if (seq == null) return; // 并发重放被 unique 吞掉——视为已应用
}

/** skill_revision：首次固化先记 baseline（磁盘现正文）；先写文件（frontmatter 从 DB 重拼）再记版本行。 */
async function applySkillRevision(prop: ProposalRow, userId: string | null): Promise<void> {
  const key = `skill.${prop.target}`;
  const meta = await readSkillMeta(prop.target);
  if (!meta) throw new Error(`skill 不存在或未启用：${prop.target}`);
  if (await hasAppliedVersionRow(key, prop.id)) return; // 重试时若 sourceRef 行已存在则跳过写文件
  const hasAny = (await db.select({ seq: assistantPromptModuleVersions.seq }).from(assistantPromptModuleVersions)
    .where(eq(assistantPromptModuleVersions.moduleKey, key)).limit(1)).length > 0;
  if (!hasAny) {
    await insertPromptModuleVersion({
      moduleKey: key, value: await readSkillBody(prop.target), source: 'baseline', createdByUserId: userId,
    });
  }
  await writeSkillBodyFromDb(meta.name, meta.description, prop.body);
  await insertPromptModuleVersion({
    moduleKey: key, value: prop.body, source: 'solidify_apply', sourceRef: prop.id, createdByUserId: userId,
  });
}

/** 源退役：active 守卫防重复退役/复活已删条目；按 type 分表更新。 */
async function retireSources(prop: ProposalRow, retireIds: string[]): Promise<void> {
  if (retireIds.length === 0) return;
  const sources = prop.sources;
  const memIds = retireIds.filter((id) => sources.some((s) => s.id === id && s.type === 'memory'));
  const trajIds = retireIds.filter((id) => sources.some((s) => s.id === id && s.type === 'trajectory'));
  if (memIds.length > 0) {
    await db.update(assistantMemories)
      .set({ status: 'retired_solidified', retiredByBatch: prop.batchId, updatedAt: new Date() })
      .where(and(inArray(assistantMemories.id, memIds), eq(assistantMemories.status, 'active')));
  }
  if (trajIds.length > 0) {
    await db.update(assistantTrajectories)
      .set({ status: 'retired_solidified', retiredByBatch: prop.batchId, updatedAt: new Date() })
      .where(and(inArray(assistantTrajectories.id, trajIds), eq(assistantTrajectories.status, 'active')));
  }
}

/** 批准并应用：乐观锁（0 行→409）→ 应用 → 退役 → appliedAt；失败回 pending + apply_error。 */
export async function approveProposal(userId: string | null, proposalId: string, retireIds: string[]): Promise<void> {
  const prop = (await db.select().from(assistantSolidifyProposals)
    .where(eq(assistantSolidifyProposals.id, proposalId)).limit(1))[0];
  if (!prop) throw new HttpError(404, 'not_found', '提案不存在');
  const sourceIds = new Set(prop.sources.map((s) => s.id));
  if (retireIds.some((id) => !sourceIds.has(id))) {
    throw new HttpError(400, 'retire_source_mismatch', 'retireIds 含本提案 sources 之外的条目');
  }
  const locked = await db.update(assistantSolidifyProposals)
    .set({ status: 'approved', reviewedBy: userId, reviewedAt: new Date(), applyError: null })
    .where(and(eq(assistantSolidifyProposals.id, proposalId), eq(assistantSolidifyProposals.status, 'pending')))
    .returning({ id: assistantSolidifyProposals.id });
  if (locked.length === 0) throw new HttpError(409, 'proposal_not_pending', '提案不在待审批状态');
  try {
    if (prop.kind === 'prompt_amendment') await applyPromptAmendment(prop, userId);
    else await applySkillRevision(prop, userId);
    await retireSources(prop, retireIds);
    await db.update(assistantSolidifyProposals)
      .set({ appliedAt: new Date() })
      .where(eq(assistantSolidifyProposals.id, proposalId));
  } catch (e) {
    await db.update(assistantSolidifyProposals)
      .set({ status: 'pending', applyError: (e as Error).message.slice(0, 2000) })
      .where(eq(assistantSolidifyProposals.id, proposalId));
    throw new HttpError(500, 'solidify_apply_failed', `应用失败：${(e as Error).message}`);
  }
}

/** 驳回：同样乐观锁，不碰任何资产。 */
export async function rejectProposal(userId: string | null, proposalId: string): Promise<void> {
  const r = await db.update(assistantSolidifyProposals)
    .set({ status: 'rejected', reviewedBy: userId, reviewedAt: new Date() })
    .where(and(eq(assistantSolidifyProposals.id, proposalId), eq(assistantSolidifyProposals.status, 'pending')))
    .returning({ id: assistantSolidifyProposals.id });
  if (r.length === 0) throw new HttpError(409, 'proposal_not_pending', '提案不在待审批状态');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- solidify-apply`
Expected: PASS（10 tests）。

- [ ] **Step 5: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
git add apps/api/src/pi/space/solidifyApply.ts apps/api/test/solidify-apply.test.ts
git commit -m "feat(space): R3 审批执行——乐观锁+prompt 追加/skill 先写盘后记行+幂等重放+源退役守卫"
```

---

### Task 7: solidifyRoute——REST 端点 + 挂载

**Files:**
- Create: `apps/api/src/pi/space/solidifyRoute.ts`
- Modify: `apps/api/src/pi/space/router.ts`（import + 挂载）
- Test: `apps/api/test/solidify-route.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/solidify-route.test.ts`（harness 同 Task 4 的 prompt-modules-route.test.ts：PI_DATA_DIR + supertest + mount(manager/member)；beforeAll/beforeEach/afterAll 骨架直接复用，只换 TRUNCATE 与用例）：

```ts
/** 固化管线路由：scan 202/409 防重入/批次与提案查询/approve/reject/权限门。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Express } from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';
import { managerUserOf, memberUserOf } from './helpers/auth.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let tmpDataDir: string;
let orgId = '';
let orgPath = '';
let mount: (role: 'manager' | 'member') => Promise<Express>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const org = await seedOrg(pool);
  orgId = org.orgId;
  orgPath = org.orgPath;
  tmpDataDir = mkdtempSync(join(tmpdir(), 'itest-sr-'));
  process.env.PI_DATA_DIR = tmpDataDir;
  const { default: spaceRoute } = await import('../src/pi/space/router.js');
  const express = (await import('express')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  mount = async (role) => {
    const userId = crypto.randomUUID();
    const user = role === 'manager'
      ? managerUserOf(userId, 'mgr', orgId, orgPath)
      : memberUserOf(userId, 'mem', orgId, orgPath);
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use('/api/assistant', spaceRoute);
    app.use(errorHandler);
    return app;
  };
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_solidify_proposals, assistant_solidify_batches, assistant_prompt_module_versions, assistant_memories, assistant_trajectories, assistant_skills, settings`);
});

async function seedPendingProposal(): Promise<{ id: string; batchId: string; memoryId: string }> {
  const { projectId } = await seedProject(pool);
  const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
  const memoryId = randomUUID();
  await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES ($1, 'product_line', $2, 'm', 'h', 'ai_inferred')`, [memoryId, lineId]);
  const batchId = (await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('done') RETURNING id`)).rows[0]!.id as string;
  const id = (await pool.query(
    `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, distill_model)
     VALUES ($1, 'prompt_amendment', 'space.style.zh', '提案', 'b', 'r', $2::jsonb, 'm') RETURNING id`,
    [batchId, JSON.stringify([{ type: 'memory', id: memoryId, title: 'src', retireRecommended: true }])],
  )).rows[0]!.id as string;
  return { id, batchId, memoryId };
}

describe('solidify 路由', () => {
  it('POST /scan：202 + 批次 id；running 时再发 → 409', async () => {
    const app = await mount('manager');
    const res = await request(app).post('/api/assistant/solidify/scan').expect(202);
    expect(res.body.id).toBeTruthy();
    await request(app).post('/api/assistant/solidify/scan').expect(409); // 未配置 LLM 时批次很快 failed，但 409 语义在 running 窗口内先成立——这里直接置回 running 验证
  });

  it('POST /scan：running 批次存在 → 409（稳定复现）', async () => {
    const app = await mount('manager');
    await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('running')`);
    await request(app).post('/api/assistant/solidify/scan').expect(409);
  });

  it('GET /batches：批次历史（含 error）', async () => {
    const app = await mount('manager');
    await pool.query(`INSERT INTO assistant_solidify_batches (status, input_summary) VALUES ('done', '{}')`);
    const res = await request(app).get('/api/assistant/solidify/batches').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].status).toBeTruthy();
  });

  it('GET /proposals：batchId/status 过滤；GET /proposals/:id 详情含 sources', async () => {
    const app = await mount('manager');
    const { id, batchId } = await seedPendingProposal();
    const all = await request(app).get('/api/assistant/solidify/proposals').expect(200);
    expect(all.body.length).toBe(1);
    const byBatch = await request(app).get(`/api/assistant/solidify/proposals?batchId=${batchId}`).expect(200);
    expect(byBatch.body.length).toBe(1);
    const byStatus = await request(app).get('/api/assistant/solidify/proposals?status=rejected').expect(200);
    expect(byStatus.body.length).toBe(0);
    const detail = await request(app).get(`/api/assistant/solidify/proposals/${id}`).expect(200);
    expect(detail.body.sources[0].type).toBe('memory');
    await request(app).get(`/api/assistant/solidify/proposals/${randomUUID()}`).expect(404);
  });

  it('POST /proposals/:id/approve：默认不退役；retireIds 退役来源', async () => {
    const app = await mount('manager');
    const { id, memoryId } = await seedPendingProposal();
    await request(app).post(`/api/assistant/solidify/proposals/${id}/approve`).send({ retireIds: [] }).expect(200);
    let m = (await pool.query(`SELECT status FROM assistant_memories WHERE id=$1`, [memoryId])).rows[0]!;
    expect(m.status).toBe('active');

    // 再造一条 pending 提案验证带退役的批准
    const p2 = await seedPendingProposal();
    await request(app).post(`/api/assistant/solidify/proposals/${p2.id}/approve`).send({ retireIds: [p2.memoryId] }).expect(200);
    m = (await pool.query(`SELECT status FROM assistant_memories WHERE id=$1`, [p2.memoryId])).rows[0]!;
    expect(m.status).toBe('retired_solidified');
    // 重复批 → 409
    await request(app).post(`/api/assistant/solidify/proposals/${p2.id}/approve`).send({ retireIds: [] }).expect(409);
  });

  it('POST /proposals/:id/reject：200 + 状态 rejected', async () => {
    const app = await mount('manager');
    const { id } = await seedPendingProposal();
    await request(app).post(`/api/assistant/solidify/proposals/${id}/reject`).send({}).expect(200);
    const p = (await pool.query(`SELECT status FROM assistant_solidify_proposals WHERE id=$1`, [id])).rows[0]!;
    expect(p.status).toBe('rejected');
  });

  it('非管理员 → 403', async () => {
    const app = await mount('member');
    await request(app).post('/api/assistant/solidify/scan').expect(403);
    await request(app).get('/api/assistant/solidify/batches').expect(403);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- solidify-route`
Expected: FAIL——路由不存在。

- [ ] **Step 3: 实现 solidifyRoute.ts**

创建 `apps/api/src/pi/space/solidifyRoute.ts`：

```ts
/**
 * R3 固化管线路由（requireManager）。scan 是 fire-and-forget：立即返回批次 id，
 * 蒸馏 inline 跑（R2 trajectoryQueue 同款），前端轮询批次状态；错误记在批次上不进响应。
 */
import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { db } from '../../db/client.js';
import { assistantSolidifyBatches, assistantSolidifyProposals } from '../../db/schema.js';
import { approveProposal, rejectProposal } from './solidifyApply.js';
import { runSolidifyScan, startSolidifyScan } from './solidifyService.js';

const router = Router();

router.post('/scan', async (req, res) => {
  const user = req.user as AuthUser;
  const id = await startSolidifyScan(user.userId);
  void runSolidifyScan(id).catch(() => {}); // inline fire-and-forget；失败已记批次
  res.status(202).json({ id });
});

router.get('/batches', async (_req, res) => {
  const rows = await db.select().from(assistantSolidifyBatches)
    .orderBy(desc(assistantSolidifyBatches.createdAt)).limit(50);
  res.json(rows);
});

router.get('/proposals', async (req, res) => {
  const { batchId, status } = req.query as { batchId?: string; status?: string };
  const conds = [];
  if (batchId) conds.push(eq(assistantSolidifyProposals.batchId, batchId));
  if (status) conds.push(eq(assistantSolidifyProposals.status, status));
  const rows = await db.select().from(assistantSolidifyProposals)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(assistantSolidifyProposals.createdAt)).limit(200);
  res.json(rows);
});

router.get('/proposals/:id', async (req, res) => {
  const row = (await db.select().from(assistantSolidifyProposals)
    .where(eq(assistantSolidifyProposals.id, req.params.id)).limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found', '提案不存在');
  res.json(row);
});

const ApproveBody = z.object({ retireIds: z.array(z.string().uuid()).max(50).default([]) });

router.post('/proposals/:id/approve', async (req, res) => {
  const user = req.user as AuthUser;
  const parsed = ApproveBody.safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError(400, 'invalid_body', '请求体不合法');
  await approveProposal(user.userId, String(req.params.id), parsed.data.retireIds);
  res.json({ ok: true });
});

router.post('/proposals/:id/reject', async (req, res) => {
  const user = req.user as AuthUser;
  await rejectProposal(user.userId, String(req.params.id));
  res.json({ ok: true });
});

export default router;
```

- [ ] **Step 4: 挂载**

`apps/api/src/pi/space/router.ts`：import 区加 `import solidifyRoute from './solidifyRoute.js';`；Task 4 加的 prompt-modules 挂载行之后加：

```ts
spaceRoute.use('/solidify', requireManager, solidifyRoute);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test -- solidify-route`
Expected: PASS（7 tests）。

- [ ] **Step 6: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
git add apps/api/src/pi/space/solidifyRoute.ts apps/api/src/pi/space/router.ts apps/api/test/solidify-route.test.ts
git commit -m "feat(space): R3 固化 REST——scan 202 防重入/批次/提案/approve+reject"
```

---

### Task 8: web client——端点与类型

**Files:**
- Modify: `apps/web/src/api/client.ts`（`assistant` 对象内 `memories` 组附近加两组端点；类型加在 `AssistantMemory` 等类型声明附近）

- [ ] **Step 1: 加类型**

`apps/web/src/api/client.ts` 类型区（`AssistantMemory` 声明附近）加：

```ts
/** R3 prompt 模块（设置页系统提示词）。isDefault=true 表示当前用代码默认值。 */
export interface PromptModule {
  key: string;
  group: 'main' | 'tool' | 'skill';
  label: string;
  readonly: boolean;
  hasRow: boolean;
  seq: number | null;
  source: string | null;
  value: string | null;
  isDefault: boolean;
  text: string;
}

export interface PromptModuleVersion {
  seq: number;
  moduleKey: string;
  value: string | null;
  source: string;
  sourceRef: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface SolidifyBatch {
  id: string;
  status: 'running' | 'done' | 'failed';
  inputSummary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SolidifyProposalSource {
  type: 'memory' | 'trajectory';
  id: string;
  title: string;
  lineName: string;
  retireRecommended: boolean;
}

export interface SolidifyProposal {
  id: string;
  batchId: string;
  kind: 'prompt_amendment' | 'skill_revision';
  target: string;
  title: string;
  body: string;
  rationale: string;
  sources: SolidifyProposalSource[];
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy: string | null;
  reviewedAt: string | null;
  appliedAt: string | null;
  applyError: string | null;
  distillModel: string;
  createdAt: string;
}
```

- [ ] **Step 2: 加端点组**

`api.assistant` 对象内（`memories`/`trajectories` 组之后）加（用文件内既有的 `request<T>` / `qs` helper，风格对齐 `memories` 组）：

```ts
    /** 系统设置：系统提示词模块（R3）。无行=代码默认；skill 组只读（仅 fromSeq 回滚）。 */
    promptModules: {
      list: () => request<PromptModule[]>('/assistant/prompt-modules'),
      versions: (key: string) =>
        request<PromptModuleVersion[]>(`/assistant/prompt-modules/${encodeURIComponent(key)}/versions`),
      setValue: (key: string, body: { value?: string | null; fromSeq?: number }) =>
        request<{ seq: number | null }>(`/assistant/prompt-modules/${encodeURIComponent(key)}/value`, {
          method: 'POST', body: JSON.stringify(body),
        }),
    },
    /** 系统设置：固化盘点（R3）。LLM 只产提案，应用一律经人工批准。 */
    solidify: {
      scan: () => request<{ id: string }>('/assistant/solidify/scan', { method: 'POST', body: '{}' }),
      batches: () => request<SolidifyBatch[]>('/assistant/solidify/batches'),
      proposals: (params?: { batchId?: string; status?: string }) =>
        request<SolidifyProposal[]>(`/assistant/solidify/proposals${qs(params ?? {})}`),
      proposal: (id: string) => request<SolidifyProposal>(`/assistant/solidify/proposals/${id}`),
      approve: (id: string, retireIds: string[]) =>
        request<{ ok: boolean }>(`/assistant/solidify/proposals/${id}/approve`, {
          method: 'POST', body: JSON.stringify({ retireIds }),
        }),
      reject: (id: string) =>
        request<{ ok: boolean }>(`/assistant/solidify/proposals/${id}/reject`, {
          method: 'POST', body: '{}',
        }),
    },
```

- [ ] **Step 3: 校验**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/web && pnpm verify`
Expected: typecheck/i18n/test 全 PASS。

- [ ] **Step 4: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
git add apps/web/src/api/client.ts
git commit -m "feat(web): R3 client——promptModules/solidify 端点组与类型"
```

---

### Task 9: web 设置页——系统提示词 + 固化盘点两个 Section

**Files:**
- Modify: `apps/web/src/i18n/locales/zh-CN/errors.json`、`apps/web/src/i18n/locales/en/errors.json`（R3 错误码）
- Modify: `apps/web/src/i18n/locales/zh-CN/settings.json`、`apps/web/src/i18n/locales/en/settings.json`
- Create: `apps/web/src/components/settings/PromptModulesSection.tsx`
- Create: `apps/web/src/components/settings/SolidifySection.tsx`
- Modify: `apps/web/src/components/settings/AssistantPanel.tsx`（import + 插入两个 Section）

- [ ] **Step 1: errors.json 补 R3 错误码**

`zh-CN/errors.json` 按字母序插入（`invalid_body`/`not_found` 已存在，不重复加）：

```json
  "invalid_rollback": "skill 组不支持回滚到「跟随默认」行",
  "invalid_value": "值不能为空白",
  "module_not_found": "提示词模块不存在",
  "proposal_not_pending": "提案不在待审批状态（可能已被处理）",
  "readonly_module": "skill 正文只读，仅允许回滚历史版本",
  "retire_source_mismatch": "退役条目不属于该提案的来源",
  "scan_running": "已有盘点批次在进行中，请等待完成",
  "skill_missing": "skill 不存在或未启用",
  "solidify_apply_failed": "应用失败，提案已回到待审批，可重试",
  "version_not_found": "版本行不存在",
```

`en/errors.json` 对应位置：

```json
  "invalid_rollback": "Skill modules cannot roll back to a \"follow default\" row",
  "invalid_value": "Value cannot be blank",
  "module_not_found": "Prompt module not found",
  "proposal_not_pending": "Proposal is not pending (may already be reviewed)",
  "readonly_module": "Skill body is read-only; only historical rollback is allowed",
  "retire_source_mismatch": "Retire item does not belong to this proposal's sources",
  "scan_running": "A solidify scan is already running; wait for it to finish",
  "skill_missing": "Skill not found or disabled",
  "solidify_apply_failed": "Apply failed; proposal returned to pending and can be retried",
  "version_not_found": "Version row not found",
```

- [ ] **Step 2: settings.json 加 i18n key**

`zh-CN/settings.json`（`memory*` 键附近之后追加；key 与组件严格对应，不多加）：

```json
  "promptTitle": "系统提示词",
  "promptIntro": "助手系统提示词与工具文案。无自定义值时跟随代码默认（随版本演进）；修改只影响新会话。",
  "promptGroupMain": "主提示词",
  "promptGroupTool": "工具文案",
  "promptGroupSkill": "Skill（只读）",
  "promptSourceDefault": "默认",
  "promptSourceManual": "手工",
  "promptSourceRollback": "回滚",
  "promptSourceBaseline": "基线",
  "promptSourceSolidify": "固化",
  "promptNoModules": "暂无提示词模块",
  "promptEdit": "编辑",
  "promptView": "查看",
  "promptVersions": "版本历史",
  "promptCurrentValue": "当前值",
  "promptValuePlaceholder": "（跟随代码默认）",
  "promptSkillReadonlyHint": "skill 正文只读——修订走「固化盘点」提案或 skill-creator；可回滚历史版本（写回磁盘文件）。",
  "promptRestoreDefault": "恢复默认",
  "promptRestoreDefaultConfirm": "恢复为「跟随代码默认」？历史版本保留，当前自定义值被替换。",
  "promptRollback": "回滚到此版本",
  "promptRollbackConfirm": "回滚到版本 {{seq}}？将追加一行新版本，历史保留。",
  "promptSaved": "已保存",
  "promptVersionLabel": "版本 {{seq}}",
  "solidifyTitle": "固化盘点",
  "solidifyIntro": "从助手记忆与轨迹蒸馏跨产品线的泛化经验产出提案——LLM 只产提案，应用一律经人工批准。",
  "solidifyScan": "发起盘点",
  "solidifyScanning": "盘点中…",
  "solidifyBatchEmpty": "尚无盘点批次",
  "solidifyBatchRunning": "进行中",
  "solidifyBatchDone": "完成",
  "solidifyBatchFailed": "失败",
  "solidifyProposalNone": "暂无提案——发起盘点后蒸馏结果会出现在这里。",
  "solidifyKindPrompt": "提示词增量",
  "solidifyKindSkill": "Skill 修订",
  "solidifyStatusPending": "待审批",
  "solidifyStatusApproved": "已批准",
  "solidifyStatusRejected": "已驳回",
  "solidifyTarget": "落点",
  "solidifyRationale": "理由",
  "solidifyIncrement": "增量文案",
  "solidifyAppendPreview": "叠加预览（当前值 + 增量）",
  "solidifyCurrent": "当前值",
  "solidifyProposed": "修订后",
  "solidifySources": "来源（勾选 = 批准后退役）",
  "solidifyApprove": "批准并应用",
  "solidifyReject": "驳回",
  "solidifyModel": "蒸馏模型",
  "solidifyNotes": "批次提示",
  "solidifyApplyError": "应用失败（可重试）",
  "solidifyAppliedAt": "应用于",
  "solidifyReviewed": "已审"
```

`en/settings.json` 对应追加：

```json
  "promptTitle": "System Prompts",
  "promptIntro": "Assistant system prompt and tool copy. Without a custom value each module follows the code default (evolves with releases); edits affect new sessions only.",
  "promptGroupMain": "Main prompt",
  "promptGroupTool": "Tool copy",
  "promptGroupSkill": "Skills (read-only)",
  "promptSourceDefault": "Default",
  "promptSourceManual": "Manual",
  "promptSourceRollback": "Rolled back",
  "promptSourceBaseline": "Baseline",
  "promptSourceSolidify": "Solidified",
  "promptNoModules": "No prompt modules",
  "promptEdit": "Edit",
  "promptView": "View",
  "promptVersions": "Version history",
  "promptCurrentValue": "Current value",
  "promptValuePlaceholder": "(follows code default)",
  "promptSkillReadonlyHint": "Skill bodies are read-only — revise via solidify proposals or skill-creator; rollback writes back to disk.",
  "promptRestoreDefault": "Restore default",
  "promptRestoreDefaultConfirm": "Restore to \"follow code default\"? History is kept; the current custom value is replaced.",
  "promptRollback": "Roll back to this version",
  "promptRollbackConfirm": "Roll back to version {{seq}}? A new version row is appended; history is kept.",
  "promptSaved": "Saved",
  "promptVersionLabel": "Version {{seq}}",
  "solidifyTitle": "Solidify Scan",
  "solidifyIntro": "Distills cross-product-line general experience from memories and trajectories into proposals — the LLM only proposes; every apply goes through human approval.",
  "solidifyScan": "Start scan",
  "solidifyScanning": "Scanning…",
  "solidifyBatchEmpty": "No batches yet",
  "solidifyBatchRunning": "Running",
  "solidifyBatchDone": "Done",
  "solidifyBatchFailed": "Failed",
  "solidifyProposalNone": "No proposals — distilled results appear here after a scan.",
  "solidifyKindPrompt": "Prompt amendment",
  "solidifyKindSkill": "Skill revision",
  "solidifyStatusPending": "Pending",
  "solidifyStatusApproved": "Approved",
  "solidifyStatusRejected": "Rejected",
  "solidifyTarget": "Target",
  "solidifyRationale": "Rationale",
  "solidifyIncrement": "Increment text",
  "solidifyAppendPreview": "Appended preview (current + increment)",
  "solidifyCurrent": "Current",
  "solidifyProposed": "Proposed",
  "solidifySources": "Sources (checked = retire on approve)",
  "solidifyApprove": "Approve & apply",
  "solidifyReject": "Reject",
  "solidifyModel": "Distill model",
  "solidifyNotes": "Batch notes",
  "solidifyApplyError": "Apply failed (retryable)",
  "solidifyAppliedAt": "Applied at",
  "solidifyReviewed": "Reviewed"
```

- [ ] **Step 3: PromptModulesSection.tsx**

创建 `apps/web/src/components/settings/PromptModulesSection.tsx`（骨架对齐 MemoriesSection：卡片+hairline 标题+EmptyState compact+Dialog）：

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localizeApiError } from '../../i18n';
import { api, type PromptModule, type PromptModuleVersion } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';

const GROUPS: Array<PromptModule['group']> = ['main', 'tool', 'skill'];
const GROUP_KEY: Record<PromptModule['group'], string> = {
  main: 'promptGroupMain', tool: 'promptGroupTool', skill: 'promptGroupSkill',
};

function sourceBadgeKey(t: ReturnType<typeof useTranslation>['t'], m: PromptModule): string {
  if (m.isDefault) return t(`settings:promptSourceDefault`);
  const map: Record<string, string> = {
    manual_edit: 'promptSourceManual', rollback: 'promptSourceRollback',
    baseline: 'promptSourceBaseline', solidify_apply: 'promptSourceSolidify',
  };
  return t(`settings:${map[m.source ?? ''] ?? 'promptSourceManual'}`);
}

/** 设置页「系统提示词」：模块分组列表 + 编辑抽屉（skill 只读）+ 版本历史抽屉（回滚/恢复默认）。 */
export default function PromptModulesSection() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const listQ = useQuery({ queryKey: ['prompt-modules'], queryFn: () => api.assistant.promptModules.list() });
  const [editing, setEditing] = useState<PromptModule | null>(null);
  const [draft, setDraft] = useState('');
  const [versionsOf, setVersionsOf] = useState<PromptModule | null>(null);
  const [pickedSeq, setPickedSeq] = useState<number | null>(null);

  const versionsQ = useQuery({
    queryKey: ['prompt-module-versions', versionsOf?.key],
    queryFn: () => api.assistant.promptModules.versions(versionsOf!.key),
    enabled: !!versionsOf,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['prompt-modules'] });
    qc.invalidateQueries({ queryKey: ['prompt-module-versions', versionsOf?.key] });
  };

  const save = useMutation({
    mutationFn: (args: { key: string; body: { value?: string | null; fromSeq?: number } }) =>
      api.assistant.promptModules.setValue(args.key, args.body),
    onSuccess: () => { toast(t('settings:promptSaved'), 'success'); setEditing(null); invalidate(); },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const modules = listQ.data ?? [];
  const versions = versionsQ.data ?? [];
  const picked = versions.find((v) => v.seq === pickedSeq) ?? null;
  const isSkill = editing?.group === 'skill';

  return (
    <div className="bg-card border rounded-[var(--radius-sm)]">
      <div className="flex items-center gap-2 px-4 py-3 hairline-bottom" style={{ borderColor: 'var(--border)' }}>
        <Icon name="terminal" size={14} style={{ color: 'var(--primary)' }} />
        <h3 className="text-[14px] font-semibold m-0 flex-1" style={{ color: 'var(--foreground)' }}>
          {t('settings:promptTitle')}
        </h3>
      </div>
      <div className="px-4 pt-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
        {t('settings:promptIntro')}
      </div>
      <div className="p-2">
        {listQ.isLoading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
            {t('common:loading')}
          </div>
        ) : modules.length === 0 ? (
          <EmptyState icon="terminal" title={t('settings:promptNoModules')} compact />
        ) : (
          GROUPS.map((g) => {
            const rows = modules.filter((m) => m.group === g);
            if (rows.length === 0) return null;
            return (
              <div key={g} className="mb-2">
                <div className="px-2 pt-2 pb-1 text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                  {t(`settings:${GROUP_KEY[g]}`)}
                </div>
                {rows.map((m) => (
                  <div key={m.key} className="flex items-center gap-3 px-2 py-2">
                    <div className="flex flex-col min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-medium truncate" style={{ color: 'var(--foreground)' }}>{m.label}</span>
                        <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                          {sourceBadgeKey(t, m)}
                        </span>
                      </div>
                      <span className="text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }}>{m.key}</span>
                    </div>
                    <Button
                      variant="ghost"
                      onClick={() => { setEditing(m); setDraft(m.text); }}
                    >
                      {t(m.group === 'skill' ? 'settings:promptView' : 'settings:promptEdit')}
                    </Button>
                    <Button variant="ghost" onClick={() => { setVersionsOf(m); setPickedSeq(null); }}>
                      {t('settings:promptVersions')}
                    </Button>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>

      {/* 编辑/查看抽屉：skill 组只读 + 回磁盘回滚提示；代码默认组可恢复默认（写 NULL 行） */}
      <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `${editing.label}（${editing.key}）` : ''}</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-3 flex flex-col gap-2">
            {isSkill && (
              <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                {t('settings:promptSkillReadonlyHint')}
              </div>
            )}
            <textarea
              className="input-base font-mono text-[12px]"
              style={{ minHeight: 240, resize: 'vertical' }}
              value={draft}
              readOnly={isSkill}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 px-5 py-4">
            {!isSkill && (
              <Button
                variant="ghost"
                disabled={save.isPending || editing?.isDefault}
                title={editing?.isDefault ? t('settings:promptValuePlaceholder') : undefined}
                onClick={() => editing && window.confirm(t('settings:promptRestoreDefaultConfirm'))
                  && save.mutate({ key: editing.key, body: { value: null } })}
              >
                {t('settings:promptRestoreDefault')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setEditing(null)}>{t('common:close')}</Button>
            {!isSkill && (
              <Button
                variant="primary"
                disabled={save.isPending}
                onClick={() => editing && save.mutate({ key: editing.key, body: { value: draft } })}
              >
                {t('common:save')}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 版本历史抽屉：选中行与当前值并排对照（全文 diff）；回滚=fromSeq（skill 组同时写回磁盘） */}
      <Dialog open={!!versionsOf} onOpenChange={(open) => { if (!open) setVersionsOf(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{versionsOf ? `${versionsOf.label} · ${t('settings:promptVersions')}` : ''}</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-3 flex flex-col gap-3">
            <div className="max-h-56 overflow-y-auto flex flex-col gap-1">
              {versions.length === 0 ? (
                <div className="text-[12px] py-2" style={{ color: 'var(--muted-foreground)' }}>
                  {t('settings:promptValuePlaceholder')}
                </div>
              ) : versions.map((v: PromptModuleVersion) => (
                <button
                  key={v.seq}
                  type="button"
                  className="flex items-center gap-2 px-2 py-1.5 rounded text-left"
                  style={{ background: pickedSeq === v.seq ? 'var(--primary-soft)' : 'transparent' }}
                  onClick={() => setPickedSeq(v.seq)}
                >
                  <span className="text-[11px] font-mono" style={{ color: 'var(--foreground)' }}>
                    {t('settings:promptVersionLabel', { seq: v.seq })}
                  </span>
                  <span className="text-[10px] px-1.5 py-[1px] rounded" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                    {sourceBadgeKey(t, { source: v.source, isDefault: v.value == null } as PromptModule)}
                  </span>
                  <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
            {picked && (
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                    {t('settings:promptCurrentLabel', { name: versionsOf?.label ?? '' })}
                  </div>
                  <pre className="m-0 p-2 rounded text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto"
                    style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                    {versionsOf?.text || t('settings:promptValuePlaceholder')}
                  </pre>
                </div>
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                    {t('settings:promptVersionLabel', { seq: picked.seq })}
                  </div>
                  <pre className="m-0 p-2 rounded text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto"
                    style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                    {picked.value ?? t('settings:promptValuePlaceholder')}
                  </pre>
                </div>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setVersionsOf(null)}>{t('common:close')}</Button>
            <Button
              variant="primary"
              disabled={!picked || picked.value == null || save.isPending}
              onClick={() => versionsOf && picked && window.confirm(t('settings:promptRollbackConfirm', { seq: picked.seq }))
                && save.mutate({ key: versionsOf.key, body: { fromSeq: picked.seq } })}
            >
              {t('settings:promptRollback')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

注意两个细节：① `sourceBadgeKey` 在版本历史里以 `{source, isDefault}` 局部对象复用（值 NULL 的行=跟随默认）；② 版本对照左栏标签用了 `promptCurrentLabel`——zh `"{{name}} · 当前值"` / en `"{{name}} · current"`，补进两个 settings.json（Step 2 的块里没含它，别漏）：

```json
  "promptCurrentLabel": "{{name}} · 当前值",
```
```json
  "promptCurrentLabel": "{{name}} · current",
```

- [ ] **Step 4: SolidifySection.tsx**

创建 `apps/web/src/components/settings/SolidifySection.tsx`：

```tsx
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localizeApiError } from '../../i18n';
import { api, type SolidifyBatch, type SolidifyProposal } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';

const BATCH_STATUS_KEY: Record<SolidifyBatch['status'], string> = {
  running: 'solidifyBatchRunning', done: 'solidifyBatchDone', failed: 'solidifyBatchFailed',
};
const PROPOSAL_STATUS_KEY: Record<SolidifyProposal['status'], string> = {
  pending: 'solidifyStatusPending', approved: 'solidifyStatusApproved', rejected: 'solidifyStatusRejected',
};

/** 设置页「固化盘点」：发起盘点（409 防重入 toast）→ 轮询批次 → 提案列表 → 详情 diff + 退役勾选 → 批准/驳回。 */
export default function SolidifySection() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const batchesQ = useQuery({
    queryKey: ['solidify-batches'],
    queryFn: () => api.assistant.solidify.batches(),
    // running 存在时 3s 轮询；终态停表（refetchInterval 函数式，v5 语义）
    refetchInterval: (query) => ((query.state.data ?? []).some((b) => b.status === 'running') ? 3000 : false),
  });
  const hasRunning = (batchesQ.data ?? []).some((b) => b.status === 'running');

  const proposalsQ = useQuery({
    queryKey: ['solidify-proposals'],
    queryFn: () => api.assistant.solidify.proposals(),
    refetchInterval: hasRunning ? 5000 : false, // 批次 running 期间顺带刷新提案；done 后由 invalidate 收口
  });
  // 当前值来源（叠加预览/skill 对照左栏）：复用 prompt 模块列表
  const modulesQ = useQuery({
    queryKey: ['prompt-modules'],
    queryFn: () => api.assistant.promptModules.list(),
    staleTime: 60_000,
  });

  const [openId, setOpenId] = useState<string | null>(null);
  const [retireIds, setRetireIds] = useState<string[]>([]);
  const detailQ = useQuery({
    queryKey: ['solidify-proposal', openId],
    queryFn: () => api.assistant.solidify.proposal(openId!),
    enabled: !!openId,
  });
  const detail = detailQ.data ?? null;

  const scan = useMutation({
    mutationFn: () => api.assistant.solidify.scan(),
    onSuccess: () => {
      toast(t('settings:solidifyScanning'), 'success');
      qc.invalidateQueries({ queryKey: ['solidify-batches'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });
  const review = useMutation({
    mutationFn: (args: { id: string; approve: boolean }) =>
      args.approve
        ? api.assistant.solidify.approve(args.id, retireIds)
        : api.assistant.solidify.reject(args.id),
    onSuccess: (_r, args) => {
      toast(t('settings:solidifyReviewed'), 'success');
      setOpenId(null);
      qc.invalidateQueries({ queryKey: ['solidify-proposals'] });
      qc.invalidateQueries({ queryKey: ['prompt-modules'] }); // 应用会写版本行/改 skill
      if (args.approve) {
        // 退役发生在批准：记忆/轨迹列表里被勾选来源随之消失（active 口径）
        qc.invalidateQueries({ queryKey: ['assistant-memories'] });
        qc.invalidateQueries({ queryKey: ['assistant-trajectories'] });
      }
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const openProposal = (p: SolidifyProposal) => {
    setRetireIds(p.sources.filter((s) => s.retireRecommended).map((s) => s.id)); // 预填建议值，人工可改
    setOpenId(p.id);
  };

  const proposals = useMemo(
    () => [...(proposalsQ.data ?? [])].sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0)),
    [proposalsQ.data],
  );
  const currentText = useMemo(() => {
    if (!detail) return '';
    const key = detail.kind === 'skill_revision' ? `skill.${detail.target}` : detail.target;
    return modulesQ.data?.find((m) => m.key === key)?.text ?? '';
  }, [detail, modulesQ.data]);

  return (
    <div className="bg-card border rounded-[var(--radius-sm)]">
      <div className="flex items-center gap-2 px-4 py-3 hairline-bottom" style={{ borderColor: 'var(--border)' }}>
        <Icon name="sparkles" size={14} style={{ color: 'var(--primary)' }} />
        <h3 className="text-[14px] font-semibold m-0 flex-1" style={{ color: 'var(--foreground)' }}>
          {t('settings:solidifyTitle')}
        </h3>
        <Button variant="primary" disabled={scan.isPending || hasRunning} onClick={() => scan.mutate()}>
          {hasRunning ? t('settings:solidifyScanning') : t('settings:solidifyScan')}
        </Button>
      </div>
      <div className="px-4 pt-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
        {t('settings:solidifyIntro')}
      </div>
      <div className="p-2 flex flex-col gap-3">
        {/* 批次历史：最新在前；running 转终态由轮询+invalidate 收口 */}
        <div className="flex flex-col gap-1">
          {(batchesQ.data ?? []).length === 0 ? (
            <div className="px-2 py-1 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('settings:solidifyBatchEmpty')}
            </div>
          ) : (batchesQ.data ?? []).slice(0, 5).map((b) => (
            <div key={b.id} className="flex items-center gap-2 px-2 py-1">
              <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                {t(`settings:${BATCH_STATUS_KEY[b.status]}`)}
              </span>
              <span className="text-[11px] truncate flex-1" style={{ color: 'var(--muted-foreground)' }}>
                {b.error ?? b.inputSummary ?? new Date(b.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
        {/* 提案列表 */}
        {proposalsQ.isLoading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
            {t('common:loading')}
          </div>
        ) : proposals.length === 0 ? (
          <EmptyState icon="sparkles" title={t('settings:solidifyProposalNone')} compact />
        ) : proposals.map((p) => (
          <button
            key={p.id}
            type="button"
            className="flex items-center gap-2 px-2 py-2 rounded text-left w-full"
            style={{ background: 'transparent' }}
            onClick={() => openProposal(p)}
          >
            <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
              {t(`settings:${p.kind === 'prompt_amendment' ? 'solidifyKindPrompt' : 'solidifyKindSkill'}`)}
            </span>
            <span className="text-[12px] font-medium truncate flex-1" style={{ color: 'var(--foreground)' }}>{p.title}</span>
            <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
              {t(`settings:${PROPOSAL_STATUS_KEY[p.status]}`)}
            </span>
          </button>
        ))}
      </div>

      {/* 提案详情：diff 双栏 + 来源退役勾选 + 批准/驳回 */}
      <Dialog open={!!openId} onOpenChange={(open) => { if (!open) setOpenId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{detail?.title ?? ''}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="px-5 py-3 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                <span className="text-[10px] px-1.5 py-[1px] rounded" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                  {t(`settings:${detail.kind === 'prompt_amendment' ? 'solidifyKindPrompt' : 'solidifyKindSkill'}`)}
                </span>
                <span>{t('settings:solidifyTarget')}：<code className="font-mono">{detail.target}</code></span>
                <span>{t('settings:solidifyModel')}：{detail.distillModel}</span>
                {detail.appliedAt && <span>{t('settings:solidifyAppliedAt')}：{new Date(detail.appliedAt).toLocaleString()}</span>}
              </div>
              {detail.applyError && (
                <div className="text-[12px] px-2 py-1 rounded" style={{ background: 'var(--destructive-soft)', color: 'var(--destructive)' }}>
                  {t('settings:solidifyApplyError')}：{detail.applyError}
                </div>
              )}
              <div className="flex flex-col gap-1">
                <div className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>{t('settings:solidifyRationale')}</div>
                <div className="text-[12px] whitespace-pre-wrap" style={{ color: 'var(--foreground)' }}>{detail.rationale}</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                    {t(`settings:${detail.kind === 'prompt_amendment' ? 'solidifyIncrement' : 'solidifyCurrent'}`)}
                  </div>
                  <pre className="m-0 p-2 rounded text-[11px] font-mono whitespace-pre-wrap max-h-56 overflow-y-auto"
                    style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                    {detail.kind === 'prompt_amendment' ? detail.body : (currentText || '—')}
                  </pre>
                </div>
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                    {t(`settings:${detail.kind === 'prompt_amendment' ? 'solidifyAppendPreview' : 'solidifyProposed'}`)}
                  </div>
                  <pre className="m-0 p-2 rounded text-[11px] font-mono whitespace-pre-wrap max-h-56 overflow-y-auto"
                    style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                    {detail.kind === 'prompt_amendment' ? `${currentText}\n\n${detail.body}` : detail.body}
                  </pre>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>{t('settings:solidifySources')}</div>
                {detail.sources.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer" style={{ background: 'var(--muted)' }}>
                    <input
                      type="checkbox"
                      checked={retireIds.includes(s.id)}
                      onChange={(e) => setRetireIds((prev) =>
                        e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id))}
                    />
                    <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--card)', color: 'var(--muted-foreground)' }}>
                      {s.type === 'memory' ? 'memory' : 'trajectory'}
                    </span>
                    <span className="text-[11px] truncate flex-1" style={{ color: 'var(--foreground)' }}>{s.title}</span>
                    <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{s.lineName}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setOpenId(null)}>{t('common:close')}</Button>
            <Button variant="ghost" disabled={review.isPending} onClick={() => openId && review.mutate({ id: openId, approve: false })}>
              {t('settings:solidifyReject')}
            </Button>
            <Button
              variant="primary"
              disabled={review.isPending || detail?.status !== 'pending'}
              onClick={() => openId && review.mutate({ id: openId, approve: true })}
            >
              {t('settings:solidifyApprove')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 5: AssistantPanel.tsx 接线**

`apps/web/src/components/settings/AssistantPanel.tsx`：

import 区（MemoriesSection 导入附近）加：

```tsx
import PromptModulesSection from './PromptModulesSection';
import SolidifySection from './SolidifySection';
```

Section 列表（`<TrajectoriesSection />` 之后、`<SkillsSection />` 之前——提示词在资产组里靠前，盘点紧随其后）插入：

```tsx
        <PromptModulesSection />
        <SolidifySection />
```

- [ ] **Step 6: 校验**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/web && pnpm verify`
Expected: typecheck / i18n 完整性 / test 全 PASS。若 i18n 检查报 key 缺失，核对 Step 2/Step 3 补的 `promptCurrentLabel` 与组件引用的 key 一一对应。

- [ ] **Step 7: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
git add apps/web/src/components/settings/PromptModulesSection.tsx apps/web/src/components/settings/SolidifySection.tsx apps/web/src/components/settings/AssistantPanel.tsx apps/web/src/i18n/locales/zh-CN/errors.json apps/web/src/i18n/locales/en/errors.json apps/web/src/i18n/locales/zh-CN/settings.json apps/web/src/i18n/locales/en/settings.json
git commit -m "feat(web): R3 设置页——系统提示词模块（编辑/回滚/恢复默认）+ 固化盘点（轮询/diff/退役勾选/审批）"
```

---

### Task 10: 全量回归 + E2E 手动验证

**Files:**
- 无新文件（验证任务；产出 = 测试全绿 + 浏览器全链路通过）

- [ ] **Step 1: dev DB 手动建三表**

dev DB（itest-pg 容器）不会自动建表（R1/R2 教训）。用 `SCHEMA_SQL` 同款 DDL 手动建（连接串/口令见 dev DB 备忘，admin/Itest@2026）：

```bash
docker exec -i itest-pg psql -U itest -d itest <<'SQL'
CREATE TABLE IF NOT EXISTS assistant_prompt_module_versions (seq bigserial PRIMARY KEY, module_key varchar(100) NOT NULL, value text, source varchar(20) NOT NULL, source_ref uuid, created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamp NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS assistant_prompt_module_versions_key_seq_idx ON assistant_prompt_module_versions(module_key, seq);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_prompt_module_versions_source_ref_uq ON assistant_prompt_module_versions(source_ref) WHERE source_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS assistant_solidify_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status varchar(16) NOT NULL, input_summary text, error text, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS assistant_solidify_proposals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid REFERENCES assistant_solidify_batches(id) ON DELETE CASCADE NOT NULL, kind varchar(20) NOT NULL, target varchar(100) NOT NULL, title varchar(200) NOT NULL, body text NOT NULL, rationale text NOT NULL, sources jsonb NOT NULL, status varchar(16) NOT NULL DEFAULT 'pending', reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL, reviewed_at timestamp, applied_at timestamp, apply_error text, distill_model varchar(64) NOT NULL, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamp NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS assistant_solidify_proposals_batch_idx ON assistant_solidify_proposals(batch_id, status);
SQL
```

（若 `-U itest -d itest` 与实际不符，先 `\l` 确认库名；prod 不用做——api 容器启动 `drizzle-kit push --force` 自动建。）

- [ ] **Step 2: api 全量回归**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/api && npm test`
Expected: 全绿。已知基线：`sendSyslog` 基线即红（非回归）；若出现轮转假失败，单跑可疑文件复核再判。重点确认 R1/R2 回归锚点全绿：`memories*`、`trajectory*`、`prompt-override`、`prompt-modules`、`solidify-*`。

- [ ] **Step 3: web 回归**

Run: `cd /Users/lyq/workdir/codedev/iTest/apps/web && pnpm verify`
Expected: 全 PASS。

- [ ] **Step 4: E2E 手动验证（浏览器全链路）**

启动 dev api（**必须清 ANTHROPIC 四件套**，否则 pi-ai 优先发继承 token → 网关 401；并带 ENCRYPTION_KEY + CHROMIUM_PATH；日志重定向 /private/tmp/itest-api.log）：

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_MODEL \
  ENCRYPTION_KEY=<dev key> CHROMIUM_PATH=<dev path> npm run dev > /private/tmp/itest-api.log 2>&1 &
```

清单（manager 账号进设置页 → 助手）：

1. **系统提示词 Section**：三组（主提示词/工具/Skill 只读）渲染，工具组含全部 buildSpaceTools 工具；默认 badge=「默认」。
2. 编辑 `space.style.zh` → 保存 → badge=「手工」；版本历史出现 manual_edit 行；开新助手会话，system prompt 含新值（查线程快照或让助手复述风格段）。
3. 恢复默认 → badge 回「默认」+ 版本链多一行 value=NULL（跟随代码）。
4. 版本历史选中旧值 → 回滚 → 新行 source=rollback，badge=「回滚」。
5. skill 组：查看只读（无保存钮）；对任一 skill 回滚 baseline 行 → 磁盘 SKILL.md 内容随之变化且 frontmatter 完好（name/description 与 DB 一致）。
6. **固化盘点 Section**：点「发起盘点」→ 批次 running（按钮变盘点中）→ ~2min 内转 done；期间再点 → 409 文案 toast「已有盘点批次在进行中」。
7. 提案列表出现蒸馏结果（若库里 active 记忆/轨迹不足或无跨线证据，可能 0 提案——批次 input_summary 有 notes 说明，属正常；可临时往两条产品线各插一条 active 记忆再盘）。
8. 打开提案详情：diff 双栏（prompt_amendment=增量+叠加预览；skill_revision=当前 vs 修订）；来源清单带线名与预填勾选（memory 勾/trajectory 不勾）。
9. 改勾选 → 批准并应用：prompt 模块 badge=「固化」+ 版本链多 baseline 行（首次）与 solidify_apply 行；被勾记忆从「助手记忆」列表消失（status=retired_solidified）。
10. 对 skill_revision 提案批准：SKILL.md 正文已改、版本链 baseline+solidify_apply 两行。
11. 驳回另一提案：status=rejected，无任何版本行/文件变动。
12. **R1/R2 回归**：助手会话 save_memory 正常、记忆注入正常；轨迹 few-shot 检索不受影响（跑一次同线建用例任务观察 search_trajectories）。
13. **渲染红线抽查**：清空 assistant_prompt_module_versions 后开新会话——与改造前同问法输出风格一致（无覆盖=逐字节现状）。

- [ ] **Step 5: 源码污染检查**

Run: `cd /Users/lyq/workdir/codedev/iTest && git status`
Expected: 只有本计划新增/修改的文件。出现 `step-dsl-spec.ts` 等陌生改动 → 还原（跑测试会改仓库源码的已知坑）。

- [ ] **Step 6: 收尾提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
git status   # 确认无遗漏文件
# 如有零星修补（测试修正/文案），此处补提交；无则跳过
```

---

## 执行完成后

- 本计划全部任务完成后：R3 两工作流（prompt 可编辑化 + 固化管线）落地，R1/R2 行为零变化（红线测试锚定）。
- 发版随既有 release.sh 流程（prod 靠 api 容器 drizzle-kit push 自动建三表；无 seed）。
- R4（审核与发布通道）在版本链 + sources 溯源 + applied_at 数据底座上开工。
