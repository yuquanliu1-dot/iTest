# 版本空间 AI 助手 Plan 2:平台领域工具 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给版本空间 AI 助手注入四个领域工具(manage_cases / manage_scenarios / manage_environments / manage_plans)与 announce_plan / inspect_page,配合最小 service 抽取,让对话框能完成用例/场景/环境/计划的全部配置类操作。

**Architecture:** 沿 Plan 1 的 ToolExecutor 接缝(`buildSpaceTools`)扩展:每个领域一个工具文件(action 判别联合 + per-action zod 校验),逻辑落在新建的 `services/*.service.ts`(供 HTTP 路由与工具共用);删除类与密钥类操作走 Plan 1 的 confirm gate(阻塞),其余写操作向线程 SSE 发 stage 事件(非阻塞)。`pi/space/tools.ts` 单文件转成 `pi/space/tools/` 目录。

**Tech Stack:** Express 5 + Drizzle + PostgreSQL + zod + @earendil-works/pi-ai (TypeBox) + vitest + testcontainers(postgres:16-alpine)。

**依赖:** Plan 1 已合入 main(bd01048:ai_threads 双类型 / confirm gate / SpaceToolsContext 接缝 / emitThreadEvent / buildSpaceSummary)。本计划在其上开新分支 `feat/space-assistant-plan2`(从 main)。

**执行环境注意:**
- 当前 checkout 上有用户未提交的 **web 侧** WIP(apps/web/**、packages/ui)。本计划只改 `apps/api/**` 与 docs,`git add` 一律用显式路径,严禁 `git add -A`/`git add .`。
- testcontainers 全量跑时偶发 "Hook timed out 10000ms"(负载),隔离重跑该文件即过,不算回归。
- 测试命令(在 `apps/api/` 下):`TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run <file>`;全量 `pnpm test`;类型 `pnpm typecheck`。

---

## 与设计文档的偏差(已在计划评审中确认)

1. **工具不做逐用户可见性校验**(调整设计 §3 措辞):工具只做**归属校验**(实体 ∈ ctx.projectId / ctx.versionId / 组织);per-user 可见性留在 HTTP 边界(每个请求 `assertSpaceThreadVisible` / `assertProjectVisible` 已把关)。理由:session 缓存复用 + 单操作者线程语义下,工具内再查 user 表是表演式校验;HTTP 边界才是真正的门。
2. **manage_cases.update 只改元数据**(title/description/priority/status/url),不改步骤。步骤修改是录制器/AI 工作台职责,对话框内改步骤留待后续计划。
3. **manage_cases.create 存 aiStep 壳 + 可选 compiled 即时展开,不做急切 LLM 编译**:与 requirements.ts save 流一致地调 `expandCompiledAiStepsInPlace`,但**不调** `compileAiStepsInPlace`(那需要 LLM 往返,不适合同步工具调用);LLM 没给 compiled 的步骤保留 aiStep 壳(UI 显示未编译,可后续补)。
4. **manage_environments.upsert 拒绝明文 password/privateKey**(设计未明确,安全收紧):明文凭据只能走 `set_secret`(阻塞确认,summary 不回显明文)。upsert 只管非秘密字段。

## 确认级别(设计 §4)

- **阻塞确认(requestConfirmation,risk)**:`manage_cases delete`(risk:'delete')、`manage_scenarios delete`(risk:'delete')、`manage_environments delete`(risk:'delete',summary 带引用计数)、`manage_environments set_secret`(risk:'secret',summary 严禁含明文值)。
- **非阻塞 + stage 事件(diff)**:create/update/move_group/add_cases/remove_cases/upsert/set。
- 拒绝/超时一律返回 `{ ok:false, error:'用户取消了该操作' }`,不重试。

## SSE 自定义事件(Plan 3 前端消费)

- `{ type:'stage', kind:'case'|'scenario'|'environment'|'plan'|'group', id, action, diff? }`
- `{ type:'announce', summary, total, steps: string[] }`
- `{ type:'confirm_request', confirmId, threadId, toolName, action, summary, risk, diff? }`(Plan 1 已有)

## 错误约定(设计 §8)

工具 execute 捕获一切异常,统一返回 `{ ok:false, error:中文可操作信息 }`;`HttpError.message` 直接透出;zod 校验失败拼 `字段: 消息`。归属不符的固定文案:实体「不存在或不属于当前项目/版本」。

---

## 文件结构

```
apps/api/src/services/
  cases.service.ts            [新建] 用例/分组领域服务
  scenarios.service.ts        [新建] 场景领域服务
  environments.service.ts     [新建] 环境领域服务(掩码/加密归一迁入)
  plans.service.ts            [新建] 执行计划领域服务
apps/api/src/pi/space/
  tools.ts                    [删除] 单文件接缝 → tools/ 目录
  tools/
    context.ts                [新建] SpaceToolsContext 接口
    diff.ts                   [新建] diffText 标量 diff 文本
    stage.ts                  [新建] emitStage 舞台事件
    announce.ts               [新建] announce_plan 工具
    inspect.ts                [新建] inspect_page 工具(复用 pi/inspectPage)
    cases.ts                  [新建] manage_cases 工具
    scenarios.ts              [新建] manage_scenarios 工具
    environments.ts           [新建] manage_environments 工具
    plans.ts                  [新建] manage_plans 工具
    index.ts                  [新建] buildSpaceTools 装配(保持原接缝签名)
  session.ts                  [修改] import 路径 './tools.js' → './tools/index.js'
apps/api/src/routes/
  cases.ts                    [修改] 增删改查逻辑下沉 service,保留可见性断言与 zod
  projects.ts                 [修改] POST /:id/groups 调 createGroup
  scenarios.ts                [修改] 调 scenarios.service
  environments.ts             [修改] 调 environments.service(test-db/test-syslog 探测留在路由)
  plans.ts                    [修改] 调 plans.service
apps/api/src/pi/tools.ts      [修改] normalizeCompiledStep 加 export(供 cases.service 用)
apps/api/test/
  cases.service.test.ts       [新建]
  scenarios.service.test.ts   [新建]
  environments.service.test.ts [新建]
  plans.service.test.ts       [新建]
  space-tools-basic.test.ts   [新建]
  space-tools-cases.test.ts   [新建]
  space-tools-scenarios.test.ts [新建]
  space-tools-environments.test.ts [新建]
  space-tools-plans.test.ts   [新建]
```

**既有可复用导出(已核实):**
- `services/projectAccess.ts`:`resolveCaseProjectId` / `resolveEnvironmentProjectId` / `resolveVersionProjectId` / `assertProjectVisible` / `assertCaseVisible` / `assertVersionVisible` / `assertEnvironmentVisible`。
- `lib/resolve-url.ts`:`resolveCaseUrl(caseRow, { defaultEnvFallback })`。
- `lib/step-migration.ts`:`migrateAssertion(raw)`。
- `lib/ai-step-expand.ts`:`expandCompiledAiStepsInPlace(prepared)`(PreparedCase/StepRow 接口未导出,结构化传参即可)。
- `pi/inspectPage.ts`:`inspectPage(url): Promise<string>`。
- `pi/space/confirm.ts`:`requestConfirmation(req, emit): Promise<boolean>` / `resolveConfirmation(confirmId, approved): boolean`。
- `pi/space/session.ts`:`emitThreadEvent(threadId, e)`(工具经 ctx.emit 使用,不直接 import)。
- `test/helpers/db.ts`:`SCHEMA_SQL` / `seedOrg(pool)` / `seedProject(pool) → {projectId, groupId, versionId, ...}`(每次调用建新项目;ENCRYPTION_KEY 用 `Buffer.alloc(32, 1).toString('base64')`)。

**测试公共骨架(每个 space-tools/service 测试文件的 beforeAll/afterAll,下文简写为「标准容器骨架」):**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});
```

---

### Task 1: 用例领域服务 + cases 路由下沉

**Files:**
- Create: `apps/api/src/services/cases.service.ts`
- Modify: `apps/api/src/routes/cases.ts`、`apps/api/src/routes/projects.ts`(groups POST)
- Test: `apps/api/test/cases.service.test.ts`

- [ ] **Step 1: 写失败测试(归属校验 + aiStep 展开)**

`apps/api/test/cases.service.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('cases.service', () => {
  it('createCase:同项目分组+版本创建成功并带 tags;version 跨项目 → version_mismatch', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const other = await seedProject(pool); // 第二个项目
    const svc = await import('../src/services/cases.service.js');
    const created = await svc.createCase({ groupId, versionId, title: '登录-正常' });
    expect(created.title).toBe('登录-正常');
    expect(created.versionId).toBe(versionId);

    await expect(svc.createCase({ groupId, versionId: other.versionId, title: 'x' }))
      .rejects.toMatchObject({ status: 400, code: 'version_mismatch' });
    await expect(svc.createCase({ groupId: other.groupId, versionId, title: 'x' }))
      .rejects.toMatchObject({ status: 400, code: 'version_mismatch' });
  }, 30_000);

  it('createCaseWithSteps:compiled click 展开为具体步骤,compiled:[] 映射为 null 保留 aiStep 壳', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    const c = await svc.createCaseWithSteps({
      groupId, versionId, title: '下单流程',
      steps: [
        { instruction: '打开首页', compiled: [{ kind: 'navigate', url: 'https://a.example.com/' }] },
        { instruction: '点击下单按钮', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '.buy' }] }], assertion: '出现成功提示' },
        { instruction: '模糊步骤', compiled: [] },
      ],
    });
    const rows = (await pool.query(`SELECT "order", name, action, assertion FROM test_steps WHERE case_id=$1 ORDER BY "order"`, [c.id])).rows as Array<{
      order: number; name: string | null; action: Record<string, unknown>; assertion: Record<string, unknown> | null;
    }>;
    // 第 1、2 条被展开成具体 DSL(每条 compiled 1 个子步骤 → 各 1 行);第 3 条 [] → null,留 aiStep 壳
    expect(rows).toHaveLength(3);
    expect((rows[0]!.action as { kind: string }).kind).toBe('navigate');
    expect((rows[1]!.action as { kind: string }).kind).toBe('click');
    expect((rows[1]!.assertion as { kind: string; match?: string }).kind).toBe('assertText');
    expect((rows[2]!.action as { kind: string; compiled?: unknown }).kind).toBe('aiStep');
    expect((rows[2]!.action as { compiled: unknown }).compiled).toBeNull();
  }, 30_000);

  it('updateCase:scenario 不匹配 → 400;tagIds [] 清空;searchCasesInVersion 关键词过滤', async () => {
    const { groupId, versionId, projectId } = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    const c = await svc.createCase({ groupId, versionId, title: '搜索关键字X用例' });
    await svc.createCase({ groupId, versionId, title: '无关用例' });

    const hits = await svc.searchCasesInVersion(versionId, { keyword: '关键字x' });
    expect(hits.map((r) => r.id)).toEqual([c.id]);

    await expect(svc.updateCase(c.id, { scenarioId: '00000000-0000-0000-0000-000000000000' }))
      .rejects.toMatchObject({ status: 404 });
    const updated = await svc.updateCase(c.id, { title: '改名', tagIds: [] });
    expect(updated.title).toBe('改名');
    expect(updated.tags).toEqual([]);
  }, 30_000);

  it('createGroup:项目不存在 → 404;成功后 groupProjectId 可解析', async () => {
    const { projectId } = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    const g = await svc.createGroup(projectId, { name: '新分组', defaultUrl: 'https://g.example.com' });
    expect(await svc.groupProjectId(g.id)).toBe(projectId);
    await expect(svc.createGroup('00000000-0000-0000-0000-000000000000', { name: 'x' }))
      .rejects.toMatchObject({ status: 404 });
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试确认失败(模块不存在)**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/cases.service.test.ts`
Expected: FAIL — `Cannot find module '../src/services/cases.service.js'`

- [ ] **Step 3: 实现 `services/cases.service.ts`**

```ts
/**
 * 用例/分组领域服务:HTTP 路由与空间 AI 工具共用。
 * 这里只做数据完整性与归属校验(实体 ∈ project/version/org);
 * 用户可见性(assertProjectVisible 等)由调用方(HTTP 边界)负责。
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { caseTags, groups, projects, tags, testCases, testSteps } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { resolveVersionProjectId } from './projectAccess.js';
import { migrateAssertion } from '../lib/step-migration.js';
import { normalizeCompiledStep } from '../pi/tools.js';
import { expandCompiledAiStepsInPlace } from '../lib/ai-step-expand.js';

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const STATUSES = ['draft', 'review', 'ready', 'deprecated'];

export async function groupProjectId(groupId: string): Promise<string | null> {
  const row = (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, groupId)).limit(1))[0];
  return row?.projectId ?? null;
}

/** 校验 tagIds 都属于 projectId 所属组织;缺失 404,跨组织 400。 */
export async function assertTagsBelongToOrg(tagIds: string[], projectId: string): Promise<void> {
  if (tagIds.length === 0) return;
  const [proj] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!proj) throw new HttpError(404, 'not_found', 'project not found');
  const rows = await db.select({ id: tags.id, organizationId: tags.organizationId }).from(tags).where(inArray(tags.id, tagIds));
  const found = new Set(rows.map((r) => r.id));
  for (const id of tagIds) {
    if (!found.has(id)) throw new HttpError(404, 'not_found', `tag ${id} not found`);
  }
  const wrong = rows.filter((t) => t.organizationId !== proj.organizationId);
  if (wrong.length > 0) throw new HttpError(400, 'tag_org_mismatch', 'tag belongs to another organization');
}

/** 批量取出 caseIds 关联的所有 tag,按 caseId 分组。空集合返回空 Map。 */
export async function tagsForCases(caseIds: string[]): Promise<Map<string, Array<{ id: string; name: string; color: string }>>> {
  const map = new Map<string, Array<{ id: string; name: string; color: string }>>();
  if (caseIds.length === 0) return map;
  const rows = await db
    .select({ caseId: caseTags.caseId, id: tags.id, name: tags.name, color: tags.color })
    .from(caseTags)
    .innerJoin(tags, eq(tags.id, caseTags.tagId))
    .where(inArray(caseTags.caseId, caseIds));
  for (const r of rows) {
    const arr = map.get(r.caseId) ?? [];
    arr.push({ id: r.id, name: r.name, color: r.color });
    map.set(r.caseId, arr);
  }
  return map;
}

function assertWindowCustom(v: { windowStrategy?: string; windowWidth?: number | null; windowHeight?: number | null }): void {
  if (v.windowStrategy === 'custom' && (!v.windowWidth || !v.windowHeight)) {
    throw new HttpError(400, 'window_required', 'windowWidth and windowHeight are required when windowStrategy is custom');
  }
}

function assertEnum(name: 'priority' | 'status', value: string, allowed: string[]): void {
  if (!allowed.includes(value)) throw new HttpError(400, `bad_${name}`, `invalid ${name}: ${value}`);
}

export interface CreateCaseInput {
  groupId: string;
  versionId: string;
  title: string;
  description?: string | null;
  priority?: string;
  url?: string | null;
  windowStrategy?: string;
  windowWidth?: number | null;
  windowHeight?: number | null;
  incognito?: boolean;
  requirementId?: string | null;
  scenarioId?: string | null;
  tagIds?: string[];
}

export async function createCase(input: CreateCaseInput) {
  const pid = await groupProjectId(input.groupId);
  if (!pid) throw new HttpError(404, 'not_found', 'group not found');
  const vp = await resolveVersionProjectId(input.versionId);
  if (!vp) throw new HttpError(404, 'not_found', 'version not found');
  if (vp !== pid) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
  if (input.priority !== undefined) assertEnum('priority', input.priority, PRIORITIES);
  assertWindowCustom(input);
  if (input.tagIds?.length) await assertTagsBelongToOrg(input.tagIds, pid);
  const { tagIds, ...values } = input;
  const created = (await db.insert(testCases).values(values).returning())[0]!;
  if (tagIds?.length) {
    await db.insert(caseTags).values(tagIds.map((tagId) => ({ caseId: created.id, tagId })));
  }
  const tagsByCase = await tagsForCases([created.id]);
  return { ...created, tags: tagsByCase.get(created.id) ?? [] };
}

export interface AiStepInput {
  instruction: string;
  assertion?: string | null;
  /** LLM 编译出的 DSL 子步骤;[] 映射为 null(放弃语义);缺省保留未编译 aiStep 壳。 */
  compiled?: unknown[] | null;
}

/** 创建用例并写 AI 步骤(aiStep 壳 + 可选 compiled 归一化后即时展开;不做急切 LLM 编译)。 */
export async function createCaseWithSteps(input: CreateCaseInput & { steps?: AiStepInput[] }) {
  const created = await createCase(input);
  if (input.steps?.length) {
    const stepRows: Array<{
      source: 'agent';
      name: string;
      action: object;
      assertion: object | null;
      componentKind?: string;
      sensitive: boolean;
    }> = input.steps.map((s) => {
      const name = (s.instruction.split(/[，。！？,.!?\n]/, 1)[0]?.trim() ?? '').slice(0, 200) || s.instruction.slice(0, 200);
      const action: Record<string, unknown> = { kind: 'aiStep', instruction: s.instruction };
      if (s.compiled !== undefined) {
        action.compiled = Array.isArray(s.compiled) ? (s.compiled.length === 0 ? null : s.compiled.map(normalizeCompiledStep)) : s.compiled;
      }
      return {
        source: 'agent' as const,
        name,
        action: action as object,
        assertion: s.assertion ? migrateAssertion({ kind: 'assertText', text: s.assertion }) : null,
        sensitive: false,
      };
    });
    // 注意:expand 内部是 p.stepRows = out(重赋值到包装对象)→ 必须经 prepared 读回展开结果
    const prepared = [{ stepRows }];
    expandCompiledAiStepsInPlace(prepared);
    await db.insert(testSteps).values(
      prepared[0]!.stepRows.map((r, i) => ({
        caseId: created.id,
        order: i,
        source: r.source,
        name: r.name,
        action: r.action,
        assertion: r.assertion,
        sensitive: r.sensitive,
        componentKind: r.componentKind ?? null,
      })),
    );
  }
  return created;
}

export interface UpdateCasePatch {
  title?: string;
  description?: string | null;
  priority?: string;
  status?: string;
  url?: string | null;
  groupId?: string;
  scenarioId?: string | null;
  defaultEnvId?: string | null;
  windowStrategy?: string;
  windowWidth?: number | null;
  windowHeight?: number | null;
  incognito?: boolean;
  tagIds?: string[];
}

export async function updateCase(caseId: string, patch: UpdateCasePatch) {
  const existing = (await db.select().from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'case not found');
  // 目标项目:移动分组时取新分组,否则用例现属分组
  let targetPid = patch.groupId !== undefined ? await groupProjectId(patch.groupId) : await groupProjectId(existing.groupId);
  if (!targetPid) throw new HttpError(404, 'not_found', 'group not found');
  if (patch.priority !== undefined) assertEnum('priority', patch.priority, PRIORITIES);
  if (patch.status !== undefined) assertEnum('status', patch.status, STATUSES);
  assertWindowCustom(patch);
  if (patch.scenarioId !== undefined && patch.scenarioId !== null) {
    const { scenarios } = await import('../db/schema.js');
    const sc = (await db.select({ requirementId: scenarios.requirementId }).from(scenarios).where(eq(scenarios.id, patch.scenarioId)).limit(1))[0];
    if (!sc) throw new HttpError(404, 'not_found', 'scenario not found');
    if (existing.requirementId !== sc.requirementId) {
      throw new HttpError(400, 'scenario_mismatch', "scenario does not belong to this case's requirement");
    }
  }
  if (patch.defaultEnvId !== undefined && patch.defaultEnvId !== null) {
    const { resolveEnvironmentProjectId } = await import('./projectAccess.js');
    const envPid = await resolveEnvironmentProjectId(patch.defaultEnvId);
    if (!envPid) throw new HttpError(404, 'not_found', 'environment not found');
    if (envPid !== targetPid) throw new HttpError(400, 'env_project_mismatch', 'environment does not belong to this project');
  }
  if (patch.tagIds !== undefined) await assertTagsBelongToOrg(patch.tagIds, targetPid);
  const { tagIds, ...rest } = patch;
  const updated = (await db.update(testCases).set({ ...rest, updatedAt: new Date() }).where(eq(testCases.id, caseId)).returning())[0]!;
  if (tagIds !== undefined) {
    await db.delete(caseTags).where(eq(caseTags.caseId, caseId));
    if (tagIds.length > 0) {
      await db.insert(caseTags).values(tagIds.map((tagId) => ({ caseId, tagId })));
    }
  }
  const tagsByCase = await tagsForCases([caseId]);
  return { ...updated, tags: tagsByCase.get(caseId) ?? [] };
}

export async function deleteCase(caseId: string): Promise<void> {
  const deleted = await db.delete(testCases).where(eq(testCases.id, caseId)).returning({ id: testCases.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'case not found');
}

/** 详情:步骤脱敏(去 secret 三元组列)+ 解析后的入口 URL + tags。不存在返回 null。 */
export async function getCaseDetail(caseId: string) {
  const row = (await db.select().from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!row) return null;
  const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
  const sanitizedSteps = steps.map(({ secretCiphertext: _sc, secretIv: _si, secretTag: _st, ...rest }) => rest);
  const resolvedUrl = await resolveCaseUrl(row, { defaultEnvFallback: true });
  const tagsByCase = await tagsForCases([caseId]);
  return { ...row, steps: sanitizedSteps, resolvedUrl, tags: tagsByCase.get(caseId) ?? [] };
}

export async function searchCasesInVersion(versionId: string, o: { keyword?: string; groupId?: string; limit?: number } = {}) {
  const rows = await db
    .select({
      id: testCases.id,
      title: testCases.title,
      priority: testCases.priority,
      status: testCases.status,
      groupId: testCases.groupId,
      scenarioId: testCases.scenarioId,
      url: testCases.url,
      updatedAt: testCases.updatedAt,
    })
    .from(testCases)
    .where(eq(testCases.versionId, versionId))
    .orderBy(asc(testCases.createdAt));
  let out = rows;
  if (o.groupId) out = out.filter((r) => r.groupId === o.groupId);
  const kw = o.keyword?.trim().toLowerCase();
  if (kw) out = out.filter((r) => r.title.toLowerCase().includes(kw));
  return out.slice(0, o.limit ?? 50);
}

export async function createGroup(projectId: string, input: { name: string; defaultUrl?: string | null }) {
  const p = (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!p) throw new HttpError(404, 'not_found', 'project not found');
  return (await db
    .insert(groups)
    .values({ projectId, name: input.name, ...(input.defaultUrl !== undefined ? { defaultUrl: input.defaultUrl } : {}) })
    .returning())[0]!;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/cases.service.test.ts`
Expected: PASS(4 个用例)

- [ ] **Step 5: 路由下沉(cases.ts + projects.ts),保持既有路由测试全绿**

`apps/api/src/routes/cases.ts` 修改:
1. 删除本地 `assertTagsBelongToOrg` 与 `tagsForCases` 两个函数定义,改从 service import:
   ```ts
   import { createCase, getCaseDetail, updateCase, deleteCase, groupProjectId, tagsForCases } from '../services/cases.service.js';
   ```
   (注意:`tagsForCases` 的返回仍是 `Map`,原调用点不变。)
2. `POST /` 整体替换为(版本/分组可见性留在路由,数据校验进 service):
   ```ts
   casesRoute.post('/', async (req, res) => {
     const body = CreateBody.parse(req.body);
     const pid = await groupProjectId(body.groupId);
     if (!pid) throw new HttpError(404, 'not_found', 'group not found');
     await assertProjectVisible(pid, req.user!);
     if (!body.versionId) throw new HttpError(400, 'version_required', 'versionId is required');
     const { projectId: vp } = await assertVersionVisible(body.versionId, req.user!);
     if (vp !== pid) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
     res.json(await createCase(body));
   });
   ```
3. `GET /:id` 整体替换为:
   ```ts
   casesRoute.get('/:id', async (req, res) => {
     await assertCaseVisible(req.params.id!, req.user!);
     const detail = await getCaseDetail(req.params.id!);
     if (!detail) throw new HttpError(404, 'not_found', 'case not found');
     res.json(detail);
   });
   ```
4. `PATCH /:id` 整体替换为(scenario 匹配 / env 归属 / tags 校验全部由 service 兜底;路由保留可见性断言):
   ```ts
   casesRoute.patch('/:id', async (req, res) => {
     const body = PatchBody.parse(req.body);
     await assertCaseVisible(req.params.id!, req.user!);
     if (body.groupId !== undefined) {
       const pid = await groupProjectId(body.groupId);
       if (!pid) throw new HttpError(404, 'not_found', 'group not found');
       await assertProjectVisible(pid, req.user!);
     }
     if (body.defaultEnvId !== undefined && body.defaultEnvId !== null) {
       const { assertEnvironmentVisible } = await import('../services/projectAccess.js');
       await assertEnvironmentVisible(body.defaultEnvId, req.user!);
     }
     res.json(await updateCase(req.params.id!, body));
   });
   ```
5. `DELETE /:id` 替换为:
   ```ts
   casesRoute.delete('/:id', async (req, res) => {
     await assertCaseVisible(req.params.id!, req.user!);
     await deleteCase(req.params.id!);
     res.json({ ok: true });
   });
   ```
6. copy/batch 系列端点与 `GET /` 保持原样(只享受 tagsForCases 改 import);不再使用的 import(`scenarios`,`tags`,`caseTags` 等)按 TS noUnusedLocals 实际报错情况清理——以 `pnpm typecheck` 通过为准。

`apps/api/src/routes/projects.ts` 的 `POST /:id/groups` 替换为:
```ts
projectsRoute.post('/:id/groups', async (req, res) => {
  const projectId = String(req.params.id);
  await assertProjectVisible(projectId, req.user!);
  const body = CreateBody.parse(req.body);
  res.json(await createGroup(projectId, { name: body.name }));
});
```
(顶部加 `import { createGroup } from '../services/cases.service.js';`)

- [ ] **Step 6: 回归既有路由测试 + 类型检查**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/cases.test.ts test/projects.test.ts && pnpm typecheck`
Expected: 全 PASS;typecheck 无错。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/cases.service.ts apps/api/src/routes/cases.ts apps/api/src/routes/projects.ts apps/api/test/cases.service.test.ts
git commit -m "feat(api): 用例/分组领域服务下沉,路由与 AI 工具共用"
```

---

### Task 2: 场景领域服务 + scenarios 路由下沉

**Files:**
- Create: `apps/api/src/services/scenarios.service.ts`
- Modify: `apps/api/src/routes/scenarios.ts`
- Test: `apps/api/test/scenarios.service.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/test/scenarios.service.test.ts`(标准容器骨架 + 以下用例):

```ts
import { randomUUID } from 'node:crypto';

describe('scenarios.service', () => {
  it('requirementProjectId/scenarioProjectId 经 join 解析;归属外 id 返回 null', async () => {
    const { projectId } = await seedProject(pool);
    const rid = (await pool.query(
      `INSERT INTO requirements(project_id, title, content) VALUES ($1,'需求A','c') RETURNING id`, [projectId],
    )).rows[0]!.id as string;
    const svc = await import('../src/services/scenarios.service.js');
    expect(await svc.requirementProjectId(rid)).toBe(projectId);
    expect(await svc.requirementProjectId(randomUUID())).toBeNull();
    const sc = await svc.createScenario(rid, { title: '场景一' });
    expect(await svc.scenarioProjectId(sc.id)).toBe(projectId);
    expect(await svc.scenarioProjectId(randomUUID())).toBeNull();
  }, 30_000);

  it('createScenario order 递增;listScenariosByProject 跨需求全集;update/delete 生效', async () => {
    const { projectId } = await seedProject(pool);
    const rid = (await pool.query(
      `INSERT INTO requirements(project_id, title, content) VALUES ($1,'需求B','c') RETURNING id`, [projectId],
    )).rows[0]!.id as string;
    const svc = await import('../src/services/scenarios.service.js');
    const s1 = await svc.createScenario(rid, { title: 'S1' });
    const s2 = await svc.createScenario(rid, { title: 'S2', description: 'd' });
    expect(s2.order).toBeGreaterThan(s1.order);

    const list = await svc.listScenariosByProject(projectId);
    expect(list.map((r) => r.title).sort()).toEqual(['S1', 'S2']);

    const upd = await svc.updateScenario(s1.id, { title: 'S1改名' });
    expect(upd.title).toBe('S1改名');
    await svc.deleteScenario(s2.id);
    expect(await svc.scenarioProjectId(s2.id)).toBeNull();
    await expect(svc.deleteScenario(s2.id)).rejects.toMatchObject({ status: 404 });
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/scenarios.service.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `services/scenarios.service.ts`**

```ts
/**
 * 场景领域服务:场景从属需求(scenarios.requirement_id NOT NULL)。
 * 归属解析经 requirements join;用户可见性由调用方(HTTP 边界)负责。
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirements, scenarios } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';

export async function requirementProjectId(requirementId: string): Promise<string | null> {
  const row = (await db.select({ projectId: requirements.projectId }).from(requirements).where(eq(requirements.id, requirementId)).limit(1))[0];
  return row?.projectId ?? null;
}

export async function scenarioProjectId(scenarioId: string): Promise<string | null> {
  const row = (
    await db
      .select({ projectId: requirements.projectId })
      .from(scenarios)
      .innerJoin(requirements, eq(scenarios.requirementId, requirements.id))
      .where(eq(scenarios.id, scenarioId))
      .limit(1)
  )[0];
  return row?.projectId ?? null;
}

/** 项目级场景全集(id/title/requirementId),按创建序。 */
export async function listScenariosByProject(projectId: string) {
  return db
    .select({ id: scenarios.id, title: scenarios.title, requirementId: scenarios.requirementId })
    .from(scenarios)
    .innerJoin(requirements, eq(scenarios.requirementId, requirements.id))
    .where(eq(requirements.projectId, projectId))
    .orderBy(scenarios.createdAt);
}

export async function getScenario(scenarioId: string) {
  return (await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1))[0] ?? null;
}

export async function createScenario(requirementId: string, input: { title: string; description?: string | null }) {
  const pid = await requirementProjectId(requirementId);
  if (!pid) throw new HttpError(404, 'not_found', 'requirement not found');
  const max = (
    await db.select({ m: sql<number>`coalesce(max("order"), 0)` }).from(scenarios).where(eq(scenarios.requirementId, requirementId))
  )[0]?.m ?? 0;
  return (
    await db
      .insert(scenarios)
      .values({ requirementId, title: input.title, description: input.description, order: Number(max) + 1 })
      .returning()
  )[0]!;
}

export async function updateScenario(scenarioId: string, patch: { title?: string; description?: string | null }) {
  const updated = await db.update(scenarios).set(patch).where(eq(scenarios.id, scenarioId)).returning();
  if (updated.length === 0) throw new HttpError(404, 'not_found', 'scenario not found');
  return updated[0]!;
}

/** FK ON DELETE SET NULL:用例自动解绑,不需要 409。 */
export async function deleteScenario(scenarioId: string): Promise<void> {
  const deleted = await db.delete(scenarios).where(eq(scenarios.id, scenarioId)).returning({ id: scenarios.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'scenario not found');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/scenarios.service.test.ts`
Expected: PASS

- [ ] **Step 5: 路由下沉(`routes/scenarios.ts`)**

`projectIdFor` 本地函数删除,改 import service;各 handler 保持可见性断言,数据操作换 service:

```ts
import { listScenariosByProject, createScenario, updateScenario, deleteScenario, requirementProjectId } from '../services/scenarios.service.js';
```

- GET `/`(projectId 分支):`res.json(await listScenariosByProject(projectId)); return;`(注意原实现按 createdAt 排序且只回 id/title/requirementId——service 行为一致;requirementId 分支原样保留,可继续用 `requirementProjectId(rid)` 替代 `projectIdFor(rid)`)。
- POST `/`:`await assertProjectVisible(await requirementProjectId(rid) ?? '' ...)`——保持原语义:先 `requirementProjectId`,为 null 抛 404(与原 `projectIdFor` 相同);然后 `res.json(await createScenario(rid, body))`。
- PATCH `/`:先查场景归属:`const pid = await scenarioProjectId(req.params.id!); if (!pid) throw new HttpError(404, 'not_found', 'scenario not found'); await assertProjectVisible(pid, req.user!); res.json(await updateScenario(req.params.id!, body));`(顶部 import `scenarioProjectId`)。
- DELETE `/`:同上归属检查后 `await deleteScenario(req.params.id!); res.json({ ok: true });`。

- [ ] **Step 6: 回归 + typecheck**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/scenarios.test.ts && pnpm typecheck`
Expected: PASS(若无 scenarios.test.ts 则跑全量 `pnpm vitest run test/scenarios.service.test.ts` 并确认路由相关套件无回归)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/scenarios.service.ts apps/api/src/routes/scenarios.ts apps/api/test/scenarios.service.test.ts
git commit -m "feat(api): 场景领域服务下沉"
```

---

### Task 3: 环境领域服务 + environments 路由下沉

**Files:**
- Create: `apps/api/src/services/environments.service.ts`
- Modify: `apps/api/src/routes/environments.ts`
- Test: `apps/api/test/environments.service.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/test/environments.service.test.ts`(标准容器骨架 + 以下用例):

```ts
describe('environments.service', () => {
  it('createEnvironment:name 唯一,重复 → 409;listEnvironments 带脱敏 objects', async () => {
    const { projectId } = await seedProject(pool);
    const svc = await import('../src/services/environments.service.js');
    const env = await svc.createEnvironment(projectId, { name: '生产', baseUrl: 'https://prod.example.com' });
    await svc.insertEnvironmentObject(env.id, { objectType: 'db', payload: { host: 'h', dbName: 'd', user: 'u', password: 'SUPER-SECRET' }, isDefault: true });
    await expect(svc.createEnvironment(projectId, { name: '生产' })).rejects.toMatchObject({ status: 409, code: 'name_conflict' });

    const list = await svc.listEnvironments(projectId);
    expect(list).toHaveLength(1);
    expect(list[0]!.objects).toHaveLength(1);
    expect(JSON.stringify(list[0]!.objects)).not.toContain('SUPER-SECRET');
    expect(JSON.stringify(list[0]!.objects)).toContain('••••••••');
  }, 30_000);

  it('updateEnvironment:isDefault 互斥;upsertEnvironmentObject 合并保留旧密文,set_secret 换新密文', async () => {
    const { projectId } = await seedProject(pool);
    const svc = await import('../src/services/environments.service.js');
    const e1 = await svc.createEnvironment(projectId, { name: 'E1' });
    const e2 = await svc.createEnvironment(projectId, { name: 'E2' });
    const u1 = await svc.updateEnvironment(e1.id, { isDefault: true });
    expect(u1.isDefault).toBe(true);
    const u2 = await svc.updateEnvironment(e2.id, { isDefault: true });
    expect(u2.isDefault).toBe(true);
    const again = await svc.getEnvironment(e1.id);
    expect(again!.isDefault).toBe(false); // 被互斥降级

    const obj = await svc.insertEnvironmentObject(e1.id, { objectType: 'db', payload: { host: 'h' } });
    // upsert 同 (type,label):合并 payload;不带明文 → 旧密文保留
    await svc.setEnvironmentObjectSecret(obj.id, 'OLD-SECRET');
    const up = await svc.upsertEnvironmentObject(e1.id, { objectType: 'db', payload: { host: 'h2' } });
    const raw1 = (await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [obj.id])).rows[0]!.payload as Record<string, unknown>;
    expect((raw1 as { host: string }).host).toBe('h2');
    expect((raw1 as { secret?: { c: string } }).secret?.c).toBeTruthy();
    expect(JSON.stringify(raw1)).not.toContain('OLD-SECRET');
    expect(up.payload.secret).toBe('••••••••');
    expect(JSON.stringify(up)).not.toContain('OLD-SECRET');

    // set_secret 换新密文
    await svc.setEnvironmentObjectSecret(obj.id, 'NEW-SECRET');
    const raw2 = (await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [obj.id])).rows[0]!.payload as { secret: { c: string } };
    expect(raw2.secret.c).toBeTruthy();
    expect(Buffer.from(raw2.secret.c, 'base64').toString()).not.toContain('NEW-SECRET'); // 密文不是明文
  }, 30_000);

  it('deleteEnvironmentObject 晋升同类型兄弟为默认;environmentUsage 统计;deleteEnvironment 级联', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const svc = await import('../src/services/environments.service.js');
    const env = await svc.createEnvironment(projectId, { name: 'D' });
    const o1 = await svc.insertEnvironmentObject(env.id, { objectType: 'db', label: 'A', payload: {}, isDefault: true });
    const o2 = await svc.insertEnvironmentObject(env.id, { objectType: 'db', label: 'B', payload: {} });
    await svc.deleteEnvironmentObject(o1.id);
    const detail = await svc.getEnvironment(env.id);
    const b = detail!.objects.find((o) => o.label === 'B');
    expect(b!.isDefault).toBe(true);

    await pool.query(`INSERT INTO test_cases(group_id, version_id, title, default_env_id) SELECT id,$1,'c',$2 FROM groups WHERE project_id=$3 LIMIT 1`, [versionId, env.id, projectId]);
    const usage = await svc.environmentUsage(env.id);
    expect(usage.caseCount).toBe(1);
    await svc.deleteEnvironment(env.id);
    const raw = await pool.query(`SELECT default_env_id FROM test_cases WHERE title='c'`);
    expect(raw.rows[0]!.default_env_id).toBeNull(); // FK SET NULL
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/environments.service.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `services/environments.service.ts`**

把 `routes/environments.ts` 中的 `MASK` / `maskObjectPayload` / `normalizeObjectPayload` / `isUniqueViolation` 原样迁入并导出,再加 CRUD:

```ts
/**
 * 环境领域服务:环境与对象(db/syslog)的增删改查。
 * 秘密以 AES-256-GCM {c,i,t} 存 payload.secret;出参一律经 maskObjectPayload 脱敏。
 * 用户可见性(assertProjectVisible/assertEnvironmentVisible)由调用方(HTTP 边界)负责。
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { environmentObjects, executionPlans, testCases, testEnvironments } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { encrypt } from '../lib/secret-crypto.js';

export const OBJECT_MASK = '••••••••';
const OBJECT_TYPES = ['db', 'syslog'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

/** 出参掩码:payload.secret(AES 三元组)→ OBJECT_MASK。 */
export function maskObjectPayload(row: typeof environmentObjects.$inferSelect) {
  const payload = { ...((row.payload ?? {}) as Record<string, unknown>) };
  if (payload.secret) payload.secret = OBJECT_MASK;
  return { ...row, payload };
}

/** 入参归一(原 routes/environments.ts 逻辑原样迁入):payload.password / payload.privateKey
 *  明文 → 加密写 payload.secret;未提供 → 沿用 prev 旧密文。入参中的 secret 一律丢弃。 */
export function normalizeObjectPayload(
  objectType: ObjectType,
  payload: Record<string, unknown>,
  prev?: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...payload };
  delete out.secret;
  const plain = objectType === 'db'
    ? out.password
    : out.authType === 'password' ? out.password : out.privateKey;
  delete out.password;
  delete out.privateKey;
  if (typeof plain === 'string' && plain.length > 0) {
    const e = encrypt(plain);
    out.secret = { c: e.ciphertext.toString('base64'), i: e.iv.toString('base64'), t: e.tag.toString('base64') };
  } else if (prev?.secret) {
    out.secret = prev.secret;
  }
  return out;
}

export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

async function objectsOf(environmentId: string) {
  const rows = await db.select().from(environmentObjects)
    .where(eq(environmentObjects.environmentId, environmentId))
    .orderBy(asc(environmentObjects.createdAt));
  return rows.map(maskObjectPayload);
}

export async function listEnvironments(projectId: string) {
  const envs = await db.select().from(testEnvironments)
    .where(eq(testEnvironments.projectId, projectId))
    .orderBy(asc(testEnvironments.createdAt));
  const objs = envs.length
    ? await db.select().from(environmentObjects)
        .where(inArray(environmentObjects.environmentId, envs.map((e) => e.id)))
        .orderBy(asc(environmentObjects.createdAt))
    : [];
  const byEnv = new Map<string, typeof objs>();
  for (const o of objs) {
    const list = byEnv.get(o.environmentId) ?? [];
    list.push(o);
    byEnv.set(o.environmentId, list);
  }
  return envs.map((e) => ({ ...e, objects: (byEnv.get(e.id) ?? []).map(maskObjectPayload) }));
}

export async function getEnvironment(environmentId: string) {
  const env = (await db.select().from(testEnvironments).where(eq(testEnvironments.id, environmentId)).limit(1))[0];
  if (!env) return null;
  return { ...env, objects: await objectsOf(env.id) };
}

export async function createEnvironment(
  projectId: string,
  input: { name: string; baseUrl?: string | null; objects?: Array<{ objectType: ObjectType; label?: string; payload: Record<string, unknown>; isDefault?: boolean }> },
) {
  return db.transaction(async (tx) => {
    const inserted = (await tx.insert(testEnvironments).values({ projectId, name: input.name, baseUrl: input.baseUrl ?? null }).returning())[0]!;
    if (input.objects?.length) {
      await tx.insert(environmentObjects).values(input.objects.map((o) => ({
        environmentId: inserted.id,
        objectType: o.objectType,
        label: o.label ?? '默认',
        payload: normalizeObjectPayload(o.objectType, o.payload),
        isDefault: o.isDefault ?? false,
      })));
    }
    return inserted;
  }).catch((e) => {
    if (isUniqueViolation(e)) throw new HttpError(409, 'name_conflict', 'environment name already exists in this project');
    throw e;
  });
}

export async function updateEnvironment(environmentId: string, patch: { name?: string; baseUrl?: string | null; isDefault?: boolean }) {
  const row = await db.transaction(async (tx) => {
    const env = (await tx.select().from(testEnvironments).where(eq(testEnvironments.id, environmentId)).limit(1))[0];
    if (!env) throw new HttpError(404, 'not_found', 'environment not found');
    if (patch.isDefault === true) {
      await tx.update(testEnvironments).set({ isDefault: false }).where(eq(testEnvironments.projectId, env.projectId));
    }
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.baseUrl !== undefined) update.baseUrl = patch.baseUrl;
    if (patch.isDefault !== undefined) update.isDefault = patch.isDefault;
    return (await tx.update(testEnvironments).set(update).where(eq(testEnvironments.id, environmentId)).returning())[0]!;
  }).catch((e) => {
    if (isUniqueViolation(e)) throw new HttpError(409, 'name_conflict', 'environment name already exists in this project');
    throw e;
  });
  return { ...row, objects: await objectsOf(row.id) };
}

/** 删除前的引用计数(用例默认环境 + 计划环境)。 */
export async function environmentUsage(environmentId: string): Promise<{ caseCount: number; planCount: number }> {
  const caseCount = (await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.defaultEnvId, environmentId))).length;
  const planCount = (await db.select({ id: executionPlans.id }).from(executionPlans).where(eq(executionPlans.environmentId, environmentId))).length;
  return { caseCount, planCount };
}

export async function deleteEnvironment(environmentId: string): Promise<void> {
  const deleted = await db.delete(testEnvironments).where(eq(testEnvironments.id, environmentId)).returning({ id: testEnvironments.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'environment not found');
}

/** 新建对象(insert 语义,与原路由 POST /environments/:id/objects 一致)。 */
export async function insertEnvironmentObject(
  environmentId: string,
  input: { objectType: ObjectType; label?: string; payload: Record<string, unknown>; isDefault?: boolean },
) {
  const row = await db.transaction(async (tx) => {
    if (input.isDefault) {
      await tx.update(environmentObjects).set({ isDefault: false })
        .where(and(eq(environmentObjects.environmentId, environmentId), eq(environmentObjects.objectType, input.objectType)));
    }
    return (await tx.insert(environmentObjects).values({
      environmentId,
      objectType: input.objectType,
      label: input.label ?? '默认',
      payload: normalizeObjectPayload(input.objectType, input.payload),
      isDefault: input.isDefault ?? false,
    }).returning())[0]!;
  });
  return maskObjectPayload(row);
}

/** upsert(工具语义):同 (environmentId, objectType, label) 存在则合并 payload(旧密文沿用),否则新建。 */
export async function upsertEnvironmentObject(
  environmentId: string,
  input: { objectType: ObjectType; label?: string; payload: Record<string, unknown>; isDefault?: boolean },
) {
  const label = input.label ?? '默认';
  const row = await db.transaction(async (tx) => {
    if (input.isDefault) {
      await tx.update(environmentObjects).set({ isDefault: false })
        .where(and(eq(environmentObjects.environmentId, environmentId), eq(environmentObjects.objectType, input.objectType)));
    }
    const existing = (await tx.select().from(environmentObjects)
      .where(and(eq(environmentObjects.environmentId, environmentId), eq(environmentObjects.objectType, input.objectType), eq(environmentObjects.label, label)))
      .limit(1))[0];
    if (existing) {
      const prev = (existing.payload ?? {}) as Record<string, unknown>;
      const payload = normalizeObjectPayload(input.objectType, { ...prev, ...input.payload }, prev);
      const update: Record<string, unknown> = { payload, updatedAt: new Date() };
      if (input.isDefault !== undefined) update.isDefault = input.isDefault;
      return (await tx.update(environmentObjects).set(update).where(eq(environmentObjects.id, existing.id)).returning())[0]!;
    }
    return (await tx.insert(environmentObjects).values({
      environmentId,
      objectType: input.objectType,
      label,
      payload: normalizeObjectPayload(input.objectType, input.payload),
      isDefault: input.isDefault ?? false,
    }).returning())[0]!;
  });
  return maskObjectPayload(row);
}

export async function updateEnvironmentObject(objectId: string, patch: { label?: string; payload?: Record<string, unknown> }) {
  const existing = (await db.select().from(environmentObjects).where(eq(environmentObjects.id, objectId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'environment object not found');
  const payload = patch.payload !== undefined
    ? normalizeObjectPayload(existing.objectType as ObjectType, patch.payload, (existing.payload ?? {}) as Record<string, unknown>)
    : undefined;
  const rows = await db.update(environmentObjects).set({
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(payload !== undefined ? { payload: payload as object, updatedAt: new Date() } : {}),
  }).where(eq(environmentObjects.id, objectId)).returning();
  return maskObjectPayload(rows[0]!);
}

export async function deleteEnvironmentObject(objectId: string): Promise<void> {
  const existing = (await db.select().from(environmentObjects).where(eq(environmentObjects.id, objectId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'environment object not found');
  await db.transaction(async (tx) => {
    await tx.delete(environmentObjects).where(eq(environmentObjects.id, objectId));
    if (existing.isDefault) {
      const sibling = (await tx.select({ id: environmentObjects.id }).from(environmentObjects)
        .where(and(eq(environmentObjects.environmentId, existing.environmentId), eq(environmentObjects.objectType, existing.objectType)))
        .orderBy(asc(environmentObjects.createdAt)).limit(1))[0];
      if (sibling) await tx.update(environmentObjects).set({ isDefault: true }).where(eq(environmentObjects.id, sibling.id));
    }
  });
}

/** 工具 set_secret:直接替换 payload.secret(加密),其余字段不动。返回脱敏行。 */
export async function setEnvironmentObjectSecret(objectId: string, plain: string) {
  const existing = (await db.select().from(environmentObjects).where(eq(environmentObjects.id, objectId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'environment object not found');
  const e = encrypt(plain);
  const payload = {
    ...((existing.payload ?? {}) as Record<string, unknown>),
    secret: { c: e.ciphertext.toString('base64'), i: e.iv.toString('base64'), t: e.tag.toString('base64') },
  };
  const updated = (await db.update(environmentObjects).set({ payload: payload as object, updatedAt: new Date() })
    .where(eq(environmentObjects.id, objectId)).returning())[0]!;
  return maskObjectPayload(updated);
}

/** 按 (environmentId, objectType, label) 定位对象(工具 set_secret 用)。 */
export async function findEnvironmentObject(environmentId: string, objectType: ObjectType, label?: string) {
  const row = (await db.select().from(environmentObjects)
    .where(and(eq(environmentObjects.environmentId, environmentId), eq(environmentObjects.objectType, objectType), eq(environmentObjects.label, label ?? '默认')))
    .limit(1))[0];
  return row ?? null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/environments.service.test.ts`
Expected: PASS

- [ ] **Step 5: 路由下沉(`routes/environments.ts`)**

1. 删除本地 `MASK` / `maskObjectPayload` / `normalizeObjectPayload` / `isUniqueViolation` / `listEnvObjects`,顶部改 import:
   ```ts
   import { listEnvironments, createEnvironment, updateEnvironment, deleteEnvironment, environmentUsage, insertEnvironmentObject, updateEnvironmentObject, deleteEnvironmentObject, maskObjectPayload } from '../services/environments.service.js';
   ```
2. 各 handler 替换(可见性断言保留;`storedSecret` / `probeErrorText` / test-db / test-syslog 原样留在路由):
   - GET `/projects/:projectId/environments`:`res.json(await listEnvironments(projectId));`
   - POST `/projects/:projectId/environments`:`assertProjectVisible` + `CreateBody.parse` 后 `const env = await createEnvironment(projectId, body); res.json({ ...env, objects: await listEnvObjects等价 });` —— 直接:
     ```ts
     const env = await createEnvironment(projectId, body);
     res.json(await getEnvironment(env.id));
     ```
     (import 里补 `getEnvironment`;原 409 catch 删掉,service 已抛 HttpError 409)
   - PATCH `/environments/:id`:`assertEnvironmentVisible` + `EnvPatchBody.parse` 后 `res.json(await updateEnvironment(req.params.id!, body));`
   - DELETE `/environments/:id`:`assertEnvironmentVisible` 后引用计数用 `environmentUsage(req.params.id!)`,确认门槛逻辑(404 时 `deleteEnvironment`)原样保留。
   - POST `/environments/:id/objects`:`assertEnvironmentVisible` + `ObjectBody.parse` 后 `res.json(await insertEnvironmentObject(req.params.id!, body));`
   - PATCH `/environment-objects/:id`:存在性检查改由 service 404 兜底,但**必须先做可见性**(需要 environmentId):保留原「先 select 再 assertEnvironmentVisible」两行,然后:
     ```ts
     res.json(maskObjectPayload(await updateEnvironmentObject(req.params.id!, body)));
     ```
     (service updateEnvironmentObject 内部再查一次属可接受冗余;若嫌重复,可让 handler 直接保留原 update 语句——二选一,以 handler 里不出现 normalizeObjectPayload 为准。推荐:保留 select+assert,调 service。)
   - DELETE `/environment-objects/:id`:同上,保留 select+assert 后 `await deleteEnvironmentObject(req.params.id!); res.json({ ok: true });`
- [ ] **Step 6: 回归 + typecheck**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/environments.test.ts && pnpm typecheck`
Expected: PASS(无 environments.test.ts 则跑该 service 测试 + `grep -l environments test/` 命中的路由套件)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/environments.service.ts apps/api/src/routes/environments.ts apps/api/test/environments.service.test.ts
git commit -m "feat(api): 环境领域服务下沉(掩码/加密归一随迁)"
```

---

### Task 4: 计划领域服务 + plans 路由下沉

**Files:**
- Create: `apps/api/src/services/plans.service.ts`
- Modify: `apps/api/src/routes/plans.ts`
- Test: `apps/api/test/plans.service.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/test/plans.service.test.ts`(标准容器骨架 + 以下用例):

```ts
async function makeCase(groupId: string, versionId: string, title: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1,$2,$3) RETURNING id`, [groupId, versionId, title],
  )).rows[0]!.id as string;
}

describe('plans.service', () => {
  it('createPlan:version 跨项目 → 400;environmentId 跨项目 → 400;成功返回行', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const env = (await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1,'B环境') RETURNING id`, [b.projectId],
    )).rows[0]!.id as string;
    const svc = await import('../src/services/plans.service.js');
    await expect(svc.createPlan(a.projectId, { name: 'p', versionId: b.versionId }))
      .rejects.toMatchObject({ status: 400, code: 'version_mismatch' });
    const plan = await svc.createPlan(a.projectId, { name: '冒烟', versionId: a.versionId });
    await expect(svc.createPlan(a.projectId, { name: 'p2', versionId: a.versionId, environmentId: env }))
      .rejects.toMatchObject({ status: 400, code: 'env_project_mismatch' });
    expect(plan.versionId).toBe(a.versionId);
    expect(await svc.planProjectId(plan.id)).toBe(a.projectId);
  }, 30_000);

  it('replacePlanCases 跨项目 → 409;addCases 幂等追加;removeCases 后重排 1..m', async () => {
    const { groupId, versionId, projectId } = await seedProject(pool);
    const other = await seedProject(pool);
    const svc = await import('../src/services/plans.service.js');
    const c1 = await makeCase(groupId, versionId, 'c1');
    const c2 = await makeCase(groupId, versionId, 'c2');
    const c3 = await makeCase(groupId, versionId, 'c3');
    const plan = await svc.createPlan(projectId, { name: '全量', versionId });

    await expect(svc.replacePlanCases(plan.id, [c1, (await makeCase(other.groupId, other.versionId, 'x'))]))
      .rejects.toMatchObject({ status: 409, code: 'cross_project' });

    await svc.addPlanCases(plan.id, [c1, c2]);
    const addedAgain = await svc.addPlanCases(plan.id, [c2, c3]); // c2 已在 → 只追加 c3
    expect(addedAgain).toBe(1);
    let detail = await svc.getPlanDetail(plan.id);
    expect(detail!.cases.map((c) => c.order)).toEqual([1, 2, 3]);

    await svc.removePlanCases(plan.id, [c2]);
    detail = await svc.getPlanDetail(plan.id);
    expect(detail!.cases.map((c) => c.order)).toEqual([1, 2]); // c1, c3 重排
  }, 30_000);

  it('listPlansByVersion 带 caseCount;updatePlan 归属校验', async () => {
    const { groupId, versionId, projectId } = await seedProject(pool);
    const svc = await import('../src/services/plans.service.js');
    const plan = await svc.createPlan(projectId, { name: 'L', versionId });
    await svc.addPlanCases(plan.id, [await makeCase(groupId, versionId, 'lc')]);
    const list = await svc.listPlansByVersion(versionId);
    expect(list).toHaveLength(1);
    expect(list[0]!.caseCount).toBe(1);
    await expect(svc.updatePlan(plan.id, { versionId: (await seedProject(pool)).versionId }))
      .rejects.toMatchObject({ status: 400, code: 'version_mismatch' });
    const upd = await svc.updatePlan(plan.id, { name: 'L2', strategy: 'fail_fast' });
    expect(upd.name).toBe('L2');
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/plans.service.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `services/plans.service.ts`**

```ts
/**
 * 执行计划领域服务:计划 CRUD 与用例编排(replace/add/remove)。
 * 归属校验(计划 ∈ project、version/environment/cases ∈ 计划所属 project)在这里;
 * 用户可见性由调用方(HTTP 边界)负责。
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { executionPlans, groups, planCases, projectVersions, testCases, testEnvironments } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';

export async function planProjectId(planId: string): Promise<string | null> {
  const row = (await db.select({ projectId: executionPlans.projectId }).from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  return row?.projectId ?? null;
}

export async function listPlansByVersion(versionId: string) {
  const plans = await db.select().from(executionPlans)
    .where(eq(executionPlans.versionId, versionId))
    .orderBy(asc(executionPlans.createdAt));
  const pcs = plans.length
    ? await db.select().from(planCases).where(inArray(planCases.planId, plans.map((p) => p.id)))
    : [];
  const countByPlan = new Map<string, number>();
  for (const pc of pcs) countByPlan.set(pc.planId, (countByPlan.get(pc.planId) ?? 0) + 1);
  return plans.map((p) => ({ ...p, caseCount: countByPlan.get(p.id) ?? 0 }));
}

export interface LoginPrepareInput {
  enabled: boolean;
  caseId?: string | null;
  detectionUrl?: string | null;
  successSelector?: string | null;
  unauthorizedKeywords?: string[] | null;
}

export interface CreatePlanInput {
  name: string;
  versionId: string;
  environment?: string;
  environmentId?: string;
  strategy?: string;
  loginPrepare?: LoginPrepareInput;
}

async function assertVersionInProject(versionId: string, projectId: string): Promise<void> {
  const v = (await db.select({ projectId: projectVersions.projectId }).from(projectVersions).where(eq(projectVersions.id, versionId)).limit(1))[0];
  if (!v) throw new HttpError(404, 'not_found', 'version not found');
  if (v.projectId !== projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
}

async function assertEnvInProject(environmentId: string, projectId: string): Promise<void> {
  const e = (await db.select({ projectId: testEnvironments.projectId }).from(testEnvironments).where(eq(testEnvironments.id, environmentId)).limit(1))[0];
  if (!e) throw new HttpError(404, 'not_found', 'environment not found');
  if (e.projectId !== projectId) throw new HttpError(400, 'env_project_mismatch', 'environment does not belong to this project');
}

export async function createPlan(projectId: string, input: CreatePlanInput) {
  await assertVersionInProject(input.versionId, projectId);
  if (input.environmentId) await assertEnvInProject(input.environmentId, projectId);
  if (input.strategy && !['run_all', 'fail_fast'].includes(input.strategy)) {
    throw new HttpError(400, 'bad_strategy', `invalid strategy: ${input.strategy}`);
  }
  return (
    await db.insert(executionPlans).values({
      projectId,
      name: input.name,
      versionId: input.versionId,
      environment: input.environment,
      environmentId: input.environmentId,
      strategy: input.strategy ?? 'run_all',
      loginPrepareEnabled: input.loginPrepare?.enabled ?? false,
      loginCaseId: input.loginPrepare?.caseId ?? null,
      detectionUrl: input.loginPrepare?.detectionUrl ?? null,
      loginSuccessSelector: input.loginPrepare?.successSelector ?? null,
      loginUnauthorizedKeywords: input.loginPrepare?.unauthorizedKeywords ?? null,
    }).returning()
  )[0]!;
}

export interface UpdatePlanPatch {
  name?: string;
  environment?: string;
  environmentId?: string | null;
  versionId?: string | null;
  strategy?: string;
  loginPrepare?: LoginPrepareInput;
}

export async function updatePlan(planId: string, patch: UpdatePlanPatch) {
  const existing = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan not found');
  if (patch.versionId !== undefined && patch.versionId !== null) await assertVersionInProject(patch.versionId, existing.projectId);
  if (patch.environmentId !== undefined && patch.environmentId !== null) await assertEnvInProject(patch.environmentId, existing.projectId);
  if (patch.strategy !== undefined && !['run_all', 'fail_fast'].includes(patch.strategy)) {
    throw new HttpError(400, 'bad_strategy', `invalid strategy: ${patch.strategy}`);
  }
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.environment !== undefined) update.environment = patch.environment;
  if (patch.environmentId !== undefined) update.environmentId = patch.environmentId;
  if (patch.versionId !== undefined) update.versionId = patch.versionId;
  if (patch.strategy !== undefined) update.strategy = patch.strategy;
  if (patch.loginPrepare !== undefined) {
    update.loginPrepareEnabled = patch.loginPrepare.enabled;
    update.loginCaseId = patch.loginPrepare.caseId ?? null;
    update.detectionUrl = patch.loginPrepare.detectionUrl ?? null;
    update.loginSuccessSelector = patch.loginPrepare.successSelector ?? null;
    update.loginUnauthorizedKeywords = patch.loginPrepare.unauthorizedKeywords ?? null;
  }
  const rows = await db.update(executionPlans).set(update).where(eq(executionPlans.id, planId)).returning();
  return rows[0]!;
}

/** 计划详情:cases 按 order 带 title/url/versionId;versionName 一并解析。 */
export async function getPlanDetail(planId: string) {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!plan) return null;
  const pcs = await db.select().from(planCases).where(eq(planCases.planId, plan.id)).orderBy(asc(planCases.order));
  const cases = pcs.length
    ? await db.select().from(testCases).where(inArray(testCases.id, pcs.map((p) => p.caseId)))
    : [];
  const byId = new Map(cases.map((c) => [c.id, c]));
  let versionName: string | null = null;
  if (plan.versionId) {
    const v = (await db.select({ name: projectVersions.name }).from(projectVersions).where(eq(projectVersions.id, plan.versionId)).limit(1))[0];
    versionName = v?.name ?? null;
  }
  return {
    ...plan,
    versionName,
    cases: pcs.map((pc) => ({
      id: pc.caseId,
      order: pc.order,
      title: byId.get(pc.caseId)?.title ?? 'unknown',
      url: byId.get(pc.caseId)?.url ?? null,
      versionId: byId.get(pc.caseId)?.versionId ?? null,
    })),
  };
}

/** 所有 caseIds 必须属于计划所属项目(经分组归属)。 */
async function assertCasesInProject(projectId: string, caseIds: string[]): Promise<void> {
  if (caseIds.length === 0) return;
  const gs = await db.select({ id: groups.id }).from(groups).where(eq(groups.projectId, projectId));
  const validGids = new Set(gs.map((g) => g.id));
  const rows = await db.select({ groupId: testCases.groupId }).from(testCases).where(inArray(testCases.id, caseIds));
  if (rows.length !== caseIds.length || !rows.every((r) => validGids.has(r.groupId))) {
    throw new HttpError(409, 'cross_project', 'all cases must belong to the plan project');
  }
}

async function requirePlan(planId: string) {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  return plan;
}

export async function replacePlanCases(planId: string, caseIds: string[]): Promise<void> {
  const plan = await requirePlan(planId);
  await assertCasesInProject(plan.projectId, caseIds);
  await db.delete(planCases).where(eq(planCases.planId, planId));
  await db.insert(planCases).values(caseIds.map((caseId, i) => ({ planId, caseId, order: i + 1 })));
}

/** 追加用例(已存在的跳过),返回实际新增数;order 接 max+1。 */
export async function addPlanCases(planId: string, caseIds: string[]): Promise<number> {
  const plan = await requirePlan(planId);
  await assertCasesInProject(plan.projectId, caseIds);
  const existing = await db.select({ caseId: planCases.caseId }).from(planCases).where(eq(planCases.planId, planId));
  const have = new Set(existing.map((e) => e.caseId));
  const fresh = [...new Set(caseIds)].filter((c) => !have.has(c));
  if (fresh.length === 0) return 0;
  const base = Number((await db.select({ m: sql<number>`coalesce(max("order"), 0)` }).from(planCases).where(eq(planCases.planId, planId)))[0]?.m ?? 0);
  await db.insert(planCases).values(fresh.map((caseId, i) => ({ planId, caseId, order: base + i + 1 })));
  return fresh.length;
}

/** 移除用例并把剩余重排为 1..m,返回移除数。 */
export async function removePlanCases(planId: string, caseIds: string[]): Promise<number> {
  await requirePlan(planId);
  if (caseIds.length === 0) return 0;
  const removed = await db.delete(planCases)
    .where(and(eq(planCases.planId, planId), inArray(planCases.caseId, caseIds)))
    .returning({ id: planCases.id });
  const rest = await db.select({ caseId: planCases.caseId }).from(planCases)
    .where(eq(planCases.planId, planId)).orderBy(asc(planCases.order));
  if (rest.length > 0) {
    await db.delete(planCases).where(eq(planCases.planId, planId));
    await db.insert(planCases).values(rest.map((r, i) => ({ planId, caseId: r.caseId, order: i + 1 })));
  }
  return removed.length;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/plans.service.test.ts`
Expected: PASS

- [ ] **Step 5: 路由下沉(`routes/plans.ts`)**

顶部 import:
```ts
import { createPlan, updatePlan, getPlanDetail, replacePlanCases, planProjectId } from '../services/plans.service.js';
```

- POST `/`:`assertProjectVisible` + versionId 必填 400 + `assertVersionVisible` + vp 校验后:`res.json(await createPlan(projectId, body));`(service 内归属重复校验属可接受冗余)
- GET `/:id`:`const detail = await getPlanDetail(req.params.id!); if (!detail) throw 404; await assertProjectVisible(detail.projectId, req.user!); res.json(detail);`
- PATCH `/:id`:保留「先查存在 + assertProjectVisible」,然后 `res.json(await updatePlan(req.params.id!, body));`(service 兜底 version/env 归属)
- PUT `/:id/cases` 与 PUT `/:id/cases/order`:
  ```ts
  plansRoute.put('/:id/cases', async (req, res) => {
    const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
    const pid = await planProjectId(req.params.id!);
    if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
    await assertProjectVisible(pid, req.user!);
    await replacePlanCases(req.params.id!, caseIds);
    res.json({ ok: true });
  });
  ```
  (`order` 端点同款;本地 `validateCaseProject` 删除)
- GET `/`(列表)与 login-cases/run 端点保持原样。

- [ ] **Step 6: 回归 + typecheck**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/plans.test.ts && pnpm typecheck`
Expected: PASS(无 plans.test.ts 则跑 service 测试 + 相关路由套件)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/plans.service.ts apps/api/src/routes/plans.ts apps/api/test/plans.service.test.ts
git commit -m "feat(api): 执行计划领域服务下沉(cases 编排含 add/remove 重排)"
```

---

### Task 5: 工具目录骨架(context/diff/stage/announce/inspect)+ tools.ts 转 tools/

**Files:**
- Create: `apps/api/src/pi/space/tools/context.ts`、`diff.ts`、`stage.ts`、`announce.ts`、`inspect.ts`、`index.ts`
- Delete: `apps/api/src/pi/space/tools.ts`
- Modify: `apps/api/src/pi/space/session.ts:9`(import 路径)
- Test: `apps/api/test/space-tools-basic.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/test/space-tools-basic.test.ts`(无需数据库,纯装配测试):

```ts
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildSpaceTools, type SpaceToolsContext } from '../src/pi/space/tools/index.js';

function makeCtx(over: Partial<SpaceToolsContext> = {}): { ctx: SpaceToolsContext; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const ctx: SpaceToolsContext = {
    threadId: randomUUID(),
    versionId: randomUUID(),
    projectId: randomUUID(),
    cwd: null,
    repoAvailable: false,
    emit: (e) => events.push(e),
    ...over,
  };
  return { ctx, events };
}

describe('buildSpaceTools(骨架)', () => {
  it('repo 不可用时不注入 repo 工具;注入 announce_plan 与 inspect_page', () => {
    const { ctx } = makeCtx();
    const names = buildSpaceTools(ctx).map((t) => t.name);
    expect(names).toContain('announce_plan');
    expect(names).toContain('inspect_page');
    expect(names.filter((n) => n.startsWith('repo_'))).toEqual([]);
  });

  it('repo 可用时注入 repo 沙箱工具', () => {
    const { ctx } = makeCtx({ repoAvailable: true, cwd: '/tmp' });
    const names = buildSpaceTools(ctx).map((t) => t.name);
    expect(names.some((n) => n.startsWith('repo_'))).toBe(true);
  });

  it('announce_plan 广播 announce 事件(summary/total/steps)并回 ok', async () => {
    const { ctx, events } = makeCtx();
    const tool = buildSpaceTools(ctx).find((t) => t.name === 'announce_plan')!;
    const r = await tool.execute({ summary: '配置登录模块', steps: ['建分组', '建用例A', '建用例B'] });
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'announce', summary: '配置登录模块', total: 3 });
    expect((events[0] as { steps: string[] }).steps).toEqual(['建分组', '建用例A', '建用例B']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/space-tools-basic.test.ts`
Expected: FAIL — `buildSpaceTools` 从 `tools/index.js` 导入失败

- [ ] **Step 3: 实现 6 个文件并删除旧 tools.ts**

`src/pi/space/tools/context.ts`:
```ts
/** 空间工具运行上下文:由 session.ts 按 thread 构建,经闭包注入各工具。 */
export interface SpaceToolsContext {
  threadId: string;
  versionId: string;
  projectId: string;
  cwd: string | null;
  repoAvailable: boolean;
  /** 向当前线程 SSE 订阅者广播自定义事件(confirm_request / stage / announce 等)。 */
  emit: (e: Record<string, unknown>) => void;
}
```

`src/pi/space/tools/diff.ts`:
```ts
/** 标量字段 diff 文本:`k: before → after`(按键排序);对象/数组字段与 updatedAt 跳过。无变化返回 undefined。 */
export function diffText(before: Record<string, unknown>, after: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  for (const k of Object.keys(before).sort()) {
    if (k === 'updatedAt' || !(k in after)) continue;
    const b = before[k];
    const a = after[k];
    if (b === a) continue;
    if (b !== null && typeof b === 'object') continue;
    if (a !== null && typeof a === 'object') continue;
    lines.push(`${k}: ${String(b)} → ${String(a)}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}
```

`src/pi/space/tools/stage.ts`:
```ts
import type { SpaceToolsContext } from './context.js';

export type StageKind = 'case' | 'scenario' | 'environment' | 'plan' | 'group';

/** 广播舞台事件:Plan 3 前端据此高亮/滚动到被操作的对象。 */
export function emitStage(ctx: SpaceToolsContext, e: { kind: StageKind; id: string; action: string; diff?: string }): void {
  ctx.emit({ type: 'stage', kind: e.kind, id: e.id, action: e.action, ...(e.diff ? { diff: e.diff } : {}) });
}
```

`src/pi/space/tools/announce.ts`:
```ts
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

export function buildAnnounceTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'announce_plan',
    description: '向用户宣告本次任务计划(舞台展示)。在开始一系列写操作(建用例/改环境/配计划等)之前调用:给出一句话总结与步骤清单。',
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 500 }),
      steps: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 20 }),
    }),
    execute: async (input) => {
      const v = input as { summary: string; steps: string[] };
      ctx.emit({ type: 'announce', summary: v.summary, total: v.steps.length, steps: v.steps });
      return { ok: true };
    },
  };
}
```

`src/pi/space/tools/inspect.ts`:
```ts
import { Type } from '@earendil-works/pi-ai';
import { inspectPage } from '../../inspectPage.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

export function buildInspectTool(_ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'inspect_page',
    description:
      '抓取被测页面并返回实际可交互元素清单(按钮/输入框/链接/选择器/文案,含 data-testid)。创建带步骤的用例前,若知道页面 URL,先调用本工具获取真实元素,禁止凭「典型实现」臆造 locator。快照仅为页面初始状态,操作后才出现的元素不在其中。',
    parameters: Type.Object({
      url: Type.String({ minLength: 8, maxLength: 2000 }),
    }),
    execute: async (input) => {
      const { url } = input as { url: string };
      try {
        return { ok: true, data: await inspectPage(url) };
      } catch (e) {
        return { ok: false, error: `页面抓取失败:${(e as Error).message}` };
      }
    },
  };
}
```

`src/pi/space/tools/index.ts`:
```ts
/**
 * 空间助手工具装配(原单文件 tools.ts 的目录化接缝)。
 * Plan 2:repo 沙箱(可用时)+ announce_plan + inspect_page + 四个领域工具。
 * 保持与 pi/tools.ts 相同的 ToolExecutor 形状(TypeBox schema + 可单测 execute)。
 */
import type { ToolExecutor } from '../../tools.js';
import { buildRepoSandboxTools } from '../../repo.js';
import type { SpaceToolsContext } from './context.js';
import { buildAnnounceTool } from './announce.js';
import { buildInspectTool } from './inspect.js';

export type { SpaceToolsContext } from './context.js';
export { emitStage, type StageKind } from './stage.js';
export { diffText } from './diff.js';

export function buildSpaceTools(ctx: SpaceToolsContext): ToolExecutor[] {
  const tools: ToolExecutor[] = [];
  if (ctx.repoAvailable && ctx.cwd) tools.push(...buildRepoSandboxTools(ctx.cwd));
  tools.push(buildAnnounceTool(ctx), buildInspectTool(ctx));
  return tools;
}
```

删除 `src/pi/space/tools.ts`;`src/pi/space/session.ts:9` 改为:
```ts
import { buildSpaceTools } from './tools/index.js';
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/space-tools-basic.test.ts && pnpm typecheck`
Expected: PASS;typecheck 无错(session.ts 引用未断)

- [ ] **Step 5: 冒烟:space 相关既有测试不回归**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/space-router.test.ts test/space-summary.test.ts`
Expected: PASS(testcontainers 偶发超时 → 隔离重跑)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pi/space/tools apps/api/src/pi/space/session.ts apps/api/test/space-tools-basic.test.ts
git rm apps/api/src/pi/space/tools.ts
git commit -m "refactor(api): 空间工具接缝目录化,注入 announce/inspect"
```

---

### Task 6: manage_cases 工具

**Files:**
- Modify: `apps/api/src/pi/tools.ts`(normalizeCompiledStep 加 export)
- Create: `apps/api/src/pi/space/tools/cases.ts`
- Modify: `apps/api/src/pi/space/tools/index.ts`(装配)
- Test: `apps/api/test/space-tools-cases.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/test/space-tools-cases.test.ts`(标准容器骨架 + 以下):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import { buildCasesTools } from '../src/pi/space/tools/cases.js';
import type { SpaceToolsContext } from '../src/pi/space/tools/context.js';
import { resolveConfirmation } from '../src/pi/space/confirm.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

function makeCtx(over: Partial<SpaceToolsContext> = {}): { ctx: SpaceToolsContext; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const ctx: SpaceToolsContext = {
    threadId: randomUUID(), versionId: '', projectId: '', cwd: null, repoAvailable: false,
    emit: (e) => events.push(e), ...over,
  };
  return { ctx, events };
}

/** execute 在 confirm 前有异步 DB 查询 → 轮询等 confirm_request。 */
async function untilConfirm(events: Array<Record<string, unknown>>): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const e = events.find((x) => x.type === 'confirm_request');
    if (e) return String(e.confirmId);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('confirm_request not emitted');
}

describe('manage_cases 工具', () => {
  it('create:compiled click 展开为具体步骤行;stage(create) 广播', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildCasesTools(ctx)[0]!;
    const r = await tool.execute({
      action: 'create', title: '下单流程', groupId: seed.groupId,
      steps: [
        { action: '打开首页', compiled: [{ kind: 'navigate', url: 'https://a.example.com/' }] },
        { action: '点击下单', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '.buy' }] }], assertion: '出现成功提示' },
      ],
    });
    expect(r.ok).toBe(true);
    const steps = (await pool.query(
      `SELECT s.action FROM test_steps s JOIN test_cases c ON c.id = s.case_id WHERE c.title = '下单流程' ORDER BY s."order"`,
    )).rows as Array<{ action: { kind: string } }>;
    expect(steps.map((s) => s.action.kind)).toEqual(['navigate', 'click']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'stage', kind: 'case', action: 'create' }));
  }, 30_000);

  it('update:字段生效且 stage 带 diff;跨版本 caseId 拒绝', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildCasesTools(ctx)[0]!;
    await tool.execute({ action: 'create', title: '旧名', groupId: seed.groupId });
    const caseId = (await pool.query(`SELECT id FROM test_cases WHERE title='旧名'`)).rows[0]!.id as string;
    events.length = 0;
    const r = await tool.execute({ action: 'update', caseId, title: '新名', priority: 'P0' });
    expect(r.ok).toBe(true);
    const stage = events.find((e) => e.type === 'stage') as { diff?: string };
    expect(stage.diff).toContain('title: 旧名 → 新名');
    expect(stage.diff).toContain('priority: P1 → P0');

    const other = await seedProject(pool);
    const { ctx: ctx2 } = makeCtx({ projectId: other.projectId, versionId: other.versionId });
    const r2 = await buildCasesTools(ctx2)[0]!.execute({ action: 'update', caseId, title: '越权' });
    expect(r2).toMatchObject({ ok: false });
    expect((r2 as { error: string }).error).toContain('不属于当前版本');
  }, 30_000);

  it('delete:确认被拒 → 返回取消且用例仍在;确认通过 → 删除', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildCasesTools(ctx)[0]!;
    await tool.execute({ action: 'create', title: '待删用例', groupId: seed.groupId });
    const caseId = (await pool.query(`SELECT id FROM test_cases WHERE title='待删用例'`)).rows[0]!.id as string;

    const rejected = tool.execute({ action: 'delete', caseId });
    const cid = await untilConfirm(events);
    resolveConfirmation(cid, false);
    expect(await rejected).toMatchObject({ ok: false, error: '用户取消了该操作' });
    expect((await pool.query(`SELECT id FROM test_cases WHERE id=$1`, [caseId])).rowCount).toBe(1);

    events.length = 0;
    const approved = tool.execute({ action: 'delete', caseId });
    const cid2 = await untilConfirm(events);
    resolveConfirmation(cid2, true);
    expect(await approved).toMatchObject({ ok: true });
    expect((await pool.query(`SELECT id FROM test_cases WHERE id=$1`, [caseId])).rowCount).toBe(0);
  }, 30_000);

  it('归属校验:他项目分组 create_group/move_group 被拒;search 关键词过滤;create_group 建组可用', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildCasesTools(ctx)[0]!;

    const badGroup = await tool.execute({ action: 'create', title: 'x', groupId: other.groupId });
    expect(badGroup).toMatchObject({ ok: false });

    const g = await tool.execute({ action: 'create_group', groupName: 'AI分组', groupDefaultUrl: 'https://g.example.com' });
    expect(g.ok).toBe(true);
    const gid = (await pool.query(`SELECT id FROM groups WHERE name='AI分组' AND project_id=$1`, [seed.projectId])).rows[0]!.id as string;

    await tool.execute({ action: 'create', title: '登录成功用例', groupId: gid });
    await tool.execute({ action: 'create', title: '支付用例', groupId: gid });
    const search = await tool.execute({ action: 'search', keyword: '登录' });
    expect((search as { ok: true; data: string }).data).toContain('登录成功用例');
    expect((search as { ok: true; data: string }).data).not.toContain('支付用例');

    const caseId = (await pool.query(`SELECT id FROM test_cases WHERE title='登录成功用例'`)).rows[0]!.id as string;
    const moved = await tool.execute({ action: 'move_group', caseId, targetGroupId: seed.groupId });
    expect(moved.ok).toBe(true);
    const crossMove = await tool.execute({ action: 'move_group', caseId, targetGroupId: other.groupId });
    expect(crossMove).toMatchObject({ ok: false });
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/space-tools-cases.test.ts`
Expected: FAIL — `tools/cases.js` 不存在

- [ ] **Step 3: 导出 normalizeCompiledStep(`src/pi/tools.ts`)**

```ts
// 改:第 27 行
function normalizeCompiledStep(step: unknown): unknown {
// 为
export function normalizeCompiledStep(step: unknown): unknown {
```

- [ ] **Step 4: 实现 `src/pi/space/tools/cases.ts`**

```ts
/**
 * manage_cases:版本内用例检索/详情/创建/改元数据/删除/移动分组/建分组。
 * 归属校验(实体 ∈ ctx.projectId / ctx.versionId)在这里;per-user 可见性在 HTTP 边界。
 * delete 走阻塞确认;其余写操作广播 stage 事件(非阻塞)。
 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/cases.service.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';
import { requestConfirmation } from '../confirm.js';

const Actions = z.object({
  action: z.enum(['search', 'get', 'create', 'update', 'delete', 'move_group', 'create_group']),
  caseId: z.string().uuid().optional(),
  keyword: z.string().max(200).optional(),
  groupId: z.string().uuid().optional(),
  targetGroupId: z.string().uuid().optional(),
  groupName: z.string().min(1).max(200).optional(),
  groupDefaultUrl: z.string().max(2000).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  status: z.enum(['draft', 'review', 'ready', 'deprecated']).optional(),
  url: z.string().max(2000).nullable().optional(),
  steps: z.array(z.object({
    action: z.string().min(1).max(2000),
    assertion: z.string().max(2000).nullable().optional(),
    compiled: z.array(z.unknown()).optional(),
  })).max(30).optional(),
  tagIds: z.array(z.string().uuid()).optional(),
});

export function buildCasesTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_cases',
      description:
        '用例管理。action=search(版本内检索,可带 keyword/groupId)| get(caseId,含步骤与标签)| create(title+groupId 必填,可带 description/priority/url/steps/tagIds)| update(caseId + title/description/priority/status/url 任一)| delete(caseId,需用户确认)| move_group(caseId+targetGroupId)| create_group(groupName,可带 groupDefaultUrl 作为用例默认入口 URL)。',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('search'), Type.Literal('get'), Type.Literal('create'), Type.Literal('update'),
          Type.Literal('delete'), Type.Literal('move_group'), Type.Literal('create_group'),
        ]),
        caseId: Type.Optional(Type.String()),
        keyword: Type.Optional(Type.String()),
        groupId: Type.Optional(Type.String()),
        targetGroupId: Type.Optional(Type.String()),
        groupName: Type.Optional(Type.String()),
        groupDefaultUrl: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        priority: Type.Optional(Type.Union([Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2'), Type.Literal('P3')])),
        status: Type.Optional(Type.Union([Type.Literal('draft'), Type.Literal('review'), Type.Literal('ready'), Type.Literal('deprecated')])),
        url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        steps: Type.Optional(Type.Array(Type.Object({
          action: Type.String({ minLength: 1, maxLength: 2000 }),
          assertion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          compiled: Type.Optional(Type.Array(Type.Unknown())),
        }), { maxItems: 30 })),
        tagIds: Type.Optional(Type.Array(Type.String())),
      }),
      promptGuidelines: [
        '创建用例前先 search 相近标题避免重复;groupId 必须来自上下文摘要、search 或 create_group 的结果,禁止臆造 id。',
        '写 steps 时:action 是人类可读操作指令,assertion 是预期结果文本;若仓库可用,先用 repo_ls/repo_read/repo_grep 看真实源码再给 compiled(DSL:允许 kind = navigate{url}/click{locator}/fill{locator,value}/hover{locator}/waitFor{locator,timeoutMs?}/assertText{locator,equals}/assertVisible{locator}/check{locator,checked}/select{locator,value}/extract{locator,varName})。',
        'locator 必须是一层数组,每个元素是 {strategy, value},strategy 限 role/text/testId/css/xpath;不知道真实元素就省略 compiled(不要编造),或先调 inspect_page 抓页面。',
        'delete 会向用户发确认卡;被拒或超时返回取消,不要重试同一删除。',
      ],
      execute: async (input) => {
        let v: z.infer<typeof Actions>;
        try {
          v = Actions.parse(input);
        } catch (e) {
          if (e instanceof z.ZodError) {
            return { ok: false, error: `参数不合法:${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
          }
          throw e;
        }
        try {
          switch (v.action) {
            case 'search': {
              if (v.groupId) {
                const pid = await svc.groupProjectId(v.groupId);
                if (pid !== ctx.projectId) return { ok: false, error: '分组不存在或不属于当前项目' };
              }
              const rows = await svc.searchCasesInVersion(ctx.versionId, { keyword: v.keyword, groupId: v.groupId });
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
            case 'get': {
              if (!v.caseId) return { ok: false, error: 'get 需要 caseId' };
              const detail = await svc.getCaseDetail(v.caseId);
              if (!detail || detail.versionId !== ctx.versionId) return { ok: false, error: '用例不存在或不属于当前版本' };
              return { ok: true, data: JSON.stringify(detail, null, 2) };
            }
            case 'create': {
              if (!v.title) return { ok: false, error: 'create 需要 title' };
              if (!v.groupId) return { ok: false, error: 'create 需要 groupId(可先用 create_group 创建)' };
              const created = await svc.createCaseWithSteps({
                groupId: v.groupId, versionId: ctx.versionId, title: v.title,
                description: v.description, priority: v.priority, url: v.url, tagIds: v.tagIds,
                steps: v.steps,
              });
              emitStage(ctx, { kind: 'case', id: created.id, action: 'create' });
              return { ok: true, data: `已创建用例「${created.title}」(${created.id})` };
            }
            case 'update': {
              if (!v.caseId) return { ok: false, error: 'update 需要 caseId' };
              const before = await svc.getCaseDetail(v.caseId);
              if (!before || before.versionId !== ctx.versionId) return { ok: false, error: '用例不存在或不属于当前版本' };
              const patch: Record<string, unknown> = {};
              if (v.title !== undefined) patch.title = v.title;
              if (v.description !== undefined) patch.description = v.description;
              if (v.priority !== undefined) patch.priority = v.priority;
              if (v.status !== undefined) patch.status = v.status;
              if (v.url !== undefined) patch.url = v.url;
              if (Object.keys(patch).length === 0) return { ok: false, error: 'update 未提供任何要修改的字段(title/description/priority/status/url)' };
              const after = await svc.updateCase(v.caseId, patch);
              emitStage(ctx, { kind: 'case', id: v.caseId, action: 'update', diff: diffText(before, after) });
              return { ok: true, data: `已更新用例「${after.title}」` };
            }
            case 'delete': {
              if (!v.caseId) return { ok: false, error: 'delete 需要 caseId' };
              const detail = await svc.getCaseDetail(v.caseId);
              if (!detail || detail.versionId !== ctx.versionId) return { ok: false, error: '用例不存在或不属于当前版本' };
              const approved = await requestConfirmation(
                { threadId: ctx.threadId, toolName: 'manage_cases', action: 'delete', summary: `删除用例「${detail.title}」`, risk: 'delete' },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.deleteCase(v.caseId);
              emitStage(ctx, { kind: 'case', id: v.caseId, action: 'delete' });
              return { ok: true, data: `已删除用例「${detail.title}」` };
            }
            case 'move_group': {
              if (!v.caseId || !v.targetGroupId) return { ok: false, error: 'move_group 需要 caseId 与 targetGroupId' };
              const before = await svc.getCaseDetail(v.caseId);
              if (!before || before.versionId !== ctx.versionId) return { ok: false, error: '用例不存在或不属于当前版本' };
              const targetPid = await svc.groupProjectId(v.targetGroupId);
              if (targetPid !== ctx.projectId) return { ok: false, error: '目标分组不存在或不属于当前项目' };
              await svc.updateCase(v.caseId, { groupId: v.targetGroupId });
              emitStage(ctx, { kind: 'case', id: v.caseId, action: 'move_group', diff: `groupId: ${before.groupId} → ${v.targetGroupId}` });
              return { ok: true, data: `已把用例「${before.title}」移动到分组 ${v.targetGroupId}` };
            }
            case 'create_group': {
              if (!v.groupName) return { ok: false, error: 'create_group 需要 groupName' };
              const g = await svc.createGroup(ctx.projectId, {
                name: v.groupName,
                ...(v.groupDefaultUrl !== undefined ? { defaultUrl: v.groupDefaultUrl } : {}),
              });
              emitStage(ctx, { kind: 'group', id: g.id, action: 'create' });
              return { ok: true, data: `已创建分组「${g.name}」(${g.id})` };
            }
          }
        } catch (e) {
          if (e instanceof HttpError) return { ok: false, error: e.message };
          return { ok: false, error: `操作失败:${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  ];
}
```

- [ ] **Step 5: 装配(`tools/index.ts`)**

```ts
import { buildCasesTools } from './cases.js';
// buildSpaceTools 中追加:
  tools.push(...buildCasesTools(ctx));
```

- [ ] **Step 6: 跑测试确认通过 + typecheck**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/space-tools-cases.test.ts test/space-tools-basic.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/pi/tools.ts apps/api/src/pi/space/tools/cases.ts apps/api/src/pi/space/tools/index.ts apps/api/test/space-tools-cases.test.ts
git commit -m "feat(api): manage_cases 空间工具(aiStep 即时展开/阻塞确认删除/舞台事件)"
```

---

### Task 7: manage_scenarios 工具

**Files:**
- Create: `apps/api/src/pi/space/tools/scenarios.ts`
- Modify: `apps/api/src/pi/space/tools/index.ts`(装配)
- Test: `apps/api/test/space-tools-scenarios.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/test/space-tools-scenarios.test.ts`(标准容器骨架 + makeCtx/untilConfirm 同 Task 6 + 以下):

```ts
import { buildScenariosTools } from '../src/pi/space/tools/scenarios.js';
import { resolveConfirmation } from '../src/pi/space/confirm.js';

describe('manage_scenarios 工具', () => {
  async function makeRequirement(projectId: string): Promise<string> {
    return (await pool.query(
      `INSERT INTO requirements(project_id, title, content) VALUES ($1,'登录模块','c') RETURNING id`, [projectId],
    )).rows[0]!.id as string;
  }

  it('create:跨项目 requirement 拒绝;本项目 requirement 建场景并广播 stage', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildScenariosTools(ctx)[0]!;
    const foreignRid = await makeRequirement(other.projectId);
    const bad = await tool.execute({ action: 'create', requirementId: foreignRid, title: '越权场景' });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { error: string }).error).toContain('不属于当前项目');

    const rid = await makeRequirement(seed.projectId);
    const r = await tool.execute({ action: 'create', requirementId: rid, title: '密码登录', description: '账密' });
    expect(r.ok).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'stage', kind: 'scenario', action: 'create' }));

    const list = await tool.execute({ action: 'list' });
    expect((list as { data: string }).data).toContain('密码登录');
  }, 30_000);

  it('update:改名生效且 stage 带 diff', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildScenariosTools(ctx)[0]!;
    const rid = await makeRequirement(seed.projectId);
    await tool.execute({ action: 'create', requirementId: rid, title: '旧场景' });
    const sid = (await pool.query(`SELECT id FROM scenarios WHERE title='旧场景'`)).rows[0]!.id as string;
    events.length = 0;
    const r = await tool.execute({ action: 'update', scenarioId: sid, title: '新场景' });
    expect(r.ok).toBe(true);
    const stage = events.find((e) => e.type === 'stage') as { diff?: string };
    expect(stage.diff).toContain('title: 旧场景 → 新场景');
  }, 30_000);

  it('delete:拒绝保留/确认删除', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildScenariosTools(ctx)[0]!;
    const rid = await makeRequirement(seed.projectId);
    await tool.execute({ action: 'create', requirementId: rid, title: '待删场景' });
    const sid = (await pool.query(`SELECT id FROM scenarios WHERE title='待删场景'`)).rows[0]!.id as string;

    const rejected = tool.execute({ action: 'delete', scenarioId: sid });
    const cid = await untilConfirm(events);
    resolveConfirmation(cid, false);
    expect(await rejected).toMatchObject({ ok: false, error: '用户取消了该操作' });
    expect((await pool.query(`SELECT id FROM scenarios WHERE id=$1`, [sid])).rowCount).toBe(1);

    events.length = 0;
    const approved = tool.execute({ action: 'delete', scenarioId: sid });
    resolveConfirmation(await untilConfirm(events), true);
    expect(await approved).toMatchObject({ ok: true });
    expect((await pool.query(`SELECT id FROM scenarios WHERE id=$1`, [sid])).rowCount).toBe(0);
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/space-tools-scenarios.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/pi/space/tools/scenarios.ts`**

```ts
/** manage_scenarios:场景列表/创建/改名删述/删除。场景从属需求(requirementId 必填,归属经需求解析)。 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/scenarios.service.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';
import { requestConfirmation } from '../confirm.js';

const Actions = z.object({
  action: z.enum(['list', 'create', 'update', 'delete']),
  scenarioId: z.string().uuid().optional(),
  requirementId: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
});

export function buildScenariosTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_scenarios',
      description:
        '场景管理(场景从属需求,用例可绑定场景)。action=list(项目内场景全集,含 requirementId)| create(requirementId+title 必填;requirementId 取自上下文摘要)| update(scenarioId + title/description)| delete(scenarioId,需用户确认)。',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('create'), Type.Literal('update'), Type.Literal('delete')]),
        scenarioId: Type.Optional(Type.String()),
        requirementId: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      promptGuidelines: [
        '创建场景前先 list 确认是否已存在同名场景;requirementId 必须来自上下文摘要或 list 结果,禁止臆造。',
        'delete 会向用户发确认卡;被拒或超时视为放弃,不要重试。',
      ],
      execute: async (input) => {
        let v: z.infer<typeof Actions>;
        try {
          v = Actions.parse(input);
        } catch (e) {
          if (e instanceof z.ZodError) {
            return { ok: false, error: `参数不合法:${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
          }
          throw e;
        }
        try {
          switch (v.action) {
            case 'list': {
              const rows = await svc.listScenariosByProject(ctx.projectId);
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
            case 'create': {
              if (!v.requirementId || !v.title) return { ok: false, error: 'create 需要 requirementId 与 title' };
              const pid = await svc.requirementProjectId(v.requirementId);
              if (pid !== ctx.projectId) return { ok: false, error: '需求不存在或不属于当前项目' };
              const sc = await svc.createScenario(v.requirementId, { title: v.title, description: v.description });
              emitStage(ctx, { kind: 'scenario', id: sc.id, action: 'create' });
              return { ok: true, data: `已创建场景「${sc.title}」(${sc.id})` };
            }
            case 'update': {
              if (!v.scenarioId) return { ok: false, error: 'update 需要 scenarioId' };
              const pid = await svc.scenarioProjectId(v.scenarioId);
              if (pid !== ctx.projectId) return { ok: false, error: '场景不存在或不属于当前项目' };
              const patch: { title?: string; description?: string | null } = {};
              if (v.title !== undefined) patch.title = v.title;
              if (v.description !== undefined) patch.description = v.description;
              if (Object.keys(patch).length === 0) return { ok: false, error: 'update 未提供任何要修改的字段(title/description)' };
              const before = await svc.getScenario(v.scenarioId);
              const after = await svc.updateScenario(v.scenarioId, patch);
              emitStage(ctx, { kind: 'scenario', id: v.scenarioId, action: 'update', diff: diffText(before ?? {}, after) });
              return { ok: true, data: `已更新场景「${after.title}」` };
            }
            case 'delete': {
              if (!v.scenarioId) return { ok: false, error: 'delete 需要 scenarioId' };
              const sc = await svc.getScenario(v.scenarioId);
              const pid = sc ? await svc.scenarioProjectId(sc.id) : null;
              if (!sc || pid !== ctx.projectId) return { ok: false, error: '场景不存在或不属于当前项目' };
              const approved = await requestConfirmation(
                { threadId: ctx.threadId, toolName: 'manage_scenarios', action: 'delete', summary: `删除场景「${sc.title}」(关联用例将解绑)`, risk: 'delete' },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.deleteScenario(v.scenarioId);
              emitStage(ctx, { kind: 'scenario', id: v.scenarioId, action: 'delete' });
              return { ok: true, data: `已删除场景「${sc.title}」` };
            }
          }
        } catch (e) {
          if (e instanceof HttpError) return { ok: false, error: e.message };
          return { ok: false, error: `操作失败:${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  ];
}
```

- [ ] **Step 4: 装配(`tools/index.ts`)**

```ts
import { buildScenariosTools } from './scenarios.js';
// buildSpaceTools 中追加:
  tools.push(...buildScenariosTools(ctx));
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/space-tools-scenarios.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pi/space/tools/scenarios.ts apps/api/src/pi/space/tools/index.ts apps/api/test/space-tools-scenarios.test.ts
git commit -m "feat(api): manage_scenarios 空间工具"
```

---

### Task 8: manage_environments 工具

**Files:**
- Create: `apps/api/src/pi/space/tools/environments.ts`
- Modify: `apps/api/src/pi/space/tools/index.ts`(装配)
- Test: `apps/api/test/space-tools-environments.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/test/space-tools-environments.test.ts`(标准容器骨架 + makeCtx/untilConfirm 同 Task 6 + 以下):

```ts
import { buildEnvironmentsTools } from '../src/pi/space/tools/environments.js';
import { resolveConfirmation } from '../src/pi/space/confirm.js';

describe('manage_environments 工具', () => {
  it('upsert 新建环境+db 对象(拒绝明文密码);set_secret 确认后密文落库,任何出口无明文', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildEnvironmentsTools(ctx)[0]!;

    const rejectedPayload = await tool.execute({
      action: 'upsert', name: '生产',
      objects: [{ objectType: 'db', payload: { host: 'h', dbName: 'd', user: 'u', password: 'SUPER-SECRET' } }],
    });
    expect(rejectedPayload).toMatchObject({ ok: false });
    expect((rejectedPayload as { error: string }).error).toContain('set_secret');
    expect(JSON.stringify(events)).not.toContain('SUPER-SECRET');

    const created = await tool.execute({
      action: 'upsert', name: '生产', baseUrl: 'https://prod.example.com',
      objects: [{ objectType: 'db', payload: { host: 'h', dbName: 'd', user: 'u' }, isDefault: true }],
    });
    expect(created.ok).toBe(true);
    expect((created as { data: string }).data).not.toContain('SUPER-SECRET');
    const envId = (await pool.query(`SELECT id FROM test_environments WHERE name='生产'`)).rows[0]!.id as string;
    const objId = (await pool.query(`SELECT id FROM environment_objects WHERE environment_id=$1`, [envId])).rows[0]!.id as string;

    events.length = 0;
    const secret = tool.execute({ action: 'set_secret', environmentId: envId, objectType: 'db', value: 'SUPER-SECRET' });
    const cid = await untilConfirm(events);
    const req = events.find((e) => e.type === 'confirm_request') as Record<string, unknown>;
    expect(String(req.summary)).not.toContain('SUPER-SECRET'); // summary 不回显明文
    expect(String(req.risk)).toBe('secret');
    resolveConfirmation(cid, true);
    expect(await secret).toMatchObject({ ok: true, data: '凭据已加密保存' });

    const raw = (await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [objId])).rows[0]!.payload as { secret: { c: string; i: string; t: string } };
    expect(raw.secret.c).toBeTruthy();
    expect(JSON.stringify(raw)).not.toContain('SUPER-SECRET');
    expect(JSON.stringify(events)).not.toContain('SUPER-SECRET');

    const list = await tool.execute({ action: 'list' });
    expect((list as { data: string }).data).toContain('••••••••');
    expect((list as { data: string }).data).toContain('https://prod.example.com');
  }, 30_000);

  it('set_secret 被拒 → payload 无 secret;对象不存在 → 提示先 upsert', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildEnvironmentsTools(ctx)[0]!;
    await tool.execute({ action: 'upsert', name: '灰度' });
    const envId = (await pool.query(`SELECT id FROM test_environments WHERE name='灰度'`)).rows[0]!.id as string;

    const missing = await tool.execute({ action: 'set_secret', environmentId: envId, objectType: 'db', value: 'x' });
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { error: string }).error).toContain('先');

    events.length = 0;
    const pending = tool.execute({ action: 'set_secret', environmentId: envId, objectType: 'syslog', label: '默认', value: 'k' });
    // syslog 对象不存在 → 不进确认,直接报错
    await pending;
    expect(events.find((e) => e.type === 'confirm_request')).toBeUndefined();

    await tool.execute({ action: 'upsert', environmentId: envId, objects: [{ objectType: 'syslog', payload: { host: 's', filePath: '/var/log/syslog', authType: 'password' } }] });
    events.length = 0;
    const p2 = tool.execute({ action: 'set_secret', environmentId: envId, objectType: 'syslog', value: 'SYS-KEY' });
    resolveConfirmation(await untilConfirm(events), false);
    expect(await p2).toMatchObject({ ok: false, error: '用户取消了该操作' });
    const raw = (await pool.query(
      `SELECT o.payload FROM environment_objects o JOIN test_environments e ON e.id=o.environment_id WHERE e.id=$1 AND o.object_type='syslog'`, [envId],
    )).rows[0]!.payload as { secret?: unknown };
    expect(raw.secret).toBeUndefined();
  }, 30_000);

  it('delete:summary 带引用计数;确认后环境删除且用例引用置空', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildEnvironmentsTools(ctx)[0]!;
    await tool.execute({ action: 'upsert', name: '要删的环境' });
    const envId = (await pool.query(`SELECT id FROM test_environments WHERE name='要删的环境'`)).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title, default_env_id) SELECT id,$1,'c',$2 FROM groups WHERE project_id=$3 LIMIT 1`,
      [seed.versionId, envId, seed.projectId],
    );

    events.length = 0;
    const pending = tool.execute({ action: 'delete', environmentId: envId });
    const cid = await untilConfirm(events);
    const req = events.find((e) => e.type === 'confirm_request') as { summary: string };
    expect(req.summary).toContain('要删的环境');
    expect(req.summary).toContain('1 个用例');
    resolveConfirmation(cid, true);
    expect(await pending).toMatchObject({ ok: true });
    expect((await pool.query(`SELECT id FROM test_environments WHERE id=$1`, [envId])).rowCount).toBe(0);
    expect((await pool.query(`SELECT default_env_id FROM test_cases WHERE title='c'`)).rows[0]!.default_env_id).toBeNull();
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/space-tools-environments.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/pi/space/tools/environments.ts`**

```ts
/**
 * manage_environments:环境列表/详情/upsert(含对象,但拒绝明文凭据)/set_secret(阻塞确认)/删除(阻塞确认)。
 * 明文凭据只能走 set_secret:summary 不回显值;工具返回与 stage 事件均只有掩码。
 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/environments.service.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import { resolveEnvironmentProjectId } from '../../../services/projectAccess.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { requestConfirmation } from '../confirm.js';

const Actions = z.object({
  action: z.enum(['list', 'get', 'upsert', 'set_secret', 'delete']),
  environmentId: z.string().uuid().optional(),
  name: z.string().min(1).max(120).optional(),
  baseUrl: z.string().max(2000).nullable().optional(),
  isDefault: z.boolean().optional(),
  objects: z.array(z.object({
    objectType: z.enum(['db', 'syslog']),
    label: z.string().max(120).optional(),
    payload: z.record(z.unknown()),
    isDefault: z.boolean().optional(),
  })).max(10).optional(),
  objectType: z.enum(['db', 'syslog']).optional(), // set_secret 用
  label: z.string().max(120).optional(), // set_secret 用(缺省「默认」)
  value: z.string().min(1).max(8000).optional(), // set_secret 明文(仅进加密,不进任何输出)
});

export function buildEnvironmentsTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_environments',
      description:
        '测试环境管理。action=list(项目环境全集,对象凭据已掩码)| get(environmentId)| upsert(新建或更新环境与对象字段:environmentId 缺省=新建需 name;objects 按 objectType+label 合并;payload 禁带 password/privateKey)| set_secret(environmentId+objectType+value,需用户确认,值不回显)| delete(environmentId,需用户确认)。',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('get'), Type.Literal('upsert'), Type.Literal('set_secret'), Type.Literal('delete')]),
        environmentId: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        baseUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        isDefault: Type.Optional(Type.Boolean()),
        objects: Type.Optional(Type.Array(Type.Object({
          objectType: Type.Union([Type.Literal('db'), Type.Literal('syslog')]),
          label: Type.Optional(Type.String()),
          payload: Type.Record(Type.String(), Type.Unknown()),
          isDefault: Type.Optional(Type.Boolean()),
        }), { maxItems: 10 })),
        objectType: Type.Optional(Type.Union([Type.Literal('db'), Type.Literal('syslog')])),
        label: Type.Optional(Type.String()),
        value: Type.Optional(Type.String()),
      }),
      promptGuidelines: [
        'db 对象 payload 常用字段:host/port/dbName/user(authType 缺省按密码认证);syslog 对象:host/sshPort/user/filePath/authType("key"|"password")。',
        '凭据(password/privateKey)严禁放进 upsert 的 payload:先 upsert 其它字段,再单独调 set_secret(会请用户确认)。',
        'set_secret 的 value 是明文凭据,只会被加密保存,不会出现在任何输出里;用户拒绝即放弃。',
      ],
      execute: async (input) => {
        let v: z.infer<typeof Actions>;
        try {
          v = Actions.parse(input);
        } catch (e) {
          if (e instanceof z.ZodError) {
            return { ok: false, error: `参数不合法:${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
          }
          throw e;
        }
        try {
          switch (v.action) {
            case 'list': {
              return { ok: true, data: JSON.stringify(await svc.listEnvironments(ctx.projectId), null, 2) };
            }
            case 'get': {
              if (!v.environmentId) return { ok: false, error: 'get 需要 environmentId' };
              const pid = await resolveEnvironmentProjectId(v.environmentId);
              if (pid !== ctx.projectId) return { ok: false, error: '环境不存在或不属于当前项目' };
              const detail = await svc.getEnvironment(v.environmentId);
              if (!detail) return { ok: false, error: '环境不存在或不属于当前项目' };
              return { ok: true, data: JSON.stringify(detail, null, 2) };
            }
            case 'upsert': {
              for (const o of v.objects ?? []) {
                if ('password' in o.payload || 'privateKey' in o.payload) {
                  return { ok: false, error: 'upsert 的 payload 不接受明文 password/privateKey:请先 upsert 对象的其它字段,再单独调 action=set_secret 设置凭据' };
                }
              }
              let envId: string;
              if (v.environmentId) {
                const pid = await resolveEnvironmentProjectId(v.environmentId);
                if (pid !== ctx.projectId) return { ok: false, error: '环境不存在或不属于当前项目' };
                const patch: { name?: string; baseUrl?: string | null; isDefault?: boolean } = {};
                if (v.name !== undefined) patch.name = v.name;
                if (v.baseUrl !== undefined) patch.baseUrl = v.baseUrl;
                if (v.isDefault !== undefined) patch.isDefault = v.isDefault;
                if (Object.keys(patch).length > 0) await svc.updateEnvironment(v.environmentId, patch);
                envId = v.environmentId;
              } else {
                if (!v.name) return { ok: false, error: 'upsert 新建环境需要 name' };
                envId = (await svc.createEnvironment(ctx.projectId, { name: v.name, baseUrl: v.baseUrl ?? null })).id;
              }
              for (const o of v.objects ?? []) await svc.upsertEnvironmentObject(envId, o);
              emitStage(ctx, { kind: 'environment', id: envId, action: 'upsert' });
              return { ok: true, data: JSON.stringify(await svc.getEnvironment(envId), null, 2) };
            }
            case 'set_secret': {
              if (!v.environmentId || !v.objectType || !v.value) return { ok: false, error: 'set_secret 需要 environmentId、objectType 与 value' };
              const pid = await resolveEnvironmentProjectId(v.environmentId);
              if (pid !== ctx.projectId) return { ok: false, error: '环境不存在或不属于当前项目' };
              const env = await svc.getEnvironment(v.environmentId);
              const obj = await svc.findEnvironmentObject(v.environmentId, v.objectType, v.label);
              if (!obj) return { ok: false, error: `该环境还没有 ${v.objectType} 对象「${v.label ?? '默认'}」:先用 upsert 创建后再设置凭据` };
              const approved = await requestConfirmation(
                {
                  threadId: ctx.threadId, toolName: 'manage_environments', action: 'set_secret',
                  summary: `设置环境「${env?.name ?? v.environmentId}」的 ${v.objectType} 对象「${obj.label}」访问凭据(值不回显)`,
                  risk: 'secret',
                },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.setEnvironmentObjectSecret(obj.id, v.value);
              emitStage(ctx, { kind: 'environment', id: v.environmentId, action: 'set_secret' });
              return { ok: true, data: '凭据已加密保存' };
            }
            case 'delete': {
              if (!v.environmentId) return { ok: false, error: 'delete 需要 environmentId' };
              const pid = await resolveEnvironmentProjectId(v.environmentId);
              if (pid !== ctx.projectId) return { ok: false, error: '环境不存在或不属于当前项目' };
              const env = await svc.getEnvironment(v.environmentId);
              const usage = await svc.environmentUsage(v.environmentId);
              const usageText = usage.caseCount + usage.planCount > 0
                ? `(将使 ${usage.caseCount} 个用例与 ${usage.planCount} 个计划的引用置空)`
                : '(无引用)';
              const approved = await requestConfirmation(
                {
                  threadId: ctx.threadId, toolName: 'manage_environments', action: 'delete',
                  summary: `删除环境「${env?.name ?? v.environmentId}」${usageText}`,
                  risk: 'delete',
                },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.deleteEnvironment(v.environmentId);
              emitStage(ctx, { kind: 'environment', id: v.environmentId, action: 'delete' });
              return { ok: true, data: `已删除环境「${env?.name ?? v.environmentId}」` };
            }
          }
        } catch (e) {
          if (e instanceof HttpError) return { ok: false, error: e.message };
          return { ok: false, error: `操作失败:${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  ];
}
```

- [ ] **Step 4: 装配(`tools/index.ts`)**

```ts
import { buildEnvironmentsTools } from './environments.js';
// buildSpaceTools 中追加:
  tools.push(...buildEnvironmentsTools(ctx));
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/space-tools-environments.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pi/space/tools/environments.ts apps/api/src/pi/space/tools/index.ts apps/api/test/space-tools-environments.test.ts
git commit -m "feat(api): manage_environments 空间工具(凭据仅经阻塞确认加密落库)"
```

---

### Task 9: manage_plans 工具

**Files:**
- Create: `apps/api/src/pi/space/tools/plans.ts`
- Modify: `apps/api/src/pi/space/tools/index.ts`(装配)
- Test: `apps/api/test/space-tools-plans.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/test/space-tools-plans.test.ts`(标准容器骨架 + makeCtx 同 Task 6,无需 untilConfirm——本工具无阻塞确认 + 以下):

```ts
import { buildPlansTools } from '../src/pi/space/tools/plans.js';

async function makeCase(groupId: string, versionId: string, title: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1,$2,$3) RETURNING id`, [groupId, versionId, title],
  )).rows[0]!.id as string;
}

describe('manage_plans 工具', () => {
  it('create 可带 caseIds;stage(create) 广播;list 命中', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildPlansTools(ctx)[0]!;
    const c1 = await makeCase(seed.groupId, seed.versionId, 'c1');
    const c2 = await makeCase(seed.groupId, seed.versionId, 'c2');
    const r = await tool.execute({ action: 'create', name: '冒烟', caseIds: [c1, c2] });
    expect(r.ok).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'stage', kind: 'plan', action: 'create' }));
    const detail = JSON.parse((await tool.execute({ action: 'get', planId: (r as { data: string }).data.match(/\(([-0-9a-f]{36})\)/) }) as never as { data: string }) ?? '') as unknown;
    // ↑ 上一行不可靠,直接查库断言:
    const planId = (await pool.query(`SELECT id FROM execution_plans WHERE name='冒烟'`)).rows[0]!.id as string;
    const got = await tool.execute({ action: 'get', planId });
    const parsed = JSON.parse((got as { data: string }).data) as { cases: Array<{ order: number; title: string }> };
    expect(parsed.cases.map((c) => c.order)).toEqual([1, 2]);
    const list = JSON.parse(((await tool.execute({ action: 'list' })) as { data: string }).data) as Array<{ name: string; caseCount: number }>;
    expect(list.find((p) => p.name === '冒烟')!.caseCount).toBe(2);
  }, 30_000);

  it('add_cases 跨项目 → 失败文案含归属;remove_cases 后重排且 stage 带 diff;update 带 diff', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildPlansTools(ctx)[0]!;
    const c1 = await makeCase(seed.groupId, seed.versionId, 'c1');
    const c2 = await makeCase(seed.groupId, seed.versionId, 'c2');
    const foreign = await makeCase(other.groupId, other.versionId, '外来的');
    await tool.execute({ action: 'create', name: '全量', caseIds: [c1, c2] });
    const planId = (await pool.query(`SELECT id FROM execution_plans WHERE name='全量'`)).rows[0]!.id as string;

    const cross = await tool.execute({ action: 'add_cases', planId, caseIds: [foreign] });
    expect(cross).toMatchObject({ ok: false });
    expect((cross as { error: string }).error).toContain('belong to the plan project');

    events.length = 0;
    const rm = await tool.execute({ action: 'remove_cases', planId, caseIds: [c1] });
    expect(rm.ok).toBe(true);
    const stage = events.find((e) => e.type === 'stage') as { action: string; diff?: string };
    expect(stage.action).toBe('remove_cases');
    expect(stage.diff).toContain('cases: -1');
    const detail = JSON.parse(((await tool.execute({ action: 'get', planId })) as { data: string }).data) as { cases: Array<{ order: number; title: string }> };
    expect(detail.cases.map((c) => c.order)).toEqual([1]); // c2 重排

    events.length = 0;
    await tool.execute({ action: 'update', planId, name: '全量2', strategy: 'fail_fast' });
    const stage2 = events.find((e) => e.type === 'stage') as { diff?: string };
    expect(stage2.diff).toContain('name: 全量 → 全量2');
    expect(stage2.diff).toContain('strategy: run_all → fail_fast');
  }, 30_000);

  it('create 缺 name → 参数错误;跨项目 planId 被拒', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = buildPlansTools(ctx)[0]!;
    const noName = await tool.execute({ action: 'create' });
    expect(noName).toMatchObject({ ok: false });
    const otherPlan = await (await import('../src/services/plans.service.js')).createPlan(other.projectId, { name: '别人的', versionId: other.versionId });
    const cross = await tool.execute({ action: 'get', planId: otherPlan.id });
    expect(cross).toMatchObject({ ok: false });
  }, 30_000);
});
```

实现注意:测试第 1 个用例中那行 `JSON.parse(...match(...))` 是无效断言,实现时**删除该行**,保留其后「直接查库断言」的写法(此测试代码块以最终实际可跑为准;上面已标注)。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/space-tools-plans.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/pi/space/tools/plans.ts`**

```ts
/** manage_plans:计划列表/详情/创建/更新/加用例/移用例。无阻塞确认(改组合是可逆更新),变更走 stage 事件。 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/plans.service.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';

const Actions = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'add_cases', 'remove_cases']),
  planId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  environmentId: z.string().uuid().nullable().optional(),
  strategy: z.enum(['run_all', 'fail_fast']).optional(),
  caseIds: z.array(z.string().uuid()).max(200).optional(),
});

export function buildPlansTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_plans',
      description:
        '执行计划管理。action=list(本版本计划,含 caseCount)| get(planId,含有序用例)| create(name 必填,可带 environmentId/strategy/caseIds)| update(planId + name/environmentId/strategy)| add_cases(planId+caseIds,追加到队尾,重复跳过)| remove_cases(planId+caseIds,余量重排)。',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('get'), Type.Literal('create'), Type.Literal('update'), Type.Literal('add_cases'), Type.Literal('remove_cases')]),
        planId: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        environmentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        strategy: Type.Optional(Type.Union([Type.Literal('run_all'), Type.Literal('fail_fast')])),
        caseIds: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
      }),
      promptGuidelines: [
        'caseIds 必须来自 manage_cases 的 search/get 结果,禁止臆造;加入计划的用例必须属于当前项目。',
        '本工具不会执行计划,只做配置;需要执行时告知用户去执行页操作。',
      ],
      execute: async (input) => {
        let v: z.infer<typeof Actions>;
        try {
          v = Actions.parse(input);
        } catch (e) {
          if (e instanceof z.ZodError) {
            return { ok: false, error: `参数不合法:${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
          }
          throw e;
        }
        try {
          switch (v.action) {
            case 'list': {
              return { ok: true, data: JSON.stringify(await svc.listPlansByVersion(ctx.versionId), null, 2) };
            }
            case 'get': {
              if (!v.planId) return { ok: false, error: 'get 需要 planId' };
              const pid = await svc.planProjectId(v.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              const detail = await svc.getPlanDetail(v.planId);
              if (!detail) return { ok: false, error: '计划不存在或不属于当前项目' };
              return { ok: true, data: JSON.stringify(detail, null, 2) };
            }
            case 'create': {
              if (!v.name) return { ok: false, error: 'create 需要 name' };
              const plan = await svc.createPlan(ctx.projectId, {
                name: v.name,
                versionId: ctx.versionId,
                environmentId: v.environmentId ?? undefined,
                strategy: v.strategy,
              });
              if (v.caseIds?.length) await svc.replacePlanCases(plan.id, v.caseIds);
              emitStage(ctx, { kind: 'plan', id: plan.id, action: 'create' });
              return { ok: true, data: `已创建计划「${plan.name}」(${plan.id})${v.caseIds?.length ? `,含 ${v.caseIds.length} 个用例` : ''}` };
            }
            case 'update': {
              if (!v.planId) return { ok: false, error: 'update 需要 planId' };
              const pid = await svc.planProjectId(v.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              const before = await svc.getPlanDetail(v.planId);
              const patch: { name?: string; environmentId?: string | null; strategy?: string } = {};
              if (v.name !== undefined) patch.name = v.name;
              if (v.environmentId !== undefined) patch.environmentId = v.environmentId;
              if (v.strategy !== undefined) patch.strategy = v.strategy;
              if (Object.keys(patch).length === 0) return { ok: false, error: 'update 未提供任何要修改的字段(name/environmentId/strategy)' };
              await svc.updatePlan(v.planId, patch);
              const after = await svc.getPlanDetail(v.planId);
              emitStage(ctx, { kind: 'plan', id: v.planId, action: 'update', diff: diffText(before ?? {}, after ?? {}) });
              return { ok: true, data: `已更新计划「${after?.name ?? v.planId}」` };
            }
            case 'add_cases': {
              if (!v.planId || !v.caseIds?.length) return { ok: false, error: 'add_cases 需要 planId 与 caseIds' };
              const pid = await svc.planProjectId(v.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              const added = await svc.addPlanCases(v.planId, v.caseIds);
              emitStage(ctx, { kind: 'plan', id: v.planId, action: 'add_cases', diff: `cases: +${added}` });
              return { ok: true, data: `已向计划追加 ${added} 个用例` };
            }
            case 'remove_cases': {
              if (!v.planId || !v.caseIds?.length) return { ok: false, error: 'remove_cases 需要 planId 与 caseIds' };
              const pid = await svc.planProjectId(v.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              const removed = await svc.removePlanCases(v.planId, v.caseIds);
              emitStage(ctx, { kind: 'plan', id: v.planId, action: 'remove_cases', diff: `cases: -${removed}` });
              return { ok: true, data: `已从计划移除 ${removed} 个用例` };
            }
          }
        } catch (e) {
          if (e instanceof HttpError) return { ok: false, error: e.message };
          return { ok: false, error: `操作失败:${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  ];
}
```

- [ ] **Step 4: 修正测试第 1 用例(删除无效断言行)**

按「实现注意」删除 `const detail = JSON.parse(...)` 那一行及其注释,只保留查库断言路径。

- [ ] **Step 5: 装配(`tools/index.ts`)**

```ts
import { buildPlansTools } from './plans.js';
// buildSpaceTools 中追加:
  tools.push(...buildPlansTools(ctx));
```

- [ ] **Step 6: 跑测试确认通过 + typecheck**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/space-tools-plans.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/pi/space/tools/plans.ts apps/api/src/pi/space/tools/index.ts apps/api/test/space-tools-plans.test.ts
git commit -m "feat(api): manage_plans 空间工具(cases 编排走 stage 非阻塞)"
```

---

### Task 10: 装配完整性断言 + 全量回归

**Files:**
- Modify: `apps/api/test/space-tools-basic.test.ts`

- [ ] **Step 1: 补全装配断言(先跑确认通过——本步是收尾断言,不需要新实现)**

`test/space-tools-basic.test.ts` 追加用例:

```ts
it('装配完整:四个领域工具全部注入', () => {
  const { ctx } = makeCtx();
  const names = buildSpaceTools(ctx).map((t) => t.name);
  for (const n of ['announce_plan', 'inspect_page', 'manage_cases', 'manage_scenarios', 'manage_environments', 'manage_plans']) {
    expect(names).toContain(n);
  }
  // 顺序约定:repo_*(若有)在最前,领域工具其后(与 session.ts 注入顺序一致)
  expect(names.indexOf('manage_cases')).toBeLessThan(names.indexOf('manage_plans'));
});
```

- [ ] **Step 2: 全量回归**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true pnpm test`
Expected: 全 PASS(个别文件 testcontainers "Hook timed out" → 隔离重跑该文件)

- [ ] **Step 3: 类型检查**

Run: `cd apps/api && pnpm typecheck`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/space-tools-basic.test.ts
git commit -m "test(api): 空间工具装配完整性断言收尾"
```

---

## 完成标准(DoD)

- [ ] 既有路由套件零回归(cases/projects/scenarios/environments/plans 相关测试全绿,响应形状兼容)
- [ ] `buildSpaceTools` 注入:repo 可用 → repo_* + 六工具;不可用 → 六工具(manage_cases/scenarios/environments/plans + announce_plan + inspect_page)
- [ ] delete 类(manage_cases / manage_scenarios / manage_environments)与 set_secret 走阻塞确认;拒绝/超时 → `{ ok:false, error:'用户取消了该操作' }`
- [ ] 明文凭据只经 set_secret 加密落库;工具返回、stage/announce 事件、confirm summary 中断言无明文(环境工具测试以 SUPER-SECRET 负向断言)
- [ ] 所有写操作广播 stage 事件;announce_plan 广播 announce 事件(工具测试经 ctx.emit 捕获断言)
- [ ] `pnpm test` 全量 + `pnpm typecheck` 通过
- [ ] Plan 3 接缝就绪:SSE 事件形状(stage/announce/confirm_request)与本文「SSE 自定义事件」一节一致

## 给执行者的备注

- `HttpError.message` 为英文(与既有 HTTP 契约一致,如 `all cases must belong to the plan project`);工具层的归属类拒绝由工具自己给中文文案,服务层 HttpError 原样透出,不强行翻译。
- 工具测试直接调 `executor.execute(...)`,不经 defineTool 适配;confirm 流程经 `resolveConfirmation(confirmId, true/false)` 驱动(confirm_request 事件同步 emit,轮询只为等前面的 DB 查询完成)。
- 服务内「归属重复校验」(路由已查一次、service 再查一次)是有意冗余:工具侧没有路由那次校验,service 必须自洽;代价是每请求多几条主键查询,可接受。
- `searchCasesInVersion` 的上限 50 条对 LLM 输出足够;版本内用例更多时靠 keyword 收敛——这是有意设计,不做分页。

## Self-Review 记录(成文时已检查)

1. **Spec 覆盖**:设计 §4 工具表 → Task 6-9(四 manage_*)+ Task 5(announce/inspect);§7 announce → Task 5;§8 错误 → 各工具 catch + 「错误约定」;§9 测试策略 → 每任务 TDD + DoD;§11 service 抽取 → Task 1-4;非目标(执行触发/query_stats/步骤修改)未引入。Plan 1 评审遗留(checkout 失败静默、SSE 早订阅丢事件)属 Plan 3 前端/重连范畴,不在本计划。
2. **占位符扫描**:无 TBD/TODO;所有代码步骤给出完整代码;两处「二选一」(environments PATCH/DELETE object handler 实现)已给出推荐选项与判据。
3. **类型一致性**:`SpaceToolsContext` 字段(context.ts)与 Plan 1 session.ts 构造点一致;service 导出名与工具 import 一致(cases: createCaseWithSteps/searchCasesInVersion/getCaseDetail/updateCase/deleteCase/groupProjectId/createGroup/tagsForCases/assertTagsBelongToOrg;scenarios: + getScenario;environments: 全套;plans: 全套);`requestConfirmation(req, emit)` / `resolveConfirmation(id, bool)` 与 Plan 1 confirm.ts 签名一致;migrateAssertion/normalizeCompiledStep/expandCompiledAiStepsInPlace 导入路径已核实存在。

