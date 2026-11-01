# R3.5 失败教训蒸馏 + prompt_correction 实施计划

日期：2026-11-01 · 状态：待实施
Spec：`docs/superpowers/specs/2026-11-01-assistant-failure-lesson-distill-design.md`
前置：R3 固化管线已落 main 并发 prod228（65504da 批次）。

## For agentic workers

- 逐任务 TDD：先写失败测试 → 跑红 → 实现 → 跑绿 → 提交。每个任务独立可交付，按序执行（1→9 有依赖）。
- 跑单测：`cd apps/api && npx vitest run test/<file>.test.ts`（testcontainers 首启较慢，超时 60s 已内建）。
- 跑全量：`cd apps/api && npm test`（sendSyslog 基线即红是已知噪声，非回归）。
- Web 校验：`cd apps/web && pnpm verify`（typecheck + build）。
- **收尾必查 `git status`**：api 测试可能污染仓库源码（反引号写进模板字面量），陌生改动先还原（历史教训见 memory）。
- 每个 checkbox 完成后打钩；提交信息已在各任务末尾给出。

## Goal

R3 盘点只蒸馏「什么有效」，结构上发现不了「提示词哪里错了」。R3.5 加一层失败教训蒸馏：

```
S1 prompt 回滚/恢复默认（既有表直查）──┐
S2 负向 ai_assistant_feedback（既有表）─┼─→ 信号蒸馏(LLM call #1) ─→ assistant_failure_lessons
S3 verify nlAiFail 分流信号（新表）  ──┘         （逐条归因：prompt/step_description/
                                                              platform/sut）
                                                          │ 仅 prompt/step_description
R1 记忆(active) ──┐                                       │
R2 轨迹(active) ──┼─→ 资产蒸馏(LLM call #2, R3 既有) ─→ 提案 ─→ 人工审批 ─→ 应用
教训(active,提示词侧) ┘         ↑ kind 扩 prompt_correction        │
                                                                  └→ 教训置 resolved
```

红线：**零信号时扫描行为与 R3 等价**——call#1 不发生、call#2 输入不含【失败教训】节、R3 既有测试全绿（input_summary 统一扩 `lessons`/`signals` 键，零值）。

## Tech Stack

- api：Express + drizzle-orm + zod + vitest + testcontainers（postgres:16-alpine）
- web：React + react-query + nuqs + i18next（settings 命名空间）
- LLM：`completeJson(client, {systemPrompt, userMessage})`（与 R3 同一客户端）

## 关键背景（实现前必读）

1. **红线口径（规划期收紧）**：spec §9「零信号扫描输出与 R3 逐字节一致」落成可测试断言 = (a) call#1 不发生（LLM 调用序列长度=1）；(b) call#2 入参不含「失败教训」字样；(c) R3 既有测试全绿。input_summary 按 spec §5.3 **统一扩键** `{memories, trajectories, lessons, signals, proposals, notes}`（零信号时 lessons=0/signals=0），前端 batchSummary 对缺失键回 0 向后兼容老批次——新批次统一 6 键形状。
2. **空输入早退条件收紧**：R3 早退条件 `merged.length===0` 扩为 `merged.length===0 && signals===0`。有信号但资产池为空时照跑三阶段（教训可独立产出 prompt_correction，不依赖资产池）。
3. **信号一次性消费（规划期收紧）**：spec §3.2「未被任何 active 教训引用」收紧为「未被任何**任意 status** 教训引用」。Why：retire/resolved 教训的信号若复活，会再喂→再蒸馏→人工再驳回的死循环；spec 的核心不变量「一条信号最多蒸馏进一条教训」本就不分 status。
4. **call#1 失败降级**：教训蒸馏（LLM call #1）整体失败（超时/输出不合法）→ 批次**不炸**：notes 记「教训蒸馏失败（信号保留待下次盘点重试）」，阶段 2 照常执行。单条教训不合法只丢弃该条（R3 同款）。教训是增量资产，不是批次产出物，失败代价只是「这次没蒸馏成」。
5. **import 环**：`failureLessons.ts` 被 `solidifyService.ts` import，因此 failureLessons **不能**反向 import solidifyService——`withLlmTimeout` 在 failureLessons 内自带一份副本（R3 注释先例：「不共享是为免 import 环」）。
6. **baseSeq 服务端定值**：盘点时查 `loadPromptModuleOverrides().get(target)?.seq ?? null` 填入，**不信任 LLM**。apply 时同源复查，不等 → throw「模块已被人工修改，请重新盘点」→ 走既有 catch 路径（status 回 pending + apply_error + 500）。
7. **测试 stub 用顺序计数**，不用 systemPrompt 内容分发：`completeJson` 内部如何调 `client.complete` 形状未验证，stub 以「第 N 次调用」回放不同 value，并把每次入参 push 进数组供断言（断言用 `JSON.stringify(req)` 子串匹配，形状无关）。call#2 需要引用 call#1 产出的教训 id → 允许 values 元素是函数，运行时从上一次调用入参提取。
8. **prompt_correction 的 target 校验复用 promptKeySet**：`promptKeys = defs.filter(group !== 'skill')`，`skill.*` 天然不在集合内——「target=skill.* 拒绝」不需要额外代码。
9. **platform/sut 归因教训只入库不产提案**：蒸馏 prompt 写死判据 + `listProposalInputLessons` 只取 `attribution IN ('prompt','step_description')` 双重闸。
10. **dev DB 不自动建表**：新表须手动 psql 建（SCHEMA_SQL 在 `apps/api/test/helpers/db.ts`）；prod 随 api 容器启动 drizzle-kit push --force 自动应用。
11. **非目标（YAGNI）**：不做全量失败会话挖掘、不做用户答复回填、不做教训聚类去重、不做自动定期盘点、不做 skill_revision 的 baseSeq 防护（独立 backlog）。

## File Structure

```
apps/api/src/db/schema.ts                          # 改：+assistant_failure_signals +assistant_failure_lessons +proposals.base_seq
apps/api/test/helpers/db.ts                        # 改：SCHEMA_SQL 追加两表 DDL + ALTER
apps/api/test/failure-schema.test.ts               # 新：建表/部分唯一/默认值
apps/api/src/pi/space/failureSignals.ts            # 新：recordNlAiFailSignal（fire-and-forget 采集）
apps/api/src/pi/space/tools/verifyCase.ts          # 改：nlAiFail 分支 void 调用落信号
apps/api/test/failure-signals.test.ts              # 新：落库/去重/失败不打断
apps/api/src/pi/space/failureLessons.ts            # 新：信号查询聚合 + 教训蒸馏 + 提案输入查询
apps/api/test/failure-lessons.test.ts              # 新：S1/S2/S3 聚合/消费幂等/蒸馏校验/blocked 教训
apps/api/src/pi/space/solidifyService.ts           # 改：三阶段接线 + prompt 扩 kind + baseSeq
apps/api/test/solidify-service.test.ts             # 改：sequentialStub + R3.5 用例 + TRUNCATE 扩表
apps/api/src/pi/space/solidifyApply.ts             # 改：applyPromptCorrection + resolveLessons + 分派
apps/api/test/solidify-apply.test.ts               # 改：correction 应用/冲突/重放/skill 拒绝
apps/api/src/pi/space/failureLessonsRoute.ts       # 新：GET 列表 + POST retire
apps/api/src/pi/space/router.ts                    # 改：挂载 /failure-lessons（requireManager）
apps/api/test/failure-lessons-route.test.ts        # 新：路由/权限/404
apps/web/src/api/client.ts                         # 改：类型 + failureLessons API 组
apps/web/src/components/settings/SolidifySection.tsx  # 改：3-kind badge/lesson 来源行/教训块/summary
apps/web/src/i18n/...                              # 改：settings 命名空间 zh/en 新键
```

---

## Task 1：DB schema（两新表 + proposals.base_seq）

- [x] 1.1 `apps/api/src/db/schema.ts`：在 `assistant_solidify_proposals` 定义之后（`}));` 之后、`// ── AI 助手用户反馈` 注释之前）插入两表；并给 proposals 表加 `baseSeq` 列（放 `applyError` 之后）：

```ts
  /** 仅 prompt_correction 用：盘点时定格 target 模块当前 max(seq)。apply 时检测人工修改（防静默 clobber）。 */
  baseSeq: integer('base_seq'),
```

```ts
// ── R3.5 失败教训蒸馏：原始失败信号（采集层，零 LLM）──
// verify nlAiFail 分流等结构化失败证据在此落行；教训蒸馏（盘点时）只消费未被引用的信号。
// threadId 无 FK：审计数据惯例（同 ai_assistant_feedback），不随 version 删除 cascade 消失。
export const assistantFailureSignals = pgTable('assistant_failure_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** v1 仅 'nl_ai_fail'（verify 自然语言步 AI 相失败分流）；后续信号类型同表扩展。 */
  type: varchar('type', { length: 20 }).notNull(),
  threadId: uuid('thread_id').notNull(),
  /** verify 的 caseId 可能是 staged 草稿 localId（非 uuid），按 varchar 64 对齐。 */
  caseId: varchar('case_id', { length: 64 }).notNull(),
  stepOrder: integer('step_order').notNull(),
  /** 信号来源线（教训层不做线隔离，审批展示/排查需要来源）。 */
  productLineId: uuid('product_line_id').references(() => productLines.id, { onDelete: 'set null' }),
  /** {caseTitle, stepInstruction, failureReason, targetUrl, pageUrl}——快照自包含，线程不可溯仍可读。 */
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  // 同一 (线程, 用例, 步) 只落一条：同轮重跑同一步失败不重复（写入侧 onConflictDoNothing）
  stepUq: uniqueIndex('assistant_failure_signals_step_uq').on(t.threadId, t.caseId, t.stepOrder)
    .where(sql`${t.type} = 'nl_ai_fail'`),
  createdIdx: index('assistant_failure_signals_created_idx').on(t.createdAt),
}));

// ── R3.5 失败教训蒸馏：教训（蒸馏层，盘点时 LLM call#1 产物）──
// platform/sut 归因的教训只入库（R5 平台/SUT 改进素材），严禁变成提示词补丁；
// 仅 prompt/step_description 归因进入资产蒸馏输入。
export const assistantFailureLessons = pgTable('assistant_failure_lessons', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** active | resolved（correction 提案应用后自动置）| retired（人工驳回：误报/过时/不修）。 */
  status: varchar('status', { length: 16 }).notNull().default('active'),
  /** prompt | step_description | platform | sut——LLM 蒸馏判定，误判由人工审批兜底。 */
  attribution: varchar('attribution', { length: 20 }).notNull(),
  /** 人话教训名（「guide 断言未限定实测范围导致泛化出自动登录」级颗粒度）。 */
  title: varchar('title', { length: 200 }).notNull(),
  /** 结构化正文：现象 → 根因 → 影响面 → 建议修正方向（蒸馏 prompt 规定段落）。 */
  lesson: text('lesson').notNull(),
  /** [{type, refId, excerpt}]——证据溯源 + 信号消费幂等的记账依据。 */
  signals: jsonb('signals').notNull(),
  /** 置 resolved 时记录是哪个修正提案。 */
  resolvedByProposal: uuid('resolved_by_proposal'),
  distillModel: varchar('distill_model', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  statusIdx: index('assistant_failure_lessons_status_idx').on(t.status, t.createdAt),
}));
```

（确认 `sql` 已在 schema.ts import；`integer` 若未 import 一并补。）

- [x] 1.2 `apps/api/test/helpers/db.ts`：SCHEMA_SQL 模板串末尾（`assistant_solidify_proposals_batch_idx` 行之后、闭合反引号之前）追加：

```sql
-- R3.5 失败教训蒸馏：原始失败信号 + 教训
CREATE TABLE assistant_failure_signals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type varchar(20) NOT NULL, thread_id uuid NOT NULL, case_id varchar(64) NOT NULL, step_order integer NOT NULL, product_line_id uuid REFERENCES product_lines(id) ON DELETE SET NULL, payload jsonb NOT NULL, created_at timestamp NOT NULL DEFAULT now());
CREATE UNIQUE INDEX assistant_failure_signals_step_uq ON assistant_failure_signals(thread_id, case_id, step_order) WHERE type = 'nl_ai_fail';
CREATE INDEX assistant_failure_signals_created_idx ON assistant_failure_signals(created_at);
CREATE TABLE assistant_failure_lessons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status varchar(16) NOT NULL DEFAULT 'active', attribution varchar(20) NOT NULL, title varchar(200) NOT NULL, lesson text NOT NULL, signals jsonb NOT NULL, resolved_by_proposal uuid, distill_model varchar(64) NOT NULL, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE INDEX assistant_failure_lessons_status_idx ON assistant_failure_lessons(status, created_at);
ALTER TABLE assistant_solidify_proposals ADD COLUMN base_seq integer;
```

- [x] 1.3 写测试 `apps/api/test/failure-schema.test.ts`（先跑红——列不存在）：

```ts
/** R3.5 建表：部分唯一去重 / 默认值 / base_seq 可空。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('assistant_failure_signals', () => {
  it('同 (thread,case,step) 且 type=nl_ai_fail 去重；不同 type 不受限', async () => {
    const t = randomUUID();
    const ins = () => pool.query(
      `INSERT INTO assistant_failure_signals (type, thread_id, case_id, step_order, payload) VALUES ('nl_ai_fail', $1, 'c1', 3, '{}')`, [t]);
    await ins();
    await expect(ins()).rejects.toThrow(); // 部分唯一索引拒绝
    // 其他类型同键不冲突
    await pool.query(
      `INSERT INTO assistant_failure_signals (type, thread_id, case_id, step_order, payload) VALUES ('other', $1, 'c1', 3, '{}')`, [t]);
  });

  it('product_line_id 可空；payload jsonb 自包含', async () => {
    const r = await pool.query(
      `INSERT INTO assistant_failure_signals (type, thread_id, case_id, step_order, payload) VALUES ('nl_ai_fail', $1, 'c2', 1, $2::jsonb) RETURNING product_line_id, payload`,
      [randomUUID(), JSON.stringify({ caseTitle: 't', failureReason: 'AiTaskAborted' })]);
    expect(r.rows[0]!.product_line_id).toBeNull();
    expect(r.rows[0]!.payload).toMatchObject({ failureReason: 'AiTaskAborted' });
  });
});

describe('assistant_failure_lessons', () => {
  it('status 默认 active；attribution/title/signals 必填', async () => {
    const r = await pool.query(
      `INSERT INTO assistant_failure_lessons (attribution, title, lesson, signals, distill_model) VALUES ('prompt', 't', 'l', $1::jsonb, 'm') RETURNING status`,
      [JSON.stringify([{ type: 'rollback', refId: '2', excerpt: 'e' }])]);
    expect(r.rows[0]!.status).toBe('active');
    await expect(pool.query(
      `INSERT INTO assistant_failure_lessons (title, lesson, signals, distill_model) VALUES ('t', 'l', '[]', 'm')`,
    )).rejects.toThrow(); // attribution NOT NULL
  });
});

describe('assistant_solidify_proposals.base_seq', () => {
  it('新列可空，老批次语义不变', async () => {
    const b = (await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('done') RETURNING id`)).rows[0]!.id as string;
    const p = await pool.query(
      `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, distill_model)
       VALUES ($1, 'prompt_amendment', 'k', 't', 'b', 'r', '[]', 'm') RETURNING base_seq`, [b]);
    expect(p.rows[0]!.base_seq).toBeNull();
  });
});
```

- [x] 1.4 dev DB 手动建表（**本任务就要做**，后续任务的本地测试才连得上 dev 库——虽然单测走 testcontainers 不依赖 dev 库，但 dev api 跑起来需要）：

```bash
docker exec -i itest-pg psql -U postgres -d itest <<'SQL'
CREATE TABLE IF NOT EXISTS assistant_failure_signals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type varchar(20) NOT NULL, thread_id uuid NOT NULL, case_id varchar(64) NOT NULL, step_order integer NOT NULL, product_line_id uuid REFERENCES product_lines(id) ON DELETE SET NULL, payload jsonb NOT NULL, created_at timestamp NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS assistant_failure_signals_step_uq ON assistant_failure_signals(thread_id, case_id, step_order) WHERE type = 'nl_ai_fail';
CREATE INDEX IF NOT EXISTS assistant_failure_signals_created_idx ON assistant_failure_signals(created_at);
CREATE TABLE IF NOT EXISTS assistant_failure_lessons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status varchar(16) NOT NULL DEFAULT 'active', attribution varchar(20) NOT NULL, title varchar(200) NOT NULL, lesson text NOT NULL, signals jsonb NOT NULL, resolved_by_proposal uuid, distill_model varchar(64) NOT NULL, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS assistant_failure_lessons_status_idx ON assistant_failure_lessons(status, created_at);
ALTER TABLE assistant_solidify_proposals ADD COLUMN IF NOT EXISTS base_seq integer;
SQL
```

- [x] 1.5 `cd apps/api && npx vitest run test/failure-schema.test.ts` 绿。
- [x] 1.6 提交：

```
feat(space): R3.5 两张新表——失败信号采集层(部分唯一去重)+教训蒸馏层,proposals 扩 base_seq
```

## Task 2：failureSignals.ts + verifyCase 接线

- [x] 2.1 写测试 `apps/api/test/failure-signals.test.ts`：

```ts
/** 失败信号采集：落库带线归并/同键去重/INSERT 失败不打断（fire-and-forget 语义）。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

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
  await pool.query(`TRUNCATE assistant_failure_signals`);
});

describe('recordNlAiFailSignal', () => {
  it('落行：productLine 由 project 反查，payload 快照自包含', async () => {
    const { recordNlAiFailSignal } = await import('../src/pi/space/failureSignals.js');
    const { projectId, productLineId } = await seedProject(pool);
    await recordNlAiFailSignal({
      threadId: randomUUID(), projectId, caseId: 'local-1', stepOrder: 4,
      payload: { caseTitle: '事件管理用例', stepInstruction: '点击新增按钮', failureReason: 'AiTaskAborted', targetUrl: 'http://x/a', pageUrl: 'http://x/b' },
    });
    const r = (await pool.query(`SELECT * FROM assistant_failure_signals`)).rows[0]!;
    expect(r.type).toBe('nl_ai_fail');
    expect(r.product_line_id).toBe(productLineId);
    expect(r.case_id).toBe('local-1');
    expect(r.step_order).toBe(4);
    expect(r.payload).toMatchObject({ failureReason: 'AiTaskAborted', stepInstruction: '点击新增按钮' });
  });

  it('同 (thread,case,step) 重复落 → 静默去重（onConflictDoNothing）', async () => {
    const { recordNlAiFailSignal } = await import('../src/pi/space/failureSignals.js');
    const { projectId } = await seedProject(pool);
    const threadId = randomUUID();
    const input = { threadId, projectId, caseId: 'c', stepOrder: 1, payload: { failureReason: 'x' } };
    await recordNlAiFailSignal(input);
    await recordNlAiFailSignal(input);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_failure_signals`)).rows[0]!;
    expect(n.n).toBe(1);
  });

  it('INSERT 失败只 warn 不 throw（verify 主流程不受影响）', async () => {
    const { recordNlAiFailSignal } = await import('../src/pi/space/failureSignals.js');
    await pool.query(`ALTER TABLE assistant_failure_signals RENAME TO assistant_failure_signals_bak`);
    try {
      await expect(recordNlAiFailSignal({
        threadId: randomUUID(), projectId: randomUUID(), caseId: 'c', stepOrder: 1, payload: {},
      })).resolves.toBeUndefined(); // 不抛
    } finally {
      await pool.query(`ALTER TABLE assistant_failure_signals_bak RENAME TO assistant_failure_signals`);
    }
  });
});
```

- [x] 2.2 跑红：`npx vitest run test/failure-signals.test.ts`（模块不存在）。
- [x] 2.3 实现 `apps/api/src/pi/space/failureSignals.ts`：

```ts
/**
 * R3.5 失败信号采集（零 LLM）：verify nlAiFail 分流时落一行原始信号。
 * fire-and-forget：INSERT 失败只 warn，绝不影响 verify 主流程（对齐蒸馏 worker 语义）。
 */
import { eq } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { db } from '../../db/client.js';
import { assistantFailureSignals, projects } from '../../db/schema.js';

export interface NlAiFailSignalPayload {
  caseTitle: string;
  stepInstruction: string;
  failureReason: string;
  targetUrl: string | null;
  pageUrl: string | null;
}

/** 落一条 nl_ai_fail 信号；productLine 由 project 反查（教训层不做线隔离，仅供审批展示）。 */
export async function recordNlAiFailSignal(input: {
  threadId: string;
  projectId: string;
  caseId: string;
  stepOrder: number;
  payload: NlAiFailSignalPayload;
}): Promise<void> {
  try {
    const project = (await db.select({ productLineId: projects.productLineId }).from(projects)
      .where(eq(projects.id, input.projectId)).limit(1))[0];
    await db.insert(assistantFailureSignals).values({
      type: 'nl_ai_fail',
      threadId: input.threadId,
      caseId: input.caseId,
      stepOrder: input.stepOrder,
      productLineId: project?.productLineId ?? null,
      payload: input.payload,
    }).onConflictDoNothing();
  } catch (e) {
    logger.warn({ err: e }, 'failureSignals: record nl_ai_fail signal failed');
  }
}
```

- [x] 2.4 verifyCase 接线：`apps/api/src/pi/space/tools/verifyCase.ts`
  - import 区加：`import { recordNlAiFailSignal } from '../failureSignals.js';`
  - 在 nlAiFail 判定（`const nlAiFail = ...` 结束处，约 :1497）之后插入：

```ts
          if (nlAiFail) {
            // R3.5：落一条原始失败信号（fire-and-forget，失败只 warn 不影响 verify）
            void recordNlAiFailSignal({
              threadId: ctx.threadId, projectId: ctx.projectId, caseId, stepOrder: failed.order,
              payload: {
                caseTitle: effectiveCase.title,
                stepInstruction: failedStep.instruction ?? '',
                failureReason: failed.failureReason ?? 'unknown',
                targetUrl: targetUrl ?? null,
                pageUrl: page.url(),
              },
            });
          }
```

  （`ctx.threadId`/`ctx.projectId`/`caseId`/`failed.order`/`failedStep`/`effectiveCase`/`targetUrl`/`page` 在该作用域均已在——rdata 构造处同样引用。若 `ctx.projectId` 实际取名不同，以 :637 `expectedProjectId: ctx.projectId` 为准核对。）

- [x] 2.5 回归：`npx vitest run test/failure-signals.test.ts test/pi-verify-case.test.ts` 全绿（接线不得破坏 verify 既有行为）。
- [x] 2.6 提交：

```
feat(space): R3.5 nlAiFail 分流信号落库——fire-and-forget INSERT+同键去重,verify 主流程零打扰
```

## Task 3：failureLessons.ts（信号聚合 + 教训蒸馏 + 提案输入查询）

- [x] 3.1 写测试 `apps/api/test/failure-lessons.test.ts`：

```ts
/** R3.5 蒸馏层：S1/S2/S3 信号聚合与消费幂等/教训蒸馏校验/提案输入过滤。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

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
  await pool.query(`TRUNCATE assistant_failure_signals, assistant_failure_lessons, assistant_solidify_proposals, assistant_solidify_batches, assistant_prompt_module_versions, ai_assistant_feedback`);
});

/** 顺序计数 stub：按调用次序回放 value；记录每次入参（形状无关断言用 JSON.stringify）。 */
function sequentialStub(values: Array<unknown | ((prevReq: unknown) => unknown)>) {
  let i = 0;
  const calls: unknown[] = [];
  return {
    provider: 'openai' as const,
    calls,
    complete: async (req: unknown) => {
      calls.push(req);
      const raw = values[Math.min(i, values.length - 1)];
      const v = typeof raw === 'function' ? (raw as (r: unknown) => unknown)(calls[calls.length - 2] ?? req) : raw;
      i += 1;
      return { kind: 'json' as const, value: v, provider: 'openai' as const, vision: false, model: 'stub-model' };
    },
  };
}

async function seedRollback(moduleKey: string, badValue: string, source: 'rollback' | 'manual_edit', newValue: string | null): Promise<number> {
  const bad = (await pool.query(
    `INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ($1, $2, 'baseline') RETURNING seq`,
    [moduleKey, badValue])).rows[0]!.seq as number;
  const rolled = (await pool.query(
    `INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ($1, $2, $3) RETURNING seq`,
    [moduleKey, newValue, source])).rows[0]!.seq as number;
  return rolled;
}

describe('collectUnconsumedSignals', () => {
  it('S1：回滚行→信号（refId=seq，excerpt 含被放弃文案与现值）；restore_default 同理', async () => {
    const { collectUnconsumedSignals } = await import('../src/pi/space/failureLessons.js');
    const seq1 = await seedRollback('space.style.zh', '断言未限定实测范围的旧表述', 'rollback', '修正后的值');
    const seq2 = await seedRollback('tool.t1.guidelines', '旧指引', 'manual_edit', null);
    const { signals } = await collectUnconsumedSignals();
    const s1 = signals.find((s) => s.refId === String(seq1))!;
    expect(s1.type).toBe('rollback');
    expect(s1.key).toBe(`rollback#${seq1}`);
    expect(s1.excerpt).toContain('断言未限定实测范围的旧表述');
    expect(s1.excerpt).toContain('修正后的值');
    const s2 = signals.find((s) => s.refId === String(seq2))!;
    expect(s2.type).toBe('restore_default');
  });

  it('S1 selfSolidify：被回滚行 source=solidify_apply → 旗标置位（R3 自身输出质量反馈）', async () => {
    const { collectUnconsumedSignals } = await import('../src/pi/space/failureLessons.js');
    await pool.query(
      `INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '固化产出的坏文案', 'baseline')`);
    await pool.query(
      `INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '固化产出的坏文案', 'solidify_apply')`);
    const rolled = (await pool.query(
      `INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '回退值', 'rollback') RETURNING seq`)).rows[0]!.seq as number;
    const { signals } = await collectUnconsumedSignals();
    const s = signals.find((x) => x.refId === String(rolled))!;
    expect(s.selfSolidify).toBe(true);
    expect(s.title).toContain('固化');
  });

  it('消费幂等：已被教训 signals 引用的 refId 不再出现（任意 status：retired 也不复活）', async () => {
    const { collectUnconsumedSignals } = await import('../src/pi/space/failureLessons.js');
    const seq = await seedRollback('space.style.zh', '坏', 'rollback', '好');
    await pool.query(
      `INSERT INTO assistant_failure_lessons (status, attribution, title, lesson, signals, distill_model)
       VALUES ('retired', 'prompt', 't', 'l', $1::jsonb, 'm')`,
      [JSON.stringify([{ type: 'rollback', refId: String(seq), excerpt: 'e' }])]);
    const { signals } = await collectUnconsumedSignals();
    expect(signals.find((s) => s.refId === String(seq))).toBeUndefined();
  });

  it('S2：负向反馈→信号带线名；S3：nl_ai_fail→信号带用例上下文', async () => {
    const { collectUnconsumedSignals } = await import('../src/pi/space/failureLessons.js');
    const { projectId, productLineId } = await seedProject(pool);
    await pool.query(
      `INSERT INTO ai_assistant_feedback (thread_id, version_id, project_id, sentiment, message_excerpt, comment)
       VALUES ($1, $2, $3, 'negative', 'AI 瞎说自动登录', '登录明明要自己配')`,
      [randomUUID(), randomUUID(), projectId]);
    await pool.query(
      `INSERT INTO assistant_failure_signals (type, thread_id, case_id, step_order, product_line_id, payload)
       VALUES ('nl_ai_fail', $1, 'case-9', 2, $2, $3::jsonb)`,
      [randomUUID(), productLineId, JSON.stringify({ caseTitle: ' SOC 用例', stepInstruction: '点击新增', failureReason: 'StepTimedOut', pageUrl: 'http://p' })]);
    const { signals } = await collectUnconsumedSignals();
    const s2 = signals.find((s) => s.type === 'negative_feedback')!;
    expect(s2.excerpt).toContain('AI 瞎说自动登录');
    expect(s2.excerpt).toContain('登录明明要自己配');
    const s3 = signals.find((s) => s.type === 'nl_ai_fail')!;
    expect(s3.refId).toBeTruthy();
    expect(s3.excerpt).toContain('点击新增');
  });

  it('cap 60：S1 优先保留，超量截断', async () => {
    const { collectUnconsumedSignals } = await import('../src/pi/space/failureLessons.js');
    const seq = await seedRollback('space.style.zh', '高精度信号', 'rollback', '好');
    for (let i = 0; i < 70; i++) {
      await pool.query(
        `INSERT INTO assistant_failure_signals (type, thread_id, case_id, step_order, payload) VALUES ('nl_ai_fail', $1, $2, 1, '{}')`,
        [randomUUID(), `c${i}`]);
    }
    const { signals, total } = await collectUnconsumedSignals();
    expect(signals).toHaveLength(60);
    expect(total).toBe(71);
    expect(signals.find((s) => s.refId === String(seq))).toBeTruthy(); // S1 没被截掉
  });
});

describe('distillLessons', () => {
  it('产出入库：attribution/title/lesson/signals(refId 溯源)/distillModel', async () => {
    const { collectUnconsumedSignals, distillLessons } = await import('../src/pi/space/failureLessons.js');
    const seq = await seedRollback('space.style.zh', '坏', 'rollback', '好');
    const { signals } = await collectUnconsumedSignals();
    const stub = sequentialStub([{
      lessons: [{ attribution: 'prompt', title: '断言表述未限定实测范围', lesson: '现象:…根因:…影响面:…建议:限定实测范围', signalRefs: [`rollback#${seq}`] }],
      notes: [],
    }]);
    const n = await distillLessons(stub as never, signals, 5_000);
    expect(n).toBe(1);
    const row = (await pool.query(`SELECT * FROM assistant_failure_lessons`)).rows[0]!;
    expect(row.attribution).toBe('prompt');
    expect(row.status).toBe('active');
    expect(row.signals[0]).toMatchObject({ type: 'rollback', refId: String(seq) });
    expect(row.distill_model).toBe('stub-model');
  });

  it('单条不合法丢弃不炸批次；signalRefs 全部无效的条丢弃；有效条保留', async () => {
    const { collectUnconsumedSignals, distillLessons } = await import('../src/pi/space/failureLessons.js');
    const seq = await seedRollback('space.style.zh', '坏', 'rollback', '好');
    const { signals } = await collectUnconsumedSignals();
    const stub = sequentialStub([{
      lessons: [
        { attribution: 'prompt', title: '好', lesson: 'l', signalRefs: [`rollback#${seq}`] },
        { attribution: 'prompt', title: 'refs 全无效', lesson: 'l', signalRefs: ['rollback#99999'] },
        { attribution: 'galaxy', title: '归因非法', lesson: 'l', signalRefs: [`rollback#${seq}`] },
      ],
      notes: [],
    }]);
    const n = await distillLessons(stub as never, signals, 5_000);
    expect(n).toBe(1);
    const titles = (await pool.query(`SELECT title FROM assistant_failure_lessons`)).rows;
    expect(titles.map((r) => r.title)).toEqual(['好']);
  });

  it('LLM 输出整体不合法 → throw（调用方降级处理）', async () => {
    const { distillLessons } = await import('../src/pi/space/failureLessons.js');
    const stub = sequentialStub([{ lessons: '不是数组' }]);
    await expect(distillLessons(stub as never, [], 5_000)).rejects.toThrow();
  });
});

describe('listProposalInputLessons', () => {
  async function seedLesson(attribution: string, title: string): Promise<string> {
    return (await pool.query(
      `INSERT INTO assistant_failure_lessons (attribution, title, lesson, signals, distill_model) VALUES ($1, $2, 'l', '[]', 'm') RETURNING id`,
      [attribution, title])).rows[0]!.id as string;
  }
  async function seedProposalWithLessonSource(lessonId: string, status: string): Promise<void> {
    const b = (await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('done') RETURNING id`)).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, status, distill_model)
       VALUES ($1, 'prompt_correction', 'space.style.zh', 't', 'b', 'r', $2::jsonb, $3, 'm')`,
      [b, JSON.stringify([{ type: 'lesson', id: lessonId, title: 'x', lineName: '', retireRecommended: false }]), status]);
  }

  it('只取 prompt/step_description 的 active；platform/sut 不进输入', async () => {
    const { listProposalInputLessons } = await import('../src/pi/space/failureLessons.js');
    await seedLesson('prompt', 'p');
    await seedLesson('step_description', 's');
    await seedLesson('platform', 'pf');
    await seedLesson('sut', 'su');
    const out = await listProposalInputLessons();
    expect(out.map((l) => l.title).sort()).toEqual(['p', 's']);
  });

  it('被 pending/approved 提案引用的教训 blocked；rejected 引用的回输入且 previouslyRejected=true', async () => {
    const { listProposalInputLessons } = await import('../src/pi/space/failureLessons.js');
    const pending = await seedLesson('prompt', '待审批占用');
    const rejected = await seedLesson('prompt', '曾被驳回');
    await seedProposalWithLessonSource(pending, 'pending');
    await seedProposalWithLessonSource(rejected, 'rejected');
    const out = await listProposalInputLessons();
    expect(out.find((l) => l.id === pending)).toBeUndefined();
    const r = out.find((l) => l.id === rejected)!;
    expect(r.previouslyRejected).toBe(true);
  });
});
```

- [x] 3.2 跑红。
- [x] 3.3 实现 `apps/api/src/pi/space/failureLessons.ts`：

```ts
/**
 * R3.5 失败教训蒸馏层：
 *  - collectUnconsumedSignals：S1 回滚/恢复默认（既有版本链直查）+ S2 负向反馈 + S3 nl_ai_fail，
 *    过滤「已被任意 status 教训 signals 引用」的信号（一次性消费，防 retire→再喂循环）。
 *  - distillLessons：LLM call#1，逐条归因（prompt/step_description/platform/sut），
 *    单条坏丢弃不炸批次；整体失败 throw 由调用方降级（solidifyService）。
 *  - listProposalInputLessons：阶段 2 输入用——仅 prompt/step_description 的 active 教训，
 *    被 pending/approved 提案引用的 blocked，被 rejected 引用的注明「曾有提案被驳回」。
 * 本文件被 solidifyService import，不能反向依赖——withLlmTimeout 自带副本（免 import 环）。
 */
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  aiAssistantFeedback, assistantFailureLessons, assistantFailureSignals,
  assistantPromptModuleVersions, assistantSolidifyProposals, productLines, projects,
} from '../../db/schema.js';
import { completeJson, type LLMClient } from '../../agent/llm-client.js';

export type SignalType = 'rollback' | 'restore_default' | 'negative_feedback' | 'nl_ai_fail';

export interface CollectedSignal {
  /** LLM 引用键：rollback#<seq> / negfb#<uuid> / nlaifail#<uuid>。 */
  key: string;
  type: SignalType;
  /** 消费幂等记账：版本行 seq（S1，字符串化）/ 行 uuid（S2/S3）。 */
  refId: string;
  time: string;
  line: string;
  title: string;
  excerpt: string;
  /** S1 专属：被回滚掉的行 source=solidify_apply（R3 自身输出质量反馈）。 */
  selfSolidify: boolean;
}

const SIGNAL_CAP = 60;
const TEXT_CAP = 400;
const clip = (s: string, n = TEXT_CAP) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 信号采集（查询，无 LLM）。返回值：signals=截断后的蒸馏输入；total=未消费总数（input_summary 记账）。 */
export async function collectUnconsumedSignals(): Promise<{ signals: CollectedSignal[]; total: number }> {
  const lessons = await db.select({ signals: assistantFailureLessons.signals }).from(assistantFailureLessons);
  const consumed = new Set<string>();
  for (const l of lessons) {
    for (const s of (Array.isArray(l.signals) ? l.signals : []) as Array<{ refId?: string }>) {
      if (s?.refId) consumed.add(s.refId);
    }
  }

  const collected: CollectedSignal[] = [];

  // S1：prompt 模块回滚/恢复默认——人工已判定该版文案有问题（归因精度最高，零成本）
  const versionRows = await db.select().from(assistantPromptModuleVersions)
    .orderBy(asc(assistantPromptModuleVersions.seq));
  const byKey = new Map<string, typeof versionRows>();
  for (const r of versionRows) {
    const arr = byKey.get(r.moduleKey) ?? [];
    arr.push(r);
    byKey.set(r.moduleKey, arr);
  }
  for (const rows of byKey.values()) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const isRestore = r.source === 'manual_edit' && r.value == null;
      if (r.source !== 'rollback' && !isRestore) continue;
      if (consumed.has(String(r.seq))) continue;
      // 被放弃的文案 = 同模块此行之前最近一个非空值行
      let prev: (typeof rows)[number] | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (rows[j]!.value != null) { prev = rows[j]; break; }
      }
      collected.push({
        key: `rollback#${r.seq}`,
        type: r.source === 'rollback' ? 'rollback' : 'restore_default',
        refId: String(r.seq),
        time: r.createdAt.toISOString(),
        line: 'global',
        title: `模块 ${r.moduleKey} 被人工${r.source === 'rollback' ? '回滚' : '恢复默认'}`
          + (prev?.source === 'solidify_apply' ? '（被回滚的是固化提案应用的版本——固化自身输出质量反馈）' : ''),
        excerpt: clip(`被放弃的文案：\n${prev?.value ?? '（无历史值）'}\n→ 现值：${r.value ?? '（恢复跟随代码默认）'}`),
        selfSolidify: prev?.source === 'solidify_apply',
      });
    }
  }

  const lineNames = new Map(
    (await db.select({ id: productLines.id, name: productLines.name }).from(productLines))
      .map((l) => [l.id, l.name] as const),
  );

  // S2：负向用户反馈（Phase 1 只收集不消费的表终于有消费者）
  const fbRows = await db.select().from(aiAssistantFeedback)
    .where(eq(aiAssistantFeedback.sentiment, 'negative'))
    .orderBy(desc(aiAssistantFeedback.createdAt)).limit(200);
  if (fbRows.length > 0) {
    const projectLine = new Map(
      (await db.select({ id: projects.id, productLineId: projects.productLineId }).from(projects))
        .map((p) => [p.id, p.productLineId] as const),
    );
    for (const f of fbRows) {
      if (consumed.has(f.id)) continue;
      const lineId = projectLine.get(f.projectId);
      collected.push({
        key: `negfb#${f.id}`,
        type: 'negative_feedback',
        refId: f.id,
        time: f.createdAt.toISOString(),
        line: lineId ? (lineNames.get(lineId) ?? 'unknown') : 'unknown',
        title: '用户负向反馈',
        excerpt: clip(`${f.messageExcerpt ?? '（无消息快照）'}${f.comment ? `\n用户补充：${f.comment}` : ''}`),
        selfSolidify: false,
      });
    }
  }

  // S3：verify 自然语言步 AI 相失败（采集层落行）
  const s3Rows = await db.select().from(assistantFailureSignals)
    .where(eq(assistantFailureSignals.type, 'nl_ai_fail'))
    .orderBy(desc(assistantFailureSignals.createdAt)).limit(200);
  for (const s of s3Rows) {
    if (consumed.has(s.id)) continue;
    const p = (s.payload ?? {}) as Record<string, unknown>;
    collected.push({
      key: `nlaifail#${s.id}`,
      type: 'nl_ai_fail',
      refId: s.id,
      time: s.createdAt.toISOString(),
      line: s.productLineId ? (lineNames.get(s.productLineId) ?? 'unknown') : 'unknown',
      title: `用例「${String(p.caseTitle ?? '?')}」第 ${s.stepOrder} 步 AI 相失败（${String(p.failureReason ?? '?')}）`,
      excerpt: clip(`步骤原文「${String(p.stepInstruction ?? '')}」；页面 ${String(p.pageUrl ?? p.targetUrl ?? '?')}`),
      selfSolidify: false,
    });
  }

  const total = collected.length;
  // S1 在最前天然优先；超量截断防爆 prompt
  return { signals: collected.slice(0, SIGNAL_CAP), total };
}

// ── 教训蒸馏（LLM call #1）──

const LESSON_SYSTEM_PROMPT = `你是测试助手平台的「失败教训蒸馏器」。输入是平台采集到的原始失败信号清单（每条带 key、类型、时间、来源线与证据摘录）。

任务：把相关信号归并、归因，蒸馏成结构化「失败教训」。归因是判断题——每条教训必须判定失败层：
- prompt：能指出某条常驻提示词/引导文案的某表述直接导致误解（如断言未限定实测范围被泛化）
- step_description：步骤描述写法与页面不符，且根源在「如何写步骤」的引导质量
- platform：平台闸门/机制缺陷（如 locator 校验误杀、元素清单截断误导）
- sut：被测系统环境问题（环境不可用、数据不满足、第三方服务异常）

判定不了 → 不产该条教训（宁缺毋滥，严禁硬凑归因）。

输出只含 JSON（不要 markdown 围栏）：
{"lessons":[{"attribution":"prompt","title":"...","lesson":"现象:...根因:...影响面:...建议:...","signalRefs":["<信号key>"]}],"notes":["..."]}

要求：
- title：≤60 字人话教训名，具体到表述/机制级颗粒度（如「guide 断言未限定实测范围导致泛化出自动登录」）
- lesson：四段结构「现象:…根因:…影响面:…建议修正方向:…」；建议修正方向只写方向不写全文
- signalRefs：支撑本教训的信号 key（只能从输入信号中选），每条教训至少引用 1 个
- 同一根因的多个信号归并进一条教训；不同根因分开多条
- notes：无法归因但有价值的观察，没有就空数组`;

const LessonSchema = z.object({
  attribution: z.enum(['prompt', 'step_description', 'platform', 'sut']),
  title: z.string().min(1).max(200),
  lesson: z.string().min(1).max(8_000),
  signalRefs: z.array(z.string().min(1)).min(1),
});

/** 外层宽松（lessons 逐条校验，单条坏丢弃不炸批次）；notes 上限防炸。 */
const LessonOutput = z.object({
  lessons: z.array(z.unknown()).max(20),
  notes: z.array(z.string().max(500)).max(20).default([]),
});

/** LLM 超时护栏（solidifyService 同款；本文件不能反向 import——免 import 环）。 */
function withLlmTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`failureLessons: distill LLM timeout (${ms}ms)`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** 教训蒸馏：成功返回入库条数；整体失败 throw（调用方降级：批次继续，信号保留待重试）。 */
export async function distillLessons(client: LLMClient, signals: CollectedSignal[], timeoutMs: number): Promise<number> {
  const userMessage = [
    '【失败信号】（key/类型/时间/来源线/摘录；signalRefs 只能引用这些 key）',
    ...signals.map((s) => `[${s.key}] type=${s.type} 时间=${s.time} 线=${s.line}\n${s.title}\n${s.excerpt}`),
  ].join('\n');
  const r = await withLlmTimeout(
    completeJson(client, { systemPrompt: LESSON_SYSTEM_PROMPT, userMessage }),
    timeoutMs,
  );
  const parsed = LessonOutput.safeParse(r.value);
  if (!parsed.success) throw new Error(`教训输出不合法：${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  void parsed.data.notes; // 教训层 notes 暂无消费面（阶段 2 的 notes 走 call#2）
  const byKey = new Map(signals.map((s) => [s.key, s]));
  const inserts: Array<typeof assistantFailureLessons.$inferInsert> = [];
  for (const raw of parsed.data.lessons) {
    const l = LessonSchema.safeParse(raw);
    if (!l.success) continue; // 单条坏丢弃不炸批次
    const refs = l.data.signalRefs
      .filter((k) => byKey.has(k))
      .map((k) => {
        const s = byKey.get(k)!;
        return { type: s.type, refId: s.refId, excerpt: clip(s.title, 200) };
      });
    if (refs.length === 0) continue; // 引用剔空丢弃（R3 sources 同款）
    inserts.push({
      status: 'active',
      attribution: l.data.attribution,
      title: l.data.title.slice(0, 200),
      lesson: l.data.lesson,
      signals: refs,
      distillModel: r.model ?? 'unknown',
    });
  }
  if (inserts.length > 0) await db.insert(assistantFailureLessons).values(inserts);
  return inserts.length;
}

// ── 阶段 2 输入查询 ──

export interface LessonForInput {
  id: string;
  attribution: 'prompt' | 'step_description';
  title: string;
  lesson: string;
  signalCount: number;
  previouslyRejected: boolean;
}

/** 阶段 2 的【失败教训】输入：active + prompt/step_description；
 *  被 pending/approved 提案引用的 blocked（防同案重复提案），rejected 引用的注明。 */
export async function listProposalInputLessons(): Promise<LessonForInput[]> {
  const rows = await db.select().from(assistantFailureLessons)
    .where(eq(assistantFailureLessons.status, 'active'))
    .orderBy(desc(assistantFailureLessons.createdAt)).limit(50);
  const candidates = rows.filter((l) => l.attribution === 'prompt' || l.attribution === 'step_description');
  if (candidates.length === 0) return [];
  const props = await db.select({ status: assistantSolidifyProposals.status, sources: assistantSolidifyProposals.sources })
    .from(assistantSolidifyProposals);
  const refStatuses = new Map<string, string[]>();
  for (const p of props) {
    for (const s of p.sources) {
      if (s.type === 'lesson') refStatuses.set(s.id, [...(refStatuses.get(s.id) ?? []), p.status]);
    }
  }
  return candidates
    .filter((l) => !(refStatuses.get(l.id) ?? []).some((st) => st === 'pending' || st === 'approved'))
    .map((l) => ({
      id: l.id,
      attribution: l.attribution as LessonForInput['attribution'],
      title: l.title,
      lesson: l.lesson,
      signalCount: Array.isArray(l.signals) ? (l.signals as unknown[]).length : 0,
      previouslyRejected: (refStatuses.get(l.id) ?? []).includes('rejected'),
    }));
}
```

- [x] 3.4 跑绿：`npx vitest run test/failure-lessons.test.ts`。
- [x] 3.5 提交：

```
feat(space): R3.5 教训蒸馏层——S1/S2/S3 信号聚合+消费幂等(一次性)+逐条归因蒸馏+提案输入过滤
```

## Task 4：solidifyService 三阶段接线

- [x] 4.1 `apps/api/test/solidify-service.test.ts` 扩展：
  - beforeEach TRUNCATE 追加：`assistant_failure_signals, assistant_failure_lessons, assistant_prompt_module_versions`。
  - 追加 stub 与 seed（放在 `stubClient` 附近）：

```ts
/** 顺序计数 stub：call#1=教训蒸馏、call#2=资产蒸馏，按次序回放；记录入参（JSON.stringify 断言）。 */
function sequentialStub(values: Array<unknown | ((prevReq: unknown) => unknown)>) {
  let i = 0;
  const calls: unknown[] = [];
  return {
    provider: 'openai' as const,
    calls,
    complete: async (req: unknown) => {
      calls.push(req);
      const raw = values[Math.min(i, values.length - 1)];
      const v = typeof raw === 'function' ? (raw as (r: unknown) => unknown)(calls[calls.length - 2] ?? req) : raw;
      i += 1;
      return { kind: 'json' as const, value: v, provider: 'openai' as const, vision: false, model: 'stub-model' };
    },
  };
}

async function seedRollbackSignal(): Promise<void> {
  await pool.query(
    `INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES
     ('space.style.zh', '断言未限定实测范围的旧表述', 'baseline'),
     ('space.style.zh', '修正后的断言表述', 'rollback'),
     ('tool.verify_case.guidelines', '旧指引', 'baseline'),
     ('tool.verify_case.guidelines', NULL, 'manual_edit')`);
}
```

  - 追加用例（新 describe `runSolidifyScan：R3.5 失败教训`）：

```ts
describe('runSolidifyScan：R3.5 失败教训', () => {
  it('红线：零信号 → call#1 不发生（LLM 只调 1 次）且入参不含【失败教训】', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { memoryId } = await seedSources();
    const stub = sequentialStub([{ proposals: [], notes: [] }]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never });
    expect(stub.calls).toHaveLength(1);
    expect(JSON.stringify(stub.calls[0])).not.toContain('失败教训');
    const b = await batchRow(id);
    const summary = JSON.parse(b.input_summary as string);
    expect(summary).toMatchObject({ memories: 1, lessons: 0, signals: 0 });
  });

  it('有信号但资产池为空 → 不早退，照跑（教训可独立产提案）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedRollbackSignal();
    const stub = sequentialStub([
      { lessons: [], notes: [] },
      { proposals: [], notes: [] },
    ]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never });
    expect(stub.calls).toHaveLength(2);
    expect((await batchRow(id)).status).toBe('done');
  });

  it('prompt_correction 链路：教训入库→进 call#2 输入→提案带 baseSeq+lesson sources', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedRollbackSignal();
    const stub = sequentialStub([
      { lessons: [{ attribution: 'prompt', title: '断言表述未限定实测范围', lesson: '现象:…根因:…影响面:…建议:限定实测范围', signalRefs: ['rollback#2'] }], notes: [] },
      (prevReq: unknown) => {
        const lid = /id=([0-9a-f-]{36})/.exec(JSON.stringify(prevReq))![1]!;
        return { proposals: [{ kind: 'prompt_correction', target: 'space.style.zh', title: '修正断言模块', body: '## 断言（修正后全文）', rationale: '1 次人工回滚', sources: [lid] }], notes: [] };
      },
    ]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never });
    const lesson = (await pool.query(`SELECT * FROM assistant_failure_lessons`)).rows[0]!;
    expect(lesson.status).toBe('active');
    expect(lesson.signals[0]).toMatchObject({ type: 'rollback', refId: '2' });
    expect(JSON.stringify(stub.calls[1])).toContain(lesson.id);
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals`)).rows[0]!;
    expect(p.kind).toBe('prompt_correction');
    expect(p.base_seq).not.toBeNull();
    expect(p.sources[0]).toMatchObject({ type: 'lesson', id: lesson.id, attribution: 'prompt', retireRecommended: false });
    const summary = JSON.parse((await batchRow(id)).input_summary as string);
    expect(summary).toMatchObject({ lessons: 1, signals: 2, proposals: 1 });
  });

  it('platform 归因教训入库但不进 call#2 输入', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedRollbackSignal();
    const stub = sequentialStub([
      { lessons: [
        { attribution: 'platform', title: 'locator 闸门误杀', lesson: '现象:…', signalRefs: ['rollback#4'] },
        { attribution: 'prompt', title: '断言未限定', lesson: '现象:…', signalRefs: ['rollback#2'] },
      ], notes: [] },
      { proposals: [], notes: [] },
    ]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never });
    const rows = (await pool.query(`SELECT attribution FROM assistant_failure_lessons`)).rows;
    expect(rows.map((r) => r.attribution).sort()).toEqual(['platform', 'prompt']);
    expect(JSON.stringify(stub.calls[1])).toContain('断言未限定');
    expect(JSON.stringify(stub.calls[1])).not.toContain('locator 闸门误杀');
  });

  it('call#1 整体失败 → 降级不炸批次（done + note + 信号保留）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedRollbackSignal();
    const stub = sequentialStub([
      { lessons: '不是数组' },
      { proposals: [], notes: [] },
    ]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never });
    const b = await batchRow(id);
    expect(b.status).toBe('done');
    const summary = JSON.parse(b.input_summary as string);
    expect(summary.notes.some((n: string) => n.includes('教训蒸馏失败'))).toBe(true);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_failure_lessons`)).rows[0]!;
    expect(n.n).toBe(0);
  });

  it('prompt_correction target=skill.* → 无落点丢弃；混入 memory id 的 sources 被修剪剔空丢弃', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    const { memoryId } = await seedSources();
    await seedRollbackSignal();
    const stub = sequentialStub([
      { lessons: [{ attribution: 'prompt', title: 't', lesson: 'l', signalRefs: ['rollback#2'] }], notes: [] },
      (prevReq: unknown) => {
        const lid = /id=([0-9a-f-]{36})/.exec(JSON.stringify(prevReq))![1]!;
        return { proposals: [
          { kind: 'prompt_correction', target: 'skill.demo', title: '改skill', body: 'x', rationale: 'r', sources: [lid] },
          { kind: 'prompt_correction', target: 'space.style.zh', title: '引用混用', body: 'x', rationale: 'r', sources: [memoryId] },
        ], notes: [] };
      },
    ]);
    const id = await newBatchId();
    await runSolidifyScan(id, { client: stub as never });
    const titles = (await pool.query(`SELECT title FROM assistant_solidify_proposals`)).rows;
    expect(titles).toHaveLength(0);
    const summary = JSON.parse((await batchRow(id)).input_summary as string);
    expect(summary.notes.some((n: string) => n.includes('无落点'))).toBe(true);
    expect(summary.notes.filter((n: string) => n.includes('全部无效')).length).toBe(1);
  });

  it('已被 pending 提案引用的教训，第二次盘点不进输入（同案防重）', async () => {
    const { runSolidifyScan } = await import('../src/pi/space/solidifyService.js');
    await seedRollbackSignal();
    const first = sequentialStub([
      { lessons: [{ attribution: 'prompt', title: '教训A', lesson: 'l', signalRefs: ['rollback#2'] }], notes: [] },
      (prevReq: unknown) => {
        const lid = /id=([0-9a-f-]{36})/.exec(JSON.stringify(prevReq))![1]!;
        return { proposals: [{ kind: 'prompt_correction', target: 'space.style.zh', title: '提案1', body: 'b', rationale: 'r', sources: [lid] }], notes: [] };
      },
    ]);
    await runSolidifyScan(await newBatchId(), { client: first as never });
    const second = sequentialStub([{ lessons: [], notes: [] }, { proposals: [], notes: [] }]);
    await runSolidifyScan(await newBatchId(), { client: second as never });
    expect(JSON.stringify(second.calls[1])).not.toContain('教训A');
  });
});
```

- [x] 4.2 跑红。
- [x] 4.3 实现 `apps/api/src/pi/space/solidifyService.ts`：
  1. import 区：`loadPromptModuleOverrides` 加入 promptModules.js 的既有 import；新增 `import { collectUnconsumedSignals, distillLessons, listProposalInputLessons } from './failureLessons.js';`；schema import 加 `assistantFailureSignals` 不需要（聚合在 failureLessons 内），但 `AssistantSolidifyProposalSource` 类型来源在 schema——sources 构造直接用字面量（$inferInsert 校验）。
  2. `SOLIDIFY_SYSTEM_PROMPT` 全文替换为：

```
你是测试助手平台的「经验固化盘点器」。输入是平台积累的短期记忆与成功轨迹（各带来源产品线标识）、平台现有 skill 清单、可编辑提示词模块清单，以及（如有）失败教训清单（带失败层归因与证据信号数）。

任务：产出「固化提案」——你只产提案，所有应用都经人工审批。

输出只含 JSON（不要 markdown 围栏）：
{"proposals":[{"kind":"...","target":"...","title":"...","body":"...","rationale":"...","sources":["<输入条目id>"]}],"notes":["..."]}

字段要求：
- kind："prompt_amendment"（追加到系统提示词模块）| "skill_revision"（修订现有 skill 的完整正文）| "prompt_correction"（全文修正某个提示词模块）
- target：prompt_amendment / prompt_correction 只能从【prompt_amendment 可选 target】清单中选；skill_revision 只能从【现有 skill 清单】中选
- title：≤60 字的人话提案名（审批列表用）
- body：prompt_amendment = 要追加的增量文案（markdown，拼到模块当前值尾部）；skill_revision = 修订后的完整正文（markdown，不含 frontmatter）；prompt_correction = 修正后的模块完整正文（markdown，可增可删可改，应用时整体覆盖模块当前值）
- rationale：为什么值得固化。prompt_amendment / skill_revision 必须写明有几条产品线来源支撑（如「3 条来源线：线A/线B/global」）；prompt_correction 必须写明信号数与信号类型（如「2 个独立失败信号命中同一误解」或「1 次人工回滚（人工已判定）」）
- sources：支撑本提案的输入条目 id 数组。prompt_amendment / skill_revision 从【输入条目】中选；prompt_correction 只能从【失败教训】中选（用教训 id）

四条判据——全部满足才产提案：
1. 非线内事实：不得含 URL、账号、data-testid/锚点、产品名、密码/令牌/API key 等凭据。凭据出现在任何输出字段即违规（prompt_correction 的修正文案同样适用）。
2. 可操作：能落成具体的文案/正文，不是空泛建议。
3. 去碎片化：先查现有 skill 清单——有落点才产 skill_revision；泛化经验没有现成 skill 落点时不要硬凑 target，写进 notes：「建议人工用 skill-creator 新建：<一句话>」。
4. 按形状分证据判据：
   - prompt_amendment / skill_revision：跨线普适——≥2 条产品线来源支撑（global 记忆可作一条线）。单线孤证不固化。
   - prompt_correction：频次——同一模块同一类误解被 ≥2 个独立失败教训/信号命中；或单个人工回滚类教训即可（人工已判定=最强证据）。按教训正文的「建议修正方向」写 body；教训之间互相冲突时不产提案写进 notes。【失败教训】里不会出现 platform/sut 归因的条目——严禁凭空猜测平台问题来写提示词补丁。

notes：无法落成提案但有价值的观察（无 skill 落点的泛化经验、低质量信号等），没有就空数组。
```

  3. `ProposalSchema` kind 枚举扩 `'prompt_correction'`。
  4. `runSolidifyScan` 按下述重排（保结构、标注阶段注释）：
     - `const notes: string[] = [];` 提到 try 内最前（阶段 1 降级 note 也要进 summary）。
     - 阶段 0：既有 mem/traj/lineNames/merged 之后加 `const signalBundle = await collectUnconsumedSignals();`；早退条件改 `merged.length === 0 && signalBundle.signals.length === 0`，早退 inputSummary 改 `{ memories: 0, trajectories: 0, lessons: 0, signals: 0, proposals: 0, notes: [] }`。
     - 阶段 1（早退之后、skillRows 之前）：

```ts
    // ── 阶段 1：失败教训蒸馏（有信号才执行；整体失败降级不炸批次，信号保留待重试）──
    if (signalBundle.signals.length > 0) {
      try {
        const distilled = await distillLessons(client, signalBundle.signals, deps.llmTimeoutMs ?? 180_000);
        if (distilled === 0) notes.push(`教训蒸馏未产出新教训（${signalBundle.total} 条信号保留待下次盘点）`);
      } catch (e) {
        logger.warn({ err: e, batchId }, 'solidify: lesson distill failed (degraded, signals retained)');
        notes.push('教训蒸馏失败（信号保留待下次盘点重试）');
      }
    }
```

     - 阶段 2：skillRows/promptKeys 之后加 `const lessons = await listProposalInputLessons();`；userMessage 在【prompt_amendment 可选 target】节之后追加：

```ts
      ...(lessons.length > 0 ? [
        '',
        '【失败教训】（prompt_correction 的证据来源；attribution=prompt/step_description 才会出现）',
        ...lessons.map((l, i) => `[L${i + 1}] id=${l.id} attribution=${l.attribution} 信号数=${l.signalCount}${l.previouslyRejected ? '（曾有提案被驳回，除非有新证据勿重复同案）' : ''}\n标题=${l.title}\n${l.lesson}`),
      ] : []),
```

     - call#2 之后 `notes.push(...parsed.data.notes);`（替代原 `const notes = [...parsed.data.notes]`）。
     - 阶段 3：校验循环改 targetOk 与 sources 双轨：

```ts
    const lessonById = new Map(lessons.map((l) => [l.id, l]));
    const overrides = await loadPromptModuleOverrides();
    // ...
    for (const raw of parsed.data.proposals) {
      const p = ProposalSchema.safeParse(raw);
      if (!p.success) { notes.push(`已丢弃一条形状不合法的提案：${p.error.issues[0]?.message ?? 'unknown'}`); continue; }
      // promptKeySet 本就过滤 group!=='skill'——prompt_correction 的 skill.* target 在此天然被拒
      const targetOk = p.data.kind === 'skill_revision' ? skillNames.has(p.data.target) : promptKeySet.has(p.data.target);
      if (!targetOk) { notes.push(`已丢弃「${p.data.title}」：target 无落点（${p.data.target}）`); continue; }
      let sources: Array<typeof assistantSolidifyProposals.$inferInsert.sources>;
      let baseSeq: number | null = null;
      if (p.data.kind === 'prompt_correction') {
        const ls = p.data.sources.filter((id) => lessonById.has(id)).map((id) => {
          const l = lessonById.get(id)!;
          return {
            type: 'lesson' as const, id, title: l.title.slice(0, 120), lineName: '',
            retireRecommended: false, attribution: l.attribution, signalCount: l.signalCount,
          };
        });
        if (ls.length === 0) { notes.push(`已丢弃「${p.data.title}」：sources 全部无效`); continue; }
        sources = ls;
        baseSeq = overrides.get(p.data.target)?.seq ?? null; // 服务端定值：盘点时定格
      } else {
        const ss = p.data.sources
          .filter((id) => sourceById.has(id))
          .map((id) => { /* ……R3 既有映射不动…… */ });
        if (ss.length === 0) { notes.push(`已丢弃「${p.data.title}」：sources 全部无效`); continue; }
        sources = ss;
      }
      inserts.push({ batchId, kind: p.data.kind, target: p.data.target, title: p.data.title.slice(0, 200), body: p.data.body, rationale: p.data.rationale, sources, baseSeq, status: 'pending', distillModel: r.model ?? 'unknown' });
    }
```

     - 收尾 inputSummary 扩键：

```ts
      inputSummary: JSON.stringify({
        memories: memRows.length, trajectories: trajRows.length,
        lessons: lessons.length, signals: signalBundle.total,
        proposals: inserts.length, notes,
      }),
```

  5. schema.ts 的 `AssistantSolidifyProposalSource` 接口同步扩展（sources jsonb 的 $type）：

```ts
export interface AssistantSolidifyProposalSource {
  type: 'memory' | 'trajectory' | 'lesson';
  id: string;
  title: string;
  /** 来源线名（创建时定格，'global'=全局记忆）。lesson 来源为空串（UI 渲染 attribution 徽标代替）。 */
  lineName: string;
  /** 服务端定值：memory=true / trajectory=false / lesson=false（lesson 应用即自动 resolved，不走退役勾选）。 */
  retireRecommended: boolean;
  /** 仅 lesson：归因与信号数快照（审批详情展示）。 */
  attribution?: 'prompt' | 'step_description';
  signalCount?: number;
}
```

- [x] 4.4 跑绿：`npx vitest run test/solidify-service.test.ts`（R3 既有用例必须全绿——`toMatchObject` 子集断言兼容新键）。
- [x] 4.5 提交：

```
feat(space): R3.5 盘点三阶段——信号采集/教训蒸馏(失败降级)/资产蒸馏扩 prompt_correction+baseSeq
```

## Task 5：solidifyApply（correction 应用 + 教训自动 resolved）

- [x] 5.1 `apps/api/test/solidify-apply.test.ts` 扩展：
  - `seedProposal` 的 opts.kind 扩 `'prompt_correction'`，支持 `baseSeq` 与 lesson 型 sources：

```ts
async function seedProposal(opts: {
  kind: 'prompt_amendment' | 'skill_revision' | 'prompt_correction';
  target: string;
  sourceIds: Array<{ type: 'memory' | 'trajectory' | 'lesson'; id: string }>;
  baseSeq?: number | null;
}): Promise<string> {
  const batchId = await seedBatch();
  return (await pool.query(
    `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, base_seq, distill_model)
     VALUES ($1, $2, $3, '提案', $4, 'r', $5::jsonb, $6, 'm') RETURNING id`,
    [batchId, opts.kind, opts.target,
     opts.kind === 'skill_revision' ? '修订后正文' : opts.kind === 'prompt_correction' ? '修正后全文' : '- 增量文案',
     JSON.stringify(opts.sourceIds.map((s) => ({
       type: s.type, id: s.id, title: 'src', lineName: s.type === 'lesson' ? '' : '线',
       retireRecommended: s.type === 'memory',
       ...(s.type === 'lesson' ? { attribution: 'prompt', signalCount: 2 } : {}),
     }))),
     opts.kind === 'prompt_correction' ? (opts.baseSeq ?? null) : null,
    ])).rows[0]!.id as string;
}
```

  （旧调用点签名兼容：既有用例不传 baseSeq 即可。）
  - beforeEach TRUNCATE 追加 `assistant_failure_lessons`。
  - seedLesson helper：

```ts
async function seedLesson(): Promise<string> {
  return (await pool.query(
    `INSERT INTO assistant_failure_lessons (attribution, title, lesson, signals, distill_model) VALUES ('prompt', '教训', 'l', '[]', 'm') RETURNING id`)).rows[0]!.id as string;
}
```

  - 新 describe：

```ts
describe('approveProposal：prompt_correction', () => {
  it('应用=全文覆盖写版本行（source=solidify_apply+sourceRef 幂等）；lesson 置 resolved', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '当前值', 'manual_edit')`);
    const current = (await pool.query(`SELECT seq FROM assistant_prompt_module_versions WHERE module_key='space.style.zh' ORDER BY seq DESC LIMIT 1`)).rows[0]!.seq as number;
    const lessonId = await seedLesson();
    const id = await seedProposal({ kind: 'prompt_correction', target: 'space.style.zh', sourceIds: [{ type: 'lesson', id: lessonId }], baseSeq: current });
    await approveProposal(null, id, []);
    const row = (await pool.query(`SELECT * FROM assistant_prompt_module_versions ORDER BY seq DESC LIMIT 1`)).rows[0]!;
    expect(row).toMatchObject({ module_key: 'space.style.zh', value: '修正后全文', source: 'solidify_apply', source_ref: id });
    const lesson = (await pool.query(`SELECT * FROM assistant_failure_lessons WHERE id=$1`, [lessonId])).rows[0]!;
    expect(lesson.status).toBe('resolved');
    expect(lesson.resolved_by_proposal).toBe(id);
  });

  it('baseSeq 冲突（盘点后被人工改过）→ apply_error「人工修改」+ status 回 pending + 500', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const lessonId = await seedLesson();
    const id = await seedProposal({ kind: 'prompt_correction', target: 'space.style.zh', sourceIds: [{ type: 'lesson', id: lessonId }], baseSeq: 7 });
    // 盘点后人工又改了一轮 → 当前 max(seq) 前进
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '人工改过', 'manual_edit')`);
    await expect(approveProposal(null, id, [])).rejects.toMatchObject({ status: 500 });
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals WHERE id=$1`, [id])).rows[0]!;
    expect(p.status).toBe('pending');
    expect(p.apply_error).toContain('人工修改');
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_prompt_module_versions WHERE source_ref=$1`, [id])).rows[0]!;
    expect(n.n).toBe(0); // 没写任何版本行
    const lesson = (await pool.query(`SELECT status FROM assistant_failure_lessons WHERE id=$1`, [lessonId])).rows[0]!;
    expect(lesson.status).toBe('active'); // 教训不被误 resolved
  });

  it('重试重放：sourceRef 行已存在 → 跳过写值继续（lesson 补 resolved）', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const lessonId = await seedLesson();
    const id = await seedProposal({ kind: 'prompt_correction', target: 'space.style.zh', sourceIds: [{ type: 'lesson', id: lessonId }], baseSeq: null });
    await approveProposal(null, id, []);
    // 模拟「版本行已写但 lesson 未 resolved」的部分失败：回 pending 再批
    await pool.query(`UPDATE assistant_solidify_proposals SET status='pending', applied_at=null WHERE id=$1`, [id]);
    await approveProposal(null, id, []);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_prompt_module_versions WHERE source_ref=$1`, [id])).rows[0]!;
    expect(n.n).toBe(1);
    const lesson = (await pool.query(`SELECT status FROM assistant_failure_lessons WHERE id=$1`, [lessonId])).rows[0]!;
    expect(lesson.status).toBe('resolved');
  });

  it('target=skill.*（绕过盘点直插 DB）→ 应用拒绝', async () => {
    const { approveProposal } = await import('../src/pi/space/solidifyApply.js');
    const lessonId = await seedLesson();
    const id = await seedProposal({ kind: 'prompt_correction', target: 'skill.demo', sourceIds: [{ type: 'lesson', id: lessonId }], baseSeq: null });
    await expect(approveProposal(null, id, [])).rejects.toMatchObject({ status: 500 });
    const p = (await pool.query(`SELECT * FROM assistant_solidify_proposals WHERE id=$1`, [id])).rows[0]!;
    expect(p.apply_error).toContain('不在注册表');
  });
});
```

- [x] 5.2 跑红。
- [x] 5.3 实现 `apps/api/src/pi/space/solidifyApply.ts`：
  1. schema import 加 `assistantFailureLessons`。
  2. `applyPromptCorrection`（放在 `applySkillRevision` 之后）：

```ts
/** prompt_correction：全文覆盖语义。baseSeq 复查（盘点后被人工改过 → 拒绝，回 pending 由人工重盘）。 */
async function applyPromptCorrection(prop: ProposalRow, userId: string | null): Promise<void> {
  const def = (await listPromptModuleDefs()).find((d) => d.key === prop.target && d.group !== 'skill');
  if (!def) throw new Error(`target 不在注册表：${prop.target}`);
  if (await hasAppliedVersionRow(prop.target, prop.id)) return; // 重试重放：已应用过，跳过写值
  const currentSeq = (await loadPromptModuleOverrides()).get(prop.target)?.seq ?? null;
  if (currentSeq !== (prop.baseSeq ?? null)) {
    throw new Error('模块已被人工修改，请重新盘点');
  }
  const seq = await insertPromptModuleVersion({
    moduleKey: prop.target, value: prop.body, source: 'solidify_apply', sourceRef: prop.id, createdByUserId: userId,
  });
  if (seq == null) return; // 并发重放被 unique 吞掉——视为已应用
}
```

  3. `resolveLessons`（放在 `retireSources` 之后）：

```ts
/** correction 应用后，其 sources 内的 lesson 自动置 resolved（active 守卫，不复活已 retired/resolved）。 */
async function resolveLessons(prop: ProposalRow): Promise<void> {
  const lessonIds = prop.sources.filter((s) => s.type === 'lesson').map((s) => s.id);
  if (lessonIds.length === 0) return;
  await db.update(assistantFailureLessons)
    .set({ status: 'resolved', resolvedByProposal: prop.id, updatedAt: new Date() })
    .where(and(inArray(assistantFailureLessons.id, lessonIds), eq(assistantFailureLessons.status, 'active')));
}
```

  4. `approveProposal` 的 try 内分派改：

```ts
    if (prop.kind === 'prompt_amendment') await applyPromptAmendment(prop, userId);
    else if (prop.kind === 'prompt_correction') await applyPromptCorrection(prop, userId);
    else await applySkillRevision(prop, userId);
    await retireSources(prop, retireIds);
    await resolveLessons(prop);
```

  5. `ProposalRow` 的 `baseSeq` 随 schema 自动可得（drizzle $inferSelect）。`retireIds` 子集校验对 lesson 来源天然安全（retireSources 只处理 memory/trajectory）。
- [x] 5.4 跑绿：`npx vitest run test/solidify-apply.test.ts`。
- [x] 5.5 提交：

```
feat(space): R3.5 correction 应用——baseSeq 陈旧基线防护+全文覆盖写+教训自动 resolved
```

## Task 6：failureLessonsRoute + 挂载

- [x] 6.1 写测试 `apps/api/test/failure-lessons-route.test.ts`（harness 抄 prompt-modules-route.test.ts：动态 import spaceRoute + express + errorHandler，manager/member 双身份）：

```ts
/** 失败教训路由：列表（status 过滤）/retire（active 守卫 404）/权限门。 */
// —— beforeAll/mount 与 prompt-modules-route.test.ts 完全同款（略，抄之）——
// 用例：
// 1. member GET → 403
// 2. manager GET 默认 active：seed active+resolved+retired 三行 → 只回 active
// 3. manager GET ?status=resolved → 回 resolved
// 4. manager GET ?status=bogus → 400
// 5. manager POST /:id/retire active 行 → 200 {ok:true} 且 DB status=retired
// 6. manager POST /:id/retire 已 retired 行 → 404
```

（实现时把 harness 与断言写全；TRUNCATE 含 `assistant_failure_lessons`。）
- [x] 6.2 跑红。
- [x] 6.3 实现 `apps/api/src/pi/space/failureLessonsRoute.ts`：

```ts
/**
 * R3.5 失败教训路由（requireManager）：教训列表 + 人工退役。
 * assistant_failure_signals 不暴露路由（内部采集层）。
 */
import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { HttpError } from '../../middleware/errorHandler.js';
import { db } from '../../db/client.js';
import { assistantFailureLessons } from '../../db/schema.js';

const router = Router();
const STATUSES = ['active', 'resolved', 'retired'] as const;

router.get('/', async (req, res) => {
  const status = typeof req.query.status === 'string' && STATUSES.includes(req.query.status as never)
    ? req.query.status as (typeof STATUSES)[number]
    : 'active';
  const rows = await db.select().from(assistantFailureLessons)
    .where(eq(assistantFailureLessons.status, status))
    .orderBy(desc(assistantFailureLessons.createdAt)).limit(200);
  res.json(rows);
});

router.post('/:id/retire', async (req, res) => {
  const r = await db.update(assistantFailureLessons)
    .set({ status: 'retired', updatedAt: new Date() })
    .where(and(eq(assistantFailureLessons.id, req.params.id!), eq(assistantFailureLessons.status, 'active')))
    .returning({ id: assistantFailureLessons.id });
  if (r.length === 0) throw new HttpError(404, 'not_found', '教训不存在或不在 active 状态');
  res.json({ ok: true });
});

export default router;
```

- [x] 6.4 挂载 `apps/api/src/pi/space/router.ts`：`/solidify` 挂载行（:472）之后加：

```ts
spaceRoute.use('/failure-lessons', requireManager, failureLessonsRoute);
```

（import 区加 `import failureLessonsRoute from './failureLessonsRoute.js';`——与 promptModulesRoute 同款默认导出。）
- [x] 6.5 跑绿：`npx vitest run test/failure-lessons-route.test.ts`。
- [x] 6.6 提交：

```
feat(space): R3.5 失败教训路由——列表 status 过滤+人工退役(active 守卫),signals 表不外露
```

## Task 7：web client.ts 类型与 API

- [x] 7.1 `apps/web/src/api/client.ts`：
  - `SolidifyProposalSource`（:1283）扩：

```ts
export interface SolidifyProposalSource {
  type: 'memory' | 'trajectory' | 'lesson';
  id: string;
  title: string;
  lineName: string;
  retireRecommended: boolean;
  /** 仅 lesson：归因与信号数快照。 */
  attribution?: 'prompt' | 'step_description';
  signalCount?: number;
}
```

  - `SolidifyProposal.kind`（:1294）扩 `'prompt_correction'`，并加 `baseSeq: number | null;`。
  - 新类型（放 SolidifyProposal 之后）：

```ts
export interface FailureLesson {
  id: string;
  status: 'active' | 'resolved' | 'retired';
  attribution: 'prompt' | 'step_description' | 'platform' | 'sut';
  title: string;
  lesson: string;
  signals: Array<{ type: string; refId: string; excerpt: string }>;
  resolvedByProposal: string | null;
  distillModel: string;
  createdAt: string;
  updatedAt: string;
}
```

  - `api.assistant` 组内（`solidify` 组之后）加：

```ts
    /** 系统设置：失败教训（R3.5）。signals 采集表不外露。 */
    failureLessons: {
      list: (status?: 'active' | 'resolved' | 'retired') =>
        request<FailureLesson[]>(`/assistant/failure-lessons${qs(status ? { status } : {})}`),
      retire: (id: string) =>
        request<{ ok: boolean }>(`/assistant/failure-lessons/${id}/retire`, { method: 'POST', body: '{}' }),
    },
```

- [x] 7.2 `cd apps/web && pnpm verify` 过（此时 SolidifySection 未消费新类型也能编译——union 扩展是向后兼容的）。
- [x] 7.3 提交：

```
feat(web): R3.5 client——FailureLesson 类型+failureLessons API 组,提案 kind/baseSeq/lesson 来源透出
```

## Task 8：SolidifySection + i18n

- [x] 8.1 i18n：`rg -l solidifyKindPrompt apps/web/src` 定位 settings 命名空间 zh/en 两个文件，加键：

zh：
```json
"solidifyKindCorrect": "修正提示词",
"solidifySourceLesson": "教训",
"lessonBlockTitle": "失败教训",
"lessonAttributionPrompt": "提示词",
"lessonAttributionStep": "步骤描述",
"lessonAttributionPlatform": "平台",
"lessonAttributionSut": "SUT",
"lessonSignalCount": "{{count}} 条信号",
"lessonIgnore": "忽略",
"lessonAutoResolve": "应用后自动标记已解决",
"lessonSettledCounts": "已解决 {{resolved}} · 已忽略 {{retired}}",
"lessonEmpty": "暂无失败教训",
"solidifyBatchSummary": "记忆 {{memories}} · 轨迹 {{trajectories}} · 教训 {{lessons}} · 信号 {{signals}} · 提案 {{proposals}}"
```

en：
```json
"solidifyKindCorrect": "Prompt correction",
"solidifySourceLesson": "lesson",
"lessonBlockTitle": "Failure lessons",
"lessonAttributionPrompt": "prompt",
"lessonAttributionStep": "step desc",
"lessonAttributionPlatform": "platform",
"lessonAttributionSut": "SUT",
"lessonSignalCount": "{{count}} signals",
"lessonIgnore": "Ignore",
"lessonAutoResolve": "auto-resolved on apply",
"lessonSettledCounts": "{{resolved}} resolved · {{retired}} retired",
"lessonEmpty": "No failure lessons",
"solidifyBatchSummary": "memories {{memories}} · trajectories {{trajectories}} · lessons {{lessons}} · signals {{signals}} · proposals {{proposals}}"
```

（若 `solidifyBatchSummary` 现有文案键名不同，以现有键为准扩展格式串。）

- [x] 8.2 `apps/web/src/components/settings/SolidifySection.tsx`：
  1. `batchSummary` 解析器加键：`lessons: v.lessons ?? 0, signals: v.signals ?? 0`（返回类型同步）。
  2. 两处 kind 三元（列表行 :165 与详情 :185）替换为映射：

```ts
const KIND_KEY: Record<SolidifyProposal['kind'], string> = {
  prompt_amendment: 'solidifyKindPrompt', skill_revision: 'solidifyKindSkill', prompt_correction: 'solidifyKindCorrect',
};
// 用法：t(`settings:${KIND_KEY[p.kind]}`)
```

  3. 来源清单（:222-236）：lesson 行不渲染勾选框（应用即自动 resolved），显示 attribution 徽标 + 信号数 + auto-resolve 提示：

```tsx
{detail.sources.map((s) => (
  <label key={s.id} className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'var(--muted)', cursor: s.type === 'lesson' ? 'default' : 'pointer' }}>
    {s.type !== 'lesson' && (
      <input
        type="checkbox"
        checked={retireIds.includes(s.id)}
        onChange={(e) => setRetireIds((prev) =>
          e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id))}
      />
    )}
    <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--card)', color: 'var(--muted-foreground)' }}>
      {s.type === 'memory' ? 'memory' : s.type === 'trajectory' ? 'trajectory' : t('settings:solidifySourceLesson')}
    </span>
    {s.type === 'lesson' && s.attribution && (
      <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
        {t(`settings:lessonAttribution${s.attribution === 'prompt' ? 'Prompt' : 'Step'}`)}
      </span>
    )}
    {s.type === 'lesson' && s.signalCount != null && (
      <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>
        {t('settings:lessonSignalCount', { count: s.signalCount })}
      </span>
    )}
    <span className="text-[11px] truncate flex-1" style={{ color: 'var(--foreground)' }}>{s.title}</span>
    {s.type === 'lesson'
      ? <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{t('settings:lessonAutoResolve')}</span>
      : <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{s.lineName}</span>}
  </label>
))}
```

  4. 教训块（批次历史之前插入）：active 列表 + 折叠计数 + retire 按钮：

```tsx
  const lessonsQ = useQuery({
    queryKey: ['failure-lessons'],
    queryFn: async () => {
      const [active, resolved, retired] = await Promise.all([
        api.assistant.failureLessons.list('active'),
        api.assistant.failureLessons.list('resolved'),
        api.assistant.failureLessons.list('retired'),
      ]);
      return { active, resolved, retired };
    },
  });
  const retireLesson = useMutation({
    mutationFn: (id: string) => api.assistant.failureLessons.retire(id),
    onSuccess: () => { toast(t('settings:solidifyReviewed'), 'success'); qc.invalidateQueries({ queryKey: ['failure-lessons'] }); },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });
```

```tsx
        {/* R3.5 失败教训：active 列表（≤10）+ 折叠计数；retire=人工驳回（误报/不修） */}
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium px-2" style={{ color: 'var(--muted-foreground)' }}>
            {t('settings:lessonBlockTitle')}
            {lessonsQ.data && (lessonsQ.data.resolved.length > 0 || lessonsQ.data.retired.length > 0) && (
              <span className="ml-2 font-normal">
                {t('settings:lessonSettledCounts', { resolved: lessonsQ.data.resolved.length, retired: lessonsQ.data.retired.length })}
              </span>
            )}
          </div>
          {(lessonsQ.data?.active ?? []).length === 0 ? (
            <div className="px-2 py-1 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>{t('settings:lessonEmpty')}</div>
          ) : (lessonsQ.data?.active ?? []).slice(0, 10).map((l) => (
            <div key={l.id} className="flex items-center gap-2 px-2 py-1">
              <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                {t(`settings:lessonAttribution${l.attribution === 'prompt' ? 'Prompt' : l.attribution === 'step_description' ? 'Step' : l.attribution === 'platform' ? 'Platform' : 'Sut'}`)}
              </span>
              <span className="text-[12px] truncate flex-1" style={{ color: 'var(--foreground)' }} title={l.lesson}>{l.title}</span>
              <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                {t('settings:lessonSignalCount', { count: l.signals?.length ?? 0 })}
              </span>
              <button type="button" className="text-[11px] shrink-0" style={{ color: 'var(--muted-foreground)' }}
                disabled={retireLesson.isPending} onClick={() => retireLesson.mutate(l.id)}>
                {t('settings:lessonIgnore')}
              </button>
            </div>
          ))}
        </div>
```

  5. `review.onSuccess` 的 approve 分支加 `qc.invalidateQueries({ queryKey: ['failure-lessons'] });`（应用 → lesson resolved → 列表收口）。
- [x] 8.3 `cd apps/web && pnpm verify` 过。
- [x] 8.4 浏览器实测（dev 起来后）：
  - 设置页教训块：空态文案；手插一条 active 教训（psql）→ 列表出现徽标/信号数；点忽略 → 消失、折叠计数 +1。
  - 手插一条 prompt_correction pending 提案（sources 带 lesson，psql 直插）→ 列表 kind 徽标「修正提示词」；详情左右栏=当前值 vs 修正后全文；来源行=教训徽标+auto-resolve 提示、无勾选框；批准 → 版本行落库 + 教训 resolved + 教训块计数收口。
  - 老批次行（无新键 inputSummary）显示不炸（lessons/signals 回 0）。
- [x] 8.5 提交：

```
feat(web): R3.5 设置页——失败教训块/三 kind 徽标/lesson 来源行(auto-resolve)/批次 summary 扩键
```

## Task 9：全量回归 + E2E + 收尾

- [x] 9.1 api 全量：`cd apps/api && npm test`——R3 既有（prompt-modules / prompt-modules-route / solidify-service / solidify-apply / solidify-route / memories / trajectories / 渲染红线）全绿；sendSyslog 基线红为已知噪声。
- [x] 9.2 web：`cd apps/web && pnpm verify`。
- [x] 9.3 `git status` 核对：仅本计划清单内文件有改动；测试污染的陌生源码改动还原（历史教训：反引号写进模板字面量 → build 挂）。
- [x] 9.4 dev 环境冒烟（记忆事项：起 dev api 前清 ANTHROPIC 四件套环境变量；dev 新表 Task 1.4 已手建）：
  1. 手插一条 S1 信号（prompt-modules 页面直改 space.style.zh 再回滚）→ 发起盘点 → 批次 done、教训块出现 prompt 归因教训。
  2. 盘点产出的 correction（若 LLM 产）走 approve → 版本行 + 教训 resolved。
  3. 真实 verify nlAiFail 信号（可选，需 SUT）：跑一个自然语言步必败用例 → assistant_failure_signals 落行 → 下次盘点进教训。
- [x] 9.5 发版（prod228 由 drizzle-kit push --force 自动建表）+ 发版锚点记录：api dist grep `assistant_failure_lessons` / `prompt_correction` / `模块已被人工修改`；manifest sha。
- [x] 9.6 收尾提交（如有零星修复）+ 汇报（含 R5 接口兑现情况：lessons 表即 R5 底座）。

---

## 风险与回退

| 风险 | 缓解 |
|---|---|
| call#1 拖长盘点总时长（多一次 LLM 往返） | 与 call#2 共用 180s 超时各自独立；降级路径已兜底；inline fire-and-forget 语义不变 |
| LLM 归因误判（platform 误判成 prompt） | 审批 diff + sources 溯源人工兜底；误报教训可 retire |
| baseSeq 误拦（模块无版本行时 seq=null，人工从未改过也 null） | apply 同源函数复查，null===null 放行；只有「盘点后出现了新行」才拦 |
| 教训重复提案（rejected 后同案再提） | previouslyRejected 注入 prompt 抑制 + 人工驳回兜底 |
| 回退 | 全部增量：两新表 + 一可空列 + 新 kind；不碰 R3 既有分支语义，revert 提交即可回退 |
