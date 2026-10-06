# 用例回放测试数据集 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目级测试数据集（表格编辑、敏感列加密）+ 用例绑定后回放自动逐行迭代（N 行 = N 条 report），计划执行与报告展示全链路支持。

**Architecture:** 迭代在 `runCase.ts` 层完成（拆出 `runCaseOnce`），执行器 `cdp.ts` 只新增 `initialVars`/`sensitiveVarKeys` 两个 ExecContext 字段与错误信息打码；数据集 CRUD 走独立 service+route（镜像 environments 模式），敏感格 AES-256-GCM `{c,i,t}` 加密存 rows jsonb，出参 `{__masked:true}` 占位。

**Tech Stack:** Express 5 + drizzle-orm + zod（api）、React + react-query（web）、vitest + supertest + @testcontainers/postgresql（测试）。

**规格文档:** `docs/superpowers/specs/2026-10-06-replay-dataset-design.md`（已评审通过）

**关键事实（实现前必读）:**
- 测试容器模式：每文件起 `PostgreSqlContainer('postgres:16-alpine')` → `process.env.DATABASE_URL` → `pool.query(SCHEMA_SQL)` → 动态 import 路由 → `managerUserOf` 注入身份（见 `apps/api/test/reports.test.ts`）。
- `ENCRYPTION_KEY` 必须在动态 import service 前设进 `process.env`（dev 值：`nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=`）。
- 迁移手动：新文件放 `apps/api/drizzle/`；dev 库用 drizzle-kit push，正式库 `pnpm db:migrate`。
- 所有命令在仓库根执行：`pnpm -C apps/api exec vitest run test/<file>` 跑单测，`pnpm -C apps/api exec tsc --noEmit` 类型检查。
- 提交信息风格参照 git log：`feat(api): …` / `feat(web): …` 中文描述。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/api/src/db/schema.ts` | 修改 | datasets 表 + testCases.datasetId + reports 两列 + planRunCases.reportIds |
| `apps/api/drizzle/0031_replay_datasets.sql` | 新建 | 迁移 SQL |
| `apps/api/test/helpers/db.ts` | 修改 | SCHEMA_SQL 追加 datasets DDL |
| `apps/api/src/services/datasets.service.ts` | 新建 | CRUD + 加密归一 + loadDatasetForRun |
| `apps/api/src/routes/datasets.ts` | 新建 | HTTP 边界（可见性/确认删除） |
| `apps/api/src/services/projectAccess.ts` | 修改 | resolveDatasetProjectId / assertDatasetVisible |
| `apps/api/src/index.ts` | 修改 | 注册 datasetsRoute |
| `apps/api/src/routes/cases.ts` | 修改 | PatchBody + PATCH 校验 datasetId |
| `apps/api/src/services/cases.service.ts` | 修改 | UpdateCasePatch + 项目归属校验 |
| `apps/api/src/execute/cdp.ts` | 修改 | initialVars / sensitiveVarKeys / maskSensitiveValues |
| `apps/api/src/execute/runCase.ts` | 修改 | 拆 runCaseOnce + 行迭代 |
| `apps/api/src/routes/execute.ts` | 修改 | 响应带 reportIds + DatasetConfigError→400 |
| `apps/api/src/routes/reports.ts` | 修改 | 3 处 select 补两列 |
| `apps/api/src/execute/runPlan.ts` | 修改 | planRunCases.reportIds |
| `apps/api/src/routes/planRuns.ts` | 修改 | GET /:id 附 rowStatuses |
| `apps/api/test/datasets.test.ts` | 新建 | CRUD/加密往返/绑定测试 |
| `apps/api/test/mask-sensitive-vars.test.ts` | 新建 | 打码纯函数测试 |
| `apps/api/test/runCase-dataset.test.ts` | 新建 | 迭代执行测试（mock 执行器） |
| `apps/api/test/plan-run-datasets.test.ts` | 新建 | 计划迭代聚合测试 |
| `apps/web/src/api/client.ts` | 修改 | api.datasets + 类型扩展 |
| `apps/web/src/components/Icon.tsx` | 修改 | table 图标 |
| `apps/web/src/App.tsx` | 修改 | /p/:projectId/datasets 路由 |
| `apps/web/src/pages/ProjectsHome.tsx` | 修改 | 项目行「数据集」入口 |
| `apps/web/src/pages/DatasetsPage.tsx` | 新建 | 列表 + 表格编辑器 + TSV 粘贴 |
| `apps/web/src/pages/CaseDetail.tsx` | 修改 | 绑定下拉 + vars 合并 + 执行跳转 |
| `apps/web/src/components/step-form/FillValueEditor.tsx` | 修改 | 变量来源标注 |
| `apps/web/src/pages/ReportDetail.tsx` | 修改 | 数据行 i/N + 快照展示 |
| `apps/web/src/pages/PlanRunDetail.tsx` | 修改 | 行通过率 + 每行报告按钮 |

---

### Task 1: DB schema + 迁移 + 测试 SCHEMA_SQL

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0031_replay_datasets.sql`
- Modify: `apps/api/test/helpers/db.ts`

- [ ] **Step 1: schema.ts — 新增 datasets 表类型与表定义**

在 `apps/api/src/db/schema.ts` 中，`testEnvironments` 表定义之后（约 480 行处，找 `export const testEnvironments = pgTable(` 块结束的 `});` 后）插入：

```ts
/** 数据集列定义：name 即回放变量名（{{name}}），sensitive 标记整列加密。 */
export interface DatasetColumn {
  name: string;
  sensitive: boolean;
}
/** 敏感格密文：AES-256-GCM 三元组（与 environment_objects payload.secret 同构）。 */
export interface DatasetEncCell { c: string; i: string; t: string }
export interface DatasetRow {
  disabled: boolean;
  cells: Record<string, string | DatasetEncCell>;
}

export const datasets = pgTable('datasets', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  description: text('description'),
  columns: jsonb('columns').$type<DatasetColumn[]>().notNull().default([]),
  rows: jsonb('rows').$type<DatasetRow[]>().notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectNameUq: unique('datasets_project_name_uq').on(t.projectId, t.name),
}));
```

- [ ] **Step 2: schema.ts — testCases 加 datasetId**

在 `testCases` 表 `defaultEnvId` 行（schema.ts:49）之后插入一行：

```ts
  datasetId: uuid('dataset_id').references(() => datasets.id, { onDelete: 'set null' }),
```

（`references` 回调惰性求值，datasets 定义在文件后部不影响。）

- [ ] **Step 3: schema.ts — reports 加两列**

在 `reports` 表 `summary: text('summary'),`（schema.ts:258）之后插入：

```ts
  datasetRowIndex: integer('dataset_row_index'),
  datasetSnapshot: jsonb('dataset_snapshot'),
```

- [ ] **Step 4: schema.ts — planRunCases 加 reportIds**

在 `planRunCases` 表 `reportId: uuid('report_id')...`（schema.ts:427）之后插入：

```ts
  /** 数据集迭代：该用例全部数据行产生的 report id 列表（首元素与 reportId 一致，兼容旧读取）。 */
  reportIds: jsonb('report_ids').$type<string[]>(),
```

- [ ] **Step 5: 新建迁移文件 `apps/api/drizzle/0031_replay_datasets.sql`**

```sql
-- 0031: 用例回放测试数据集（spec: docs/superpowers/specs/2026-10-06-replay-dataset-design.md）
CREATE TABLE IF NOT EXISTS datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  description text,
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE datasets ADD CONSTRAINT datasets_project_name_uq UNIQUE(project_id, name);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$
  ALTER TABLE test_cases ADD COLUMN dataset_id uuid REFERENCES datasets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$
  ALTER TABLE reports ADD COLUMN dataset_row_index integer;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$
  ALTER TABLE reports ADD COLUMN dataset_snapshot jsonb;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$
  ALTER TABLE plan_run_cases ADD COLUMN report_ids jsonb;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
```

- [ ] **Step 6: 测试 SCHEMA_SQL 追加同样 DDL**

在 `apps/api/test/helpers/db.ts` 的 `SCHEMA_SQL` 模板字符串末尾（最后一个 `CREATE INDEX execution_plans_version_idx ...;` 之后、闭合反引号之前）追加：

```
CREATE TABLE datasets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL, name varchar(120) NOT NULL, description text, columns jsonb NOT NULL DEFAULT '[]'::jsonb, rows jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), CONSTRAINT datasets_project_name_uq UNIQUE(project_id, name));
DO $$
 ALTER TABLE test_cases ADD COLUMN dataset_id uuid REFERENCES datasets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$
 ALTER TABLE reports ADD COLUMN dataset_row_index integer;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$
 ALTER TABLE reports ADD COLUMN dataset_snapshot jsonb;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$
 ALTER TABLE plan_run_cases ADD COLUMN report_ids jsonb;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
```

- [ ] **Step 7: 类型检查 + 既有测试回归**

Run: `pnpm -C apps/api exec tsc --noEmit`
Expected: 无错误。

Run: `pnpm -C apps/api exec vitest run test/reports.test.ts`
Expected: PASS（SCHEMA_SQL 语法无误）。

- [ ] **Step 8: 应用到 dev 库（drizzle-kit push）**

Run: `pnpm -C apps/api exec drizzle-kit push`（若 package.json 有 db:push 脚本则用脚本）
Expected: 输出包含新增 datasets 表与 4 个列变更，无交互冲突。

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/0031_replay_datasets.sql apps/api/test/helpers/db.ts
git commit -m "feat(api): 数据集表结构与迁移（datasets + 用例/报告/计划运行列）"
```

---

### Task 2: datasets.service（CRUD + 加密 + loadDatasetForRun）

**Files:**
- Create: `apps/api/src/services/datasets.service.ts`
- Create: `apps/api/test/datasets.test.ts`

- [ ] **Step 1: 写失败测试 `apps/api/test/datasets.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
let groupId: string;
let versionId: string;
let userId: string;
let username: string;
let orgId: string;
let orgPath: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  userId = seed.userId;
  username = seed.username;
  orgId = seed.orgId;
  orgPath = seed.orgPath;
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

const body = {
  name: '登录账号',
  columns: [
    { name: 'username', sensitive: false },
    { name: 'password', sensitive: true },
  ],
  rows: [
    { disabled: false, cells: { username: 'alice', password: 'pw-1' } },
    { disabled: false, cells: { username: 'bob', password: 'pw-2' } },
  ],
};

describe('datasets.service', () => {
  it('createDataset 加密敏感列；getDataset 返回 __masked 占位', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, body);
    expect(created.id).toBeTruthy();
    // 落库形态：敏感格是密文三元组，不是明文
    const raw = await pool.query(`SELECT rows FROM datasets WHERE id = $1`, [created.id]);
    const cell = raw.rows[0].rows[0].cells.password;
    expect(typeof cell).toBe('object');
    expect(cell.c).toBeTruthy();
    expect(cell.c).not.toContain('pw-1');
    // 出参：敏感格占位、明文列原样
    const detail = await svc.getDataset(created.id);
    expect(detail!.rows[0].cells.username).toBe('alice');
    expect(detail!.rows[0].cells.password).toEqual({ __masked: true });
  });

  it('updateDataset：__masked 回传沿用旧密文（解密可还原），改字符串则重新加密', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '账号2' });
    // 行 0 密码不改（占位回传），行 1 改成新明文
    const detail = await svc.getDataset(created.id);
    const rows = detail!.rows.map((r, i) => ({
      disabled: false,
      cells: {
        username: `user-${i}`,
        password: i === 0 ? { __masked: true } : 'pw-new',
      },
    }));
    await svc.updateDataset(created.id, { name: '账号2', columns: body.columns, rows });
    const run = await svc.loadDatasetForRun(created.id);
    expect(run.rows).toHaveLength(2);
    expect(run.rows[0].vars.password).toBe('pw-1'); // 旧密文沿用 → 仍可解出原值
    expect(run.rows[1].vars.password).toBe('pw-new');
  });

  it('updateDataset：列从敏感切成非敏感时 __masked 解回明文', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '账号3' });
    await svc.updateDataset(created.id, {
      name: '账号3',
      columns: [
        { name: 'username', sensitive: false },
        { name: 'password', sensitive: false }, // 去敏
      ],
      rows: body.rows.map(() => ({ disabled: false, cells: { username: 'x', password: { __masked: true } } })),
    });
    const detail = await svc.getDataset(created.id);
    expect(detail!.rows[0].cells.password).toBe('pw-1');
  });

  it('校验：非法列名 / 重复列名 / 未知列 / 超上限 报 400', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const { HttpError } = await import('../src/middleware/errorHandler.js');
    const badNames = await svc.createDataset(projectId, {
      name: 'x1', columns: [{ name: '1bad', sensitive: false }],
      rows: [],
    }).catch((e: unknown) => e);
    expect(badNames).toBeInstanceOf(HttpError);
    expect((badNames as HttpError).status).toBe(400);

    const dup = await svc.createDataset(projectId, {
      name: 'x2', columns: [{ name: 'a', sensitive: false }, { name: 'a', sensitive: false }],
      rows: [],
    }).catch((e: unknown) => e);
    expect((dup as HttpError).status).toBe(400);

    const unknownCol = await svc.createDataset(projectId, {
      name: 'x3', columns: [{ name: 'a', sensitive: false }],
      rows: [{ disabled: false, cells: { b: 'x' } }],
    }).catch((e: unknown) => e);
    expect((unknownCol as HttpError).status).toBe(400);

    const tooMany = await svc.createDataset(projectId, {
      name: 'x4',
      columns: Array.from({ length: 31 }, (_, i) => ({ name: `c${i}`, sensitive: false })),
      rows: [],
    }).catch((e: unknown) => e);
    expect((tooMany as HttpError).status).toBe(400);
  });

  it('createDataset 重名报 409', async () => {
    const svc = await import('../src/services/datasets.service.js');
    await svc.createDataset(projectId, body);
    const conflict = await svc.createDataset(projectId, body).catch((e: unknown) => e);
    expect((conflict as { status?: number }).status).toBe(409);
  });

  it('loadDatasetForRun：过滤 disabled 行、rowIndex 从 0 编号、快照敏感值打码', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, {
      name: '账号4',
      columns: body.columns,
      rows: [
        { disabled: true, cells: { username: 'skip', password: 'pw-0' } },
        { disabled: false, cells: { username: 'alice', password: 'pw-1' } },
        { disabled: false, cells: { username: 'bob', password: 'pw-2' } },
      ],
    });
    const run = await svc.loadDatasetForRun(created.id);
    expect(run.rows).toHaveLength(2);
    expect(run.rows[0].rowIndex).toBe(0);
    expect(run.rows[0].totalRows).toBe(2);
    expect(run.rows[0].vars).toEqual({ username: 'alice', password: 'pw-1' });
    expect(run.rows[0].sensitiveVarKeys).toEqual(['password']);
    expect(run.rows[1].snapshot.values).toEqual({ username: 'bob', password: '******' });
  });

  it('loadDatasetForRun：0 启用行 / 数据集不存在 抛 DatasetConfigError', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const empty = await svc.createDataset(projectId, {
      name: '全禁用',
      columns: body.columns,
      rows: [{ disabled: true, cells: { username: 'a', password: 'b' } }],
    });
    await expect(svc.loadDatasetForRun(empty.id)).rejects.toThrow('没有启用行');
    await expect(svc.loadDatasetForRun('00000000-0000-0000-0000-000000000000')).rejects.toThrow('dataset not found');
  });

  it('datasetUsage / deleteDataset', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '待删' });
    await pool.query(`INSERT INTO test_cases(group_id, version_id, title, dataset_id) VALUES ($1, $2, '绑定用例', $3)`, [groupId, versionId, created.id]);
    expect((await svc.datasetUsage(created.id)).caseCount).toBe(1);
    await svc.deleteDataset(created.id);
    // FK SET NULL：用例自动解绑
    const c = await pool.query(`SELECT dataset_id FROM test_cases WHERE version_id = $1`, [versionId]);
    expect(c.rows[0].dataset_id).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/datasets.test.ts`
Expected: FAIL — `Cannot find module '../src/services/datasets.service.js'`。

- [ ] **Step 3: 实现 `apps/api/src/services/datasets.service.ts`**

```ts
/**
 * 数据集领域服务：项目级测试数据集 CRUD + 回放数据装载。
 * 敏感列单元格以 AES-256-GCM {c,i,t} 加密存 rows jsonb；出参一律 {__masked:true} 占位。
 * 列名即变量名（回放时注入 {{列名}}），须过 validateVariableName。
 */
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { datasets, testCases } from '../db/schema.js';
import type { DatasetColumn, DatasetRow, DatasetEncCell } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { encrypt, decrypt } from '../lib/secret-crypto.js';
import { validateVariableName } from '@itest/shared';

export const DATASET_MASKED_CELL = { __masked: true } as const;
export type DatasetMaskedCell = { __masked: true };
const MAX_COLUMNS = 30;
const MAX_ROWS = 500;

/** 回放数据集配置错误（无启用行/列名非法等）。执行入口映射 400；计划内映射该用例 failed。 */
export class DatasetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetConfigError';
  }
}

export interface DatasetSaveBody {
  name: string;
  description?: string | null;
  columns: Array<{ name: string; sensitive?: boolean }>;
  rows: Array<{ disabled?: boolean; cells: Record<string, unknown> }>;
}

function isEncCell(v: unknown): v is DatasetEncCell {
  return typeof v === 'object' && v !== null
    && typeof (v as DatasetEncCell).c === 'string'
    && typeof (v as DatasetEncCell).i === 'string'
    && typeof (v as DatasetEncCell).t === 'string';
}

function isMaskedCell(v: unknown): v is DatasetMaskedCell {
  return typeof v === 'object' && v !== null && (v as { __masked?: boolean }).__masked === true;
}

function encryptCell(plain: string): DatasetEncCell {
  const e = encrypt(plain);
  return { c: e.ciphertext.toString('base64'), i: e.iv.toString('base64'), t: e.tag.toString('base64') };
}

function decryptCell(cell: DatasetEncCell): string {
  return decrypt({
    ciphertext: Buffer.from(cell.c, 'base64'),
    iv: Buffer.from(cell.i, 'base64'),
    tag: Buffer.from(cell.t, 'base64'),
  });
}

/** 保存前校验 + 归一。prev 行按索引对齐：__masked 占位按行下标沿用旧密文
 *  （前端语义：没改过的敏感格原样回传；改行顺序时应同步改值，不做跨行追踪）。 */
function normalizeDataset(
  input: DatasetSaveBody,
  prev?: { columns: DatasetColumn[]; rows: DatasetRow[] },
): { name: string; description: string | null; columns: DatasetColumn[]; rows: DatasetRow[] } {
  const name = input.name.trim();
  if (!name) throw new HttpError(400, 'bad_request', 'dataset name is required');
  const seen = new Set<string>();
  const columns: DatasetColumn[] = [];
  for (const c of input.columns ?? []) {
    const colName = (c.name ?? '').trim();
    if (!validateVariableName(colName).ok) {
      throw new HttpError(400, 'bad_request', `列名 ${colName} 不是合法变量名（字母/下划线开头，仅字母数字下划线）`);
    }
    if (seen.has(colName)) throw new HttpError(400, 'bad_request', `列名重复：${colName}`);
    seen.add(colName);
    columns.push({ name: colName, sensitive: !!c.sensitive });
  }
  if (columns.length === 0) throw new HttpError(400, 'bad_request', '至少需要一列');
  if (columns.length > MAX_COLUMNS) throw new HttpError(400, 'bad_request', `列数超上限（最多 ${MAX_COLUMNS} 列）`);
  if ((input.rows ?? []).length > MAX_ROWS) throw new HttpError(400, 'bad_request', `行数超上限（最多 ${MAX_ROWS} 行）`);

  const prevRows = prev?.rows ?? [];
  const rows: DatasetRow[] = (input.rows ?? []).map((row, i) => {
    const cells: DatasetRow['cells'] = {};
    for (const [k, v] of Object.entries(row.cells ?? {})) {
      if (!seen.has(k)) throw new HttpError(400, 'bad_request', `第 ${i + 1} 行存在未知列：${k}`);
      const col = columns.find((c) => c.name === k)!;
      const prevCell = prevRows[i]?.cells[k];
      if (col.sensitive) {
        if (typeof v === 'string') {
          cells[k] = v.length > 0 ? encryptCell(v) : '';
        } else if (isMaskedCell(v)) {
          // 密码框语义：未改动占位符回传 → 沿用旧密文；旧值是明文（列刚切成敏感）视为空
          cells[k] = isEncCell(prevCell) ? prevCell : '';
        } else {
          throw new HttpError(400, 'bad_request', `第 ${i + 1} 行列 ${k} 的值类型不合法`);
        }
      } else {
        if (typeof v === 'string') {
          cells[k] = v;
        } else if (isMaskedCell(v)) {
          // 刚从敏感切成非敏感：把旧密文解回明文（用户要求去敏）
          cells[k] = isEncCell(prevCell) ? decryptCell(prevCell) : (typeof prevCell === 'string' ? prevCell : '');
        } else {
          throw new HttpError(400, 'bad_request', `第 ${i + 1} 行列 ${k} 的值类型不合法`);
        }
      }
    }
    return { disabled: !!row.disabled, cells };
  });
  return { name, description: input.description?.trim() ? input.description.trim() : null, columns, rows };
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/** 列表出参：不带 rows 明细，带行数统计。 */
export async function listDatasets(projectId: string) {
  const rows = await db.select().from(datasets).where(eq(datasets.projectId, projectId)).orderBy(asc(datasets.createdAt));
  return rows.map((d) => ({
    id: d.id,
    projectId: d.projectId,
    name: d.name,
    description: d.description,
    columns: d.columns,
    rowCount: d.rows.length,
    enabledRowCount: d.rows.filter((r) => !r.disabled).length,
    updatedAt: d.updatedAt,
  }));
}

/** 详情出参：敏感格密文 → {__masked:true} 占位，其余明文。 */
export async function getDataset(datasetId: string) {
  const d = (await db.select().from(datasets).where(eq(datasets.id, datasetId)).limit(1))[0];
  if (!d) return null;
  const sensitive = new Set(d.columns.filter((c) => c.sensitive).map((c) => c.name));
  const rows = d.rows.map((r) => ({
    disabled: r.disabled,
    cells: Object.fromEntries(
      Object.entries(r.cells).map(([k, v]) => [k, sensitive.has(k) && isEncCell(v) ? DATASET_MASKED_CELL : v]),
    ),
  }));
  return { ...d, rows };
}

export async function createDataset(projectId: string, input: DatasetSaveBody) {
  const normalized = normalizeDataset(input);
  try {
    return (await db.insert(datasets).values({ projectId, ...normalized }).returning())[0]!;
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'name_conflict', 'dataset name already exists in this project');
    throw e;
  }
}

export async function updateDataset(datasetId: string, input: DatasetSaveBody) {
  const prev = (await db.select().from(datasets).where(eq(datasets.id, datasetId)).limit(1))[0];
  if (!prev) throw new HttpError(404, 'not_found', 'dataset not found');
  const normalized = normalizeDataset(input, { columns: prev.columns, rows: prev.rows });
  try {
    return (await db
      .update(datasets)
      .set({ ...normalized, updatedAt: new Date() })
      .where(eq(datasets.id, datasetId))
      .returning())[0]!;
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'name_conflict', 'dataset name already exists in this project');
    throw e;
  }
}

/** 删除前引用计数（绑定该数据集的用例数；删除后 FK 置空自动解绑）。 */
export async function datasetUsage(datasetId: string): Promise<{ caseCount: number }> {
  const rows = await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.datasetId, datasetId));
  return { caseCount: rows.length };
}

export async function deleteDataset(datasetId: string): Promise<void> {
  const deleted = await db.delete(datasets).where(eq(datasets.id, datasetId)).returning({ id: datasets.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'dataset not found');
}

/** 单行回放上下文：vars=解密后初始变量（仅执行期内存）；snapshot=落报告的行快照（敏感值固定 ******）。 */
export interface DatasetRowExec {
  rowIndex: number;
  totalRows: number;
  vars: Record<string, string>;
  sensitiveVarKeys: string[];
  snapshot: { rowIndex: number; totalRows: number; values: Record<string, string> };
}

/** 回放装载：过滤 disabled 行、解密敏感格、产出每行初始 vars 与快照。配置错误抛 DatasetConfigError。 */
export async function loadDatasetForRun(datasetId: string): Promise<{
  datasetId: string;
  columns: DatasetColumn[];
  rows: DatasetRowExec[];
}> {
  const d = (await db.select().from(datasets).where(eq(datasets.id, datasetId)).limit(1))[0];
  if (!d) throw new DatasetConfigError('dataset not found');
  for (const c of d.columns) {
    if (!validateVariableName(c.name).ok) {
      throw new DatasetConfigError(`数据集列名 ${c.name} 不是合法变量名，无法注入回放变量`);
    }
  }
  const enabled = d.rows.filter((r) => !r.disabled);
  if (enabled.length === 0) throw new DatasetConfigError('数据集没有启用行，无法回放');
  const sensitiveVarKeys = d.columns.filter((c) => c.sensitive).map((c) => c.name);
  const rows: DatasetRowExec[] = enabled.map((row, i) => {
    const vars: Record<string, string> = {};
    const values: Record<string, string> = {};
    for (const col of d.columns) {
      const cell = row.cells[col.name];
      if (col.sensitive && isEncCell(cell)) {
        vars[col.name] = decryptCell(cell);
        values[col.name] = '******';
      } else {
        vars[col.name] = typeof cell === 'string' ? cell : '';
        values[col.name] = typeof cell === 'string' ? cell : '';
      }
    }
    return {
      rowIndex: i,
      totalRows: enabled.length,
      vars,
      sensitiveVarKeys,
      snapshot: { rowIndex: i, totalRows: enabled.length, values },
    };
  });
  return { datasetId: d.id, columns: d.columns, rows };
}
```

注意：若 `validateVariableName` 的实际返回不是 `{ ok: boolean }` 形态（先看 `packages/shared/src/variable.ts`），按实际导出调整——语义是「列名必须是合法变量名」，非法要报错。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/datasets.test.ts`
Expected: PASS（全部 8 个用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/datasets.service.ts apps/api/test/datasets.test.ts
git commit -m "feat(api): 数据集 service（CRUD/敏感列加密/__masked 占位/回放装载）"
```

---

### Task 3: datasets 路由 + 可见性 + 注册

**Files:**
- Create: `apps/api/src/routes/datasets.ts`
- Modify: `apps/api/src/services/projectAccess.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/test/datasets.test.ts`（追加 HTTP 测试）

- [ ] **Step 1: 追加失败测试（datasets.test.ts 末尾新 describe）**

在 `datasets.test.ts` 中追加（同时在文件顶部 import 区加 `import request from 'supertest';` 和 `let app: import('express').Express;`，并在 beforeAll 末尾追加挂载代码）：

beforeAll 末尾追加：

```ts
  const { default: express } = await import('express');
  const { datasetsRoute } = await import('../src/routes/datasets.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api', datasetsRoute);
  app.use(errorHandler);
```

追加测试：

```ts
describe('datasets routes', () => {
  it('GET /projects/:id/datasets 列表不带 rows；POST 新建', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send(body);
    expect(created.status).toBe(200);
    expect(created.body.id).toBeTruthy();
    const list = await request(app).get(`/api/projects/${projectId}/datasets`);
    expect(list.status).toBe(200);
    const item = list.body.find((d: { id: string }) => d.id === created.body.id);
    expect(item.rowCount).toBe(2);
    expect(item.enabledRowCount).toBe(2);
    expect(item.rows).toBeUndefined();
    expect(item.columns).toEqual(body.columns.map((c) => ({ name: c.name, sensitive: c.sensitive })));
  });

  it('GET 详情敏感格 __masked；PUT 整文档更新', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...body, name: '路由编辑' });
    const detail = await request(app).get(`/api/projects/${projectId}/datasets/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.rows[0].cells.password).toEqual({ __masked: true });
    const updated = await request(app)
      .put(`/api/projects/${projectId}/datasets/${created.body.id}`)
      .send({ ...body, name: '路由编辑', rows: [{ disabled: true, cells: { username: 'z', password: { __masked: true } } }] });
    expect(updated.status).toBe(200);
    const list = await request(app).get(`/api/projects/${projectId}/datasets`);
    const item = list.body.find((d: { id: string }) => d.id === created.body.id);
    expect(item.enabledRowCount).toBe(0);
  });

  it('DELETE 需确认：先返回 requiresConfirm，confirm=true 后删除并解绑用例', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...body, name: '路由删除' });
    await pool.query(`INSERT INTO test_cases(group_id, version_id, title, dataset_id) VALUES ($1, $2, '删除绑定', $3)`, [groupId, versionId, created.body.id]);
    const first = await request(app).delete(`/api/projects/${projectId}/datasets/${created.body.id}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: false, requiresConfirm: true, caseCount: 1 });
    const second = await request(app).delete(`/api/projects/${projectId}/datasets/${created.body.id}?confirm=true`);
    expect(second.body).toEqual({ ok: true, caseCount: 1 });
    const gone = await request(app).get(`/api/projects/${projectId}/datasets/${created.body.id}`);
    expect(gone.status).toBe(404);
  });

  it('跨项目访问 404（不泄露存在性）', async () => {
    const other = await pool.query(`INSERT INTO projects(organization_id, name) VALUES ($1, '别家项目') RETURNING id`, [orgId]);
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...body, name: '隔离' });
    const r = await request(app).get(`/api/projects/${other.rows[0].id}/datasets/${created.body.id}`);
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/datasets.test.ts`
Expected: FAIL — `Cannot find module '../src/routes/datasets.js'`。

- [ ] **Step 3: projectAccess.ts 加数据集可见性**

在 `apps/api/src/services/projectAccess.ts` 的 `assertEnvironmentVisible` 函数（第 93 行 `}` 之后）追加：

```ts
/** 解析 dataset 所属项目 id；不存在返回 null。 */
export async function resolveDatasetProjectId(datasetId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: datasets.projectId })
    .from(datasets)
    .where(eq(datasets.id, datasetId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** dataset 可见性断言：经所属项目判定，404 文案不区分「不存在」与「不可见」。 */
export async function assertDatasetVisible(datasetId: string, user: AuthUser): Promise<{ projectId: string }> {
  const projectId = await resolveDatasetProjectId(datasetId);
  if (!projectId) throw new HttpError(404, 'not_found', 'dataset not found');
  await assertProjectVisible(projectId, user);
  return { projectId };
}
```

并把文件顶部 schema import 行改为包含 `datasets`：

```ts
import { groups, projects, projectVersions, reports, testCases, testEnvironments, planRuns, datasets } from '../db/schema.js';
```

- [ ] **Step 4: 新建 `apps/api/src/routes/datasets.ts`**

```ts
import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { datasets } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';
import {
  createDataset,
  datasetUsage,
  deleteDataset,
  getDataset,
  listDatasets,
  updateDataset,
} from '../services/datasets.service.js';

export const datasetsRoute = Router();

const SaveBody = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  columns: z.array(z.object({ name: z.string(), sensitive: z.boolean().optional() })),
  rows: z.array(z.object({ disabled: z.boolean().optional(), cells: z.record(z.string(), z.unknown()) })),
});

/** 数据集属指定项目（projectId 匹配 + 项目可见），否则 404。 */
async function assertDsInProject(dsId: string, projectId: string, user: unknown): Promise<void> {
  const row = (await db
    .select({ pid: datasets.projectId })
    .from(datasets)
    .where(and(eq(datasets.id, dsId), eq(datasets.projectId, projectId)))
    .limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found', 'dataset not found');
  await assertProjectVisible(projectId, user as never);
}

datasetsRoute.get('/projects/:projectId/datasets', async (req, res) => {
  await assertProjectVisible(req.params.projectId!, req.user!);
  res.json(await listDatasets(req.params.projectId!));
});

datasetsRoute.post('/projects/:projectId/datasets', async (req, res) => {
  await assertProjectVisible(req.params.projectId!, req.user!);
  const body = SaveBody.parse(req.body);
  res.json(await createDataset(req.params.projectId!, body));
});

datasetsRoute.get('/projects/:projectId/datasets/:dsId', async (req, res) => {
  const { projectId, dsId } = req.params;
  await assertProjectVisible(projectId!, req.user!);
  await assertDsInProject(dsId!, projectId!, req.user!);
  const detail = await getDataset(dsId!);
  if (!detail) throw new HttpError(404, 'not_found', 'dataset not found');
  res.json(detail);
});

datasetsRoute.put('/projects/:projectId/datasets/:dsId', async (req, res) => {
  const { projectId, dsId } = req.params;
  await assertProjectVisible(projectId!, req.user!);
  await assertDsInProject(dsId!, projectId!, req.user!);
  const body = SaveBody.parse(req.body);
  res.json(await updateDataset(dsId!, body));
});

datasetsRoute.delete('/projects/:projectId/datasets/:dsId', async (req, res) => {
  const { projectId, dsId } = req.params;
  await assertProjectVisible(projectId!, req.user!);
  await assertDsInProject(dsId!, projectId!, req.user!);
  const usage = await datasetUsage(dsId!);
  if (req.query.confirm !== 'true') {
    res.json({ ok: false, requiresConfirm: true, caseCount: usage.caseCount });
    return;
  }
  await deleteDataset(dsId!);
  res.json({ ok: true, caseCount: usage.caseCount });
});
```

- [ ] **Step 5: index.ts 注册路由**

在 `apps/api/src/index.ts`：
1. import 区与其它 route import 并列加：

```ts
import { datasetsRoute } from './routes/datasets.js';
```

2. 在 `app.use('/api', environmentsRoute);` 之后加：

```ts
app.use('/api', datasetsRoute);
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/datasets.test.ts`
Expected: PASS（service + routes 全部用例）。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/datasets.ts apps/api/src/services/projectAccess.ts apps/api/src/index.ts apps/api/test/datasets.test.ts
git commit -m "feat(api): 数据集 CRUD 路由（项目可见性 + 确认删除解绑提示）"
```

---

### Task 4: 用例绑定 datasetId

**Files:**
- Modify: `apps/api/src/routes/cases.ts`
- Modify: `apps/api/src/services/cases.service.ts`
- Modify: `apps/api/test/datasets.test.ts`

- [ ] **Step 1: 追加失败测试（datasets.test.ts 末尾新 describe）**

测试 app 还需挂 casesRoute —— beforeAll 的挂载代码里、`app.use('/api', datasetsRoute);` 之后加：

```ts
  const { casesRoute } = await import('../src/routes/cases.js');
  app.use('/api/cases', casesRoute);
```

追加测试：

```ts
describe('case dataset binding', () => {
  async function newCase(title: string): Promise<string> {
    const r = await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, $3) RETURNING id`,
      [groupId, versionId, title],
    );
    return r.rows[0].id as string;
  }

  it('PATCH 绑定/解绑 datasetId；详情回带 datasetId', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '绑定目标' });
    const caseId = await newCase('绑定流程');
    const bind = await request(app).patch(`/api/cases/${caseId}`).send({ datasetId: created.id });
    expect(bind.status).toBe(200);
    expect(bind.body.datasetId).toBe(created.id);
    const detail = await request(app).get(`/api/cases/${caseId}`);
    expect(detail.body.datasetId).toBe(created.id);
    const unbind = await request(app).patch(`/api/cases/${caseId}`).send({ datasetId: null });
    expect(unbind.body.datasetId).toBeNull();
  });

  it('绑定别的项目的数据集报 400', async () => {
    const other = await pool.query(`INSERT INTO projects(organization_id, name) VALUES ($1, '别家2') RETURNING id`, [orgId]);
    await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'G')`, [other.rows[0].id]);
    const g = await pool.query(`SELECT id FROM "groups" WHERE project_id = $1`, [other.rows[0].id]);
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '本项目的' });
    const foreign = await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, '外案') RETURNING id`,
      [g.rows[0].id, versionId],
    );
    const r = await request(app).patch(`/api/cases/${foreign.rows[0].id}`).send({ datasetId: created.id });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/datasets.test.ts`
Expected: FAIL — PATCH 响应无 datasetId（zod 剥掉了未知字段）。

- [ ] **Step 3: cases.ts 路由 — PatchBody + 校验**

`apps/api/src/routes/cases.ts` PatchBody（45-54 行）`defaultEnvId` 行之后加一行：

```ts
    // 绑定数据集 id；null 表示解绑，undefined 表示不动
    datasetId: z.string().uuid().nullable().optional(),
```

PATCH handler（131-146 行）在 `defaultEnvId` 校验块之后加：

```ts
  if (body.datasetId !== undefined && body.datasetId !== null) {
    const { assertDatasetVisible } = await import('../services/projectAccess.js');
    await assertDatasetVisible(body.datasetId, req.user!);
  }
```

- [ ] **Step 4: cases.service.ts — UpdateCasePatch + 归属校验**

`apps/api/src/services/cases.service.ts`：

1. `UpdateCasePatch` 接口（150-165 行）`defaultEnvId?: string | null;` 之后加：

```ts
  datasetId?: string | null;
```

2. updateCase 内 defaultEnvId 校验块（192-196 行）之后加（同样式）：

```ts
  if (patch.datasetId !== undefined && patch.datasetId !== null) {
    const dsPid = await resolveDatasetProjectId(patch.datasetId);
    if (!dsPid) throw new HttpError(404, 'not_found', 'dataset not found');
    if (dsPid !== targetPid) throw new HttpError(400, 'dataset_project_mismatch', 'dataset does not belong to this project');
  }
```

3. 文件顶部 projectAccess import 行补 `resolveDatasetProjectId`（该文件已 import `resolveEnvironmentProjectId`，同行追加即可）。

`datasetId` 经现有 `const { tagIds, ...rest } = patch; db.update(testCases).set({ ...rest, ... })` 自动落库，无需再改。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/datasets.test.ts`
Expected: PASS。

Run: `pnpm -C apps/api exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/cases.ts apps/api/src/services/cases.service.ts apps/api/test/datasets.test.ts
git commit -m "feat(api): 用例绑定数据集（PATCH datasetId + 项目归属校验）"
```

---

### Task 5: 执行器 initialVars / sensitiveVarKeys / 错误打码

**Files:**
- Modify: `apps/api/src/execute/cdp.ts`
- Create: `apps/api/test/mask-sensitive-vars.test.ts`

- [ ] **Step 1: 写失败测试 `apps/api/test/mask-sensitive-vars.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { maskSensitiveValues } from '../src/execute/cdp.js';

describe('maskSensitiveValues', () => {
  it('把文本中出现的敏感变量值替换为 ******', () => {
    const vars = { password: 's3cret-Pw', username: 'alice' };
    const text = 'assertText failed: expected "s3cret-Pw", actual "bad"';
    expect(maskSensitiveValues(text, vars, ['password'])).toBe(
      'assertText failed: expected "******", actual "bad"',
    );
  });

  it('只打码 sensitiveVarKeys 中的变量，非敏感值不动', () => {
    const vars = { password: 'pw', username: 'alice' };
    expect(maskSensitiveValues('alice/pw', vars, ['password'])).toBe('alice/******');
    expect(maskSensitiveValues('alice/pw', vars, [])).toBe('alice/pw');
  });

  it('值多次出现全部替换；空 keys / 空值原样返回', () => {
    expect(maskSensitiveValues('a a a', { a: 'a' }, ['a'])).toBe('****** ****** ******');
    expect(maskSensitiveValues('x', { a: '' }, ['a'])).toBe('x');
    expect(maskSensitiveValues('x', {}, [])).toBe('x');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/mask-sensitive-vars.test.ts`
Expected: FAIL — `maskSensitiveValues` 未导出。

- [ ] **Step 3: cdp.ts 实现**

`apps/api/src/execute/cdp.ts` 三处修改：

1. `ExecContext` 接口（70-93 行）末尾 `caseUrl` 字段后追加：

```ts
  /** 数据集行初始变量（解密后明文，仅存在于执行期内存，不落库）。 */
  initialVars?: Record<string, string>;
  /** 数据集敏感列名集合：错误信息落报告前对相关变量值打码（与 recorder 敏感处理对齐）。 */
  sensitiveVarKeys?: string[];
```

2. `runStepsInContext` 内 vars 初始化（639 行）：

```ts
  const vars: Record<string, string> = { ...(ctx.initialVars ?? {}) };
```

（语义：步骤执行中 `extract` 写同名变量直接覆盖数据集初始值，执行顺序即优先级——`vars[action.varName] = resolved` 已满足，无需额外改动。）

3. 文件级导出打码函数（放在 `runStepsInContext` 之前）：

```ts
/** 报告侧脱敏：把 text 中出现的敏感变量值全部替换为 ******。
 *  用 split/join 而非 RegExp，避免值里含正则元字符。 */
export function maskSensitiveValues(text: string, vars: Record<string, string>, keys: readonly string[]): string {
  let out = text;
  for (const k of keys) {
    const v = vars[k];
    if (typeof v === 'string' && v.length > 0) out = out.split(v).join('******');
  }
  return out;
}
```

4. 步骤循环 catch 块（约 716 行起）：在 `const classified = classify(...)` **之前**插入原地打码（classify 的 humanMessage 可能复用 e.message，必须先改写）：

```ts
      // 数据集敏感列脱敏：assertText 等错误信息带物化后的期望值（{{password}} 明文），
      // classify/humanMessage 可能复用 e.message —— 落报告前原地打码，闭环列级加密。
      if (e instanceof Error && ctx.sensitiveVarKeys && ctx.sensitiveVarKeys.length > 0) {
        e.message = maskSensitiveValues(e.message, vars, ctx.sensitiveVarKeys);
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/mask-sensitive-vars.test.ts`
Expected: PASS。

Run: `pnpm -C apps/api exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execute/cdp.ts apps/api/test/mask-sensitive-vars.test.ts
git commit -m "feat(api): 执行器注入数据集初始变量 + 错误信息敏感值打码"
```

---

### Task 6: runCase 行迭代 + 执行入口 400 + reports 出参两列

**Files:**
- Modify: `apps/api/src/execute/runCase.ts`
- Modify: `apps/api/src/routes/execute.ts`
- Modify: `apps/api/src/routes/reports.ts`
- Create: `apps/api/test/runCase-dataset.test.ts`

- [ ] **Step 1: 写失败测试 `apps/api/test/runCase-dataset.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// mock 真实浏览器执行器：默认返回空结果（= 该行所有步骤通过）；各测试用 execMock 定制成败。
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('../src/execute/cdp.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, executeCaseReal: execMock, executeCaseInBrowser: execMock };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let projectId: string;
let groupId: string;
let versionId: string;

const dsBody = {
  name: '登录数据',
  columns: [
    { name: 'username', sensitive: false },
    { name: 'password', sensitive: true },
  ],
  rows: [
    { disabled: false, cells: { username: 'alice', password: 'pw-1' } },
    { disabled: false, cells: { username: 'bob', password: 'pw-2' } },
  ],
};

async function insertCase(title: string, datasetId: string | null): Promise<string> {
  const r = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title, dataset_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [groupId, versionId, title, datasetId],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  // 项目默认环境：避免 EnvMissing 把每行 report 直接判失败
  await pool.query(`INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认', true)`, [projectId]);

  const { default: express } = await import('express');
  const { datasetsRoute } = await import('../src/routes/datasets.js');
  const { executeRoute } = await import('../src/routes/execute.js');
  const { reportsRoute } = await import('../src/routes/reports.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(seed.userId, seed.username, seed.orgId, seed.orgPath);
    next();
  });
  app.use('/api', datasetsRoute);
  app.use('/api', executeRoute);
  app.use('/api/reports', reportsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('runCase dataset iteration', () => {
  it('绑 2 行数据集 → 2 条 report，带 rowIndex/快照（敏感打码），执行器收到解密 initialVars', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send(dsBody);
    expect(created.status).toBe(200);
    const caseId = await insertCase('登录回放', created.body.id);

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    expect(r.body.reportIds).toHaveLength(2);
    expect(r.body.reportId).toBe(r.body.reportIds[0]);
    expect(r.body.status).toBeUndefined(); // 单执行入口不回传 status（保持旧响应形状）

    // 执行器收到该行解密后的初始变量 + 敏感列名
    expect(execMock).toHaveBeenCalledTimes(2);
    const firstCtx = execMock.mock.calls[0]![2] as { initialVars?: Record<string, string>; sensitiveVarKeys?: string[] };
    expect(firstCtx.initialVars).toEqual({ username: 'alice', password: 'pw-1' });
    expect(firstCtx.sensitiveVarKeys).toEqual(['password']);

    const rep = await request(app).get(`/api/reports/${r.body.reportIds[1]}`);
    expect(rep.status).toBe(200);
    expect(rep.body.datasetRowIndex).toBe(1);
    expect(rep.body.datasetSnapshot).toEqual({
      rowIndex: 1,
      totalRows: 2,
      values: { username: 'bob', password: '******' },
    });
    // 解密值绝不落库：report 行里搜不到明文
    const raw = await pool.query(`SELECT dataset_snapshot::text AS s FROM reports WHERE id = $1`, [r.body.reportIds[1]]);
    expect(raw.rows[0].s).not.toContain('pw-2');
  });

  it('单行失败不中断：第 1 行抛错记 failed，第 2 行继续；两条 report 齐全', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '失败迭代' });
    const caseId = await insertCase('失败不中断', created.body.id);

    execMock.mockReset();
    execMock.mockRejectedValueOnce(new Error('row boom')).mockResolvedValue([]);
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    expect(r.body.reportIds).toHaveLength(2);

    const rep0 = await request(app).get(`/api/reports/${r.body.reportIds[0]}`);
    expect(rep0.body.status).toBe('failed');
    const rep1 = await request(app).get(`/api/reports/${r.body.reportIds[1]}`);
    expect(rep1.body.status).toBe('passed');
  });

  it('0 启用行 → 400 且不产生任何 report', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({
      ...dsBody,
      name: '全禁用行',
      rows: dsBody.rows.map((row) => ({ ...row, disabled: true })),
    });
    const caseId = await insertCase('空数据集', created.body.id);
    const before = await request(app).get(`/api/reports?projectId=${projectId}`);

    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(400);
    const after = await request(app).get(`/api/reports?projectId=${projectId}`);
    expect(after.body).toHaveLength(before.body.length);
  });

  it('未绑定数据集：单 report，无 reportIds（零行为变化）', async () => {
    const caseId = await insertCase('普通用例', null);
    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    expect(r.body.reportId).toBeTruthy();
    expect(r.body.reportIds).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/runCase-dataset.test.ts`
Expected: FAIL — 响应无 reportIds / reports 出参无 datasetRowIndex（迭代未实现）。

- [ ] **Step 3: 重构 runCase.ts 为「迭代壳 + runCaseOnce」**

`apps/api/src/execute/runCase.ts`：

1. 顶部 import 区加：

```ts
import { loadDatasetForRun, type DatasetRowExec } from '../services/datasets.service.js';
```

2. 把现有 `export async function runCase(` 整个函数头（19-30 行）替换为下面的迭代壳 + `runCaseOnce` 头（函数体从 `const group = caseRow.groupId` 起原样保留在 runCaseOnce 里，但**删除** runCaseOnce 里的 `const caseRow = ...; if (!caseRow) throw new Error('case not found');` 两行——caseRow 由参数传入）：

```ts
export async function runCase(
  caseId: string,
  opts?: {
    storageState?: unknown;
    forceFail?: boolean;
    envOverride?: { envId: string } | null;
    ownedBrowser?: Browser;
    ownedContext?: BrowserContext;
  },
): Promise<{ reportId: string; status: string; reportIds?: string[] }> {
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!caseRow) throw new Error('case not found');

  // 数据集绑定：前置校验（0 启用行/列名非法）直接抛 DatasetConfigError —— 配置错误不产生垃圾 report。
  if (caseRow.datasetId) {
    const plan = await loadDatasetForRun(caseRow.datasetId);
    const reportIds: string[] = [];
    let finalStatus = 'passed';
    for (const row of plan.rows) {
      // 行失败不中断：任何单行错误已在 runCaseOnce 内记为该行 report failed，这里只聚合。
      const r = await runCaseOnce(caseId, caseRow, opts, row);
      reportIds.push(r.reportId);
      if (r.status !== 'passed') finalStatus = 'failed';
    }
    return { reportId: reportIds[0]!, status: finalStatus, reportIds };
  }
  return runCaseOnce(caseId, caseRow, opts);
}

/** 单次执行（数据集模式下每行调一次）。rowPlan 存在时：report 带 rowIndex/快照，执行器注入初始变量。 */
async function runCaseOnce(
  caseId: string,
  caseRow: typeof testCases.$inferSelect,
  opts: {
    storageState?: unknown;
    forceFail?: boolean;
    envOverride?: { envId: string } | null;
    ownedBrowser?: Browser;
    ownedContext?: BrowserContext;
  } | undefined,
  rowPlan?: DatasetRowExec,
): Promise<{ reportId: string; status: string }> {
```

3. runCaseOnce 函数体内两处小改：

report 插入（原 44-48 行）改为：

```ts
  const inserted = await db
    .insert(reports)
    .values({
      caseId,
      status: 'running',
      stepResults: [] as object,
      summary: 'execution in progress',
      ...(rowPlan ? { datasetRowIndex: rowPlan.rowIndex, datasetSnapshot: rowPlan.snapshot } : {}),
    })
    .returning();
```

execCtx 构造（原 132-140 行）末尾追加两行：

```ts
      ...(rowPlan
        ? { initialVars: rowPlan.vars, sensitiveVarKeys: rowPlan.sensitiveVarKeys }
        : {}),
```

4. 更新 runCaseOnce 上方的 JSDoc：说明数据集迭代语义（N 行 = N report，行失败不中断）。

- [ ] **Step 4: execute.ts 响应 + 400 映射**

`apps/api/src/routes/execute.ts` 整个 POST handler 替换为：

```ts
executeRoute.post('/cases/:caseId/execute', async (req, res) => {
  const { caseId } = Body.parse({ caseId: req.params.caseId });
  if (caseId !== req.params.caseId) throw new HttpError(400, 'bad_request', 'caseId mismatch');
  await assertCaseVisible(caseId, req.user!);
  try {
    const r = await runCase(caseId);
    res.json({ reportId: r.reportId, ...(r.reportIds ? { reportIds: r.reportIds } : {}) });
  } catch (e) {
    if (e instanceof Error && e.message === 'case not found') {
      throw new HttpError(404, 'not_found', 'case not found');
    }
    if (e instanceof DatasetConfigError) {
      throw new HttpError(400, 'dataset_config_error', e.message);
    }
    throw e;
  }
});
```

顶部 import 区加：

```ts
import { DatasetConfigError } from '../services/datasets.service.js';
```

- [ ] **Step 5: reports.ts 三处 select 补两列**

`apps/api/src/routes/reports.ts` 有 3 个显式 select（第 30、49、60 行，形状相同）。每处的：

```ts
        .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, stepResults: reports.stepResults, preflight: reports.preflight, summary: reports.summary, createdAt: reports.createdAt })
```

改为：

```ts
        .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, stepResults: reports.stepResults, preflight: reports.preflight, summary: reports.summary, createdAt: reports.createdAt, datasetRowIndex: reports.datasetRowIndex, datasetSnapshot: reports.datasetSnapshot })
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/runCase-dataset.test.ts`
Expected: PASS（4 个用例）。

Run: `pnpm -C apps/api exec vitest run test/reports.test.ts test/datasets.test.ts`
Expected: PASS（回归）。

Run: `pnpm -C apps/api exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/execute/runCase.ts apps/api/src/routes/execute.ts apps/api/src/routes/reports.ts apps/api/test/runCase-dataset.test.ts
git commit -m "feat(api): 回放按数据集行迭代（N 行 N 报告、行失败不中断、0 启用行 400）"
```

---

### Task 7: 计划执行 reportIds + rowStatuses

**Files:**
- Modify: `apps/api/src/execute/runPlan.ts`
- Modify: `apps/api/src/routes/planRuns.ts`
- Create: `apps/api/test/plan-run-datasets.test.ts`

- [ ] **Step 1: 写失败测试 `apps/api/test/plan-run-datasets.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('../src/execute/cdp.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, executeCaseReal: execMock, executeCaseInBrowser: execMock };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let projectId: string;
let groupId: string;
let versionId: string;

const dsBody = {
  name: '计划数据',
  columns: [{ name: 'username', sensitive: false }],
  rows: [
    { disabled: false, cells: { username: 'u1' } },
    { disabled: false, cells: { username: 'u2' } },
  ],
};

async function insertCase(title: string, datasetId: string | null): Promise<string> {
  const r = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title, dataset_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [groupId, versionId, title, datasetId],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  await pool.query(`INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认', true)`, [projectId]);

  const { default: express } = await import('express');
  const { datasetsRoute } = await import('../src/routes/datasets.js');
  const { planRunsRoute } = await import('../src/routes/planRuns.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(seed.userId, seed.username, seed.orgId, seed.orgPath);
    next();
  });
  app.use('/api', datasetsRoute);
  app.use('/api/plan-runs', planRunsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makePlan(boundCaseId: string, plainCaseId: string): Promise<string> {
  const p = await pool.query(
    `INSERT INTO execution_plans(project_id, name) VALUES ($1, '数据集计划') RETURNING id`,
    [projectId],
  );
  const planId = p.rows[0].id as string;
  await pool.query(`INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 1)`, [planId, boundCaseId]);
  await pool.query(`INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 2)`, [planId, plainCaseId]);
  const r = await pool.query(
    `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, 'running', 'run_all') RETURNING id`,
    [planId, projectId],
  );
  return r.rows[0].id as string;
}

describe('runPlan dataset aggregation', () => {
  it('绑数据集用例产生 reportIds（N 行全过 → 用例 pass）；详情接口附 rowStatuses', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send(dsBody);
    const boundCaseId = await insertCase('绑定用例', created.body.id);
    const plainCaseId = await insertCase('普通用例', null);
    const planRunId = await makePlan(boundCaseId, plainCaseId);

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    const prc = await pool.query(`SELECT * FROM plan_run_cases WHERE plan_run_id = $1 ORDER BY "order"`, [planRunId]);
    expect(prc.rows).toHaveLength(2);
    const bound = prc.rows.find((r: { case_id: string }) => r.case_id === boundCaseId)!;
    const plain = prc.rows.find((r: { case_id: string }) => r.case_id === plainCaseId)!;
    expect(Array.isArray(bound.report_ids)).toBe(true);
    expect(bound.report_ids).toHaveLength(2);
    expect(bound.report_id).toBe(bound.report_ids[0]); // 兼容字段指向第一条
    expect(bound.status).toBe('passed'); // N 行全 pass 才 pass
    expect(plain.report_ids).toBeNull();
    expect(plain.status).toBe('passed');

    // report 实际 2 条
    const reps = await pool.query(`SELECT count(*)::int AS n FROM reports WHERE case_id = $1`, [boundCaseId]);
    expect(reps.rows[0].n).toBe(2);

    // 详情接口：rowStatuses 与 reportIds 对齐
    const detail = await request(app).get(`/api/plan-runs/${planRunId}`);
    expect(detail.status).toBe(200);
    const boundCase = detail.body.cases.find((c: { caseId: string }) => c.caseId === boundCaseId);
    expect(boundCase.rowStatuses).toEqual(['passed', 'passed']);
  });

  it('任一行 fail → 该用例 fail，计划计数 failed+1', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '行失败' });
    const boundCaseId = await insertCase('行失败用例', created.body.id);
    const plainCaseId = await insertCase('普通2', null);
    const planRunId = await makePlan(boundCaseId, plainCaseId);

    execMock.mockReset();
    execMock.mockRejectedValueOnce(new Error('row boom')).mockResolvedValue([]);
    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    const detail = await request(app).get(`/api/plan-runs/${planRunId}`);
    const boundCase = detail.body.cases.find((c: { caseId: string }) => c.caseId === boundCaseId);
    expect(boundCase.status).toBe('failed');
    expect(boundCase.rowStatuses).toEqual(['failed', 'passed']);
    expect(detail.body.failedCases).toBe(1);
    expect(detail.body.passedCases).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/plan-run-datasets.test.ts`
Expected: FAIL — `report_ids` 为 null / 详情无 rowStatuses。

- [ ] **Step 3: runPlan.ts 写入 reportIds**

`apps/api/src/execute/runPlan.ts` 业务用例循环里的 planRunCases update（244-247 行）：

```ts
      await db
        .update(planRunCases)
        .set({
          status: r.status,
          reportId: r.reportId,
          ...(r.reportIds ? { reportIds: r.reportIds } : {}),
          finishedAt: new Date(),
          error: r.status === 'failed' ? 'case failed' : null,
        })
        .where(eq(planRunCases.id, ins[0]!.id));
```

- [ ] **Step 4: planRuns.ts 详情附 rowStatuses**

`apps/api/src/routes/planRuns.ts` GET `/:id`（13-35 行）：

1. schema import 行补 `reports`：

```ts
import { planRuns, planRunCases, executionPlans, testCases, reports } from '../db/schema.js';
```

2. `const cases = caseRows.map(...)` 行（29 行）替换为：

```ts
  // 数据集迭代：批量取全部行 report 的状态，供前端展示「i/N 行通过」
  const reportIdList = caseRows.flatMap((c) => (Array.isArray(c.reportIds) ? c.reportIds : []));
  const statusRows = reportIdList.length
    ? await db.select({ id: reports.id, status: reports.status }).from(reports).where(inArray(reports.id, reportIdList))
    : [];
  const statusMap = new Map(statusRows.map((r) => [r.id, r.status]));
  const cases = caseRows.map((c) => ({
    ...c,
    caseTitle: titleMap.get(c.caseId) ?? null,
    rowStatuses: (c.reportIds ?? []).map((id) => statusMap.get(id) ?? 'unknown'),
  }));
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/plan-run-datasets.test.ts`
Expected: PASS（2 个用例）。

Run: `pnpm -C apps/api exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/execute/runPlan.ts apps/api/src/routes/planRuns.ts apps/api/test/plan-run-datasets.test.ts
git commit -m "feat(api): 计划执行记录数据集行 reportIds + 详情行状态聚合"
```

---

### Task 8: 前端 API client + 图标 + 路由 + 项目入口

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/components/Icon.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/pages/ProjectsHome.tsx`

- [ ] **Step 1: client.ts 类型与 api.datasets**

1. `Report` 接口（约 876 行，`createdAt: string;` 之前）加：

```ts
  datasetRowIndex?: number | null;
  datasetSnapshot?: { rowIndex: number; totalRows: number; values: Record<string, string> } | null;
```

2. `PlanRunDetail` 的 `cases` 数组元素（680-692 行）`reportId: string | null;` 之后加：

```ts
    reportIds?: string[] | null;
    rowStatuses?: string[];
```

3. `TestCase` 接口（含 `groupId`/`title`/`priority` 字段的那个）加一行：

```ts
  datasetId?: string | null;
```

4. `cases.execute`（330-331 行）改为：

```ts
    execute: (id: string) =>
      request<{ reportId: string; reportIds?: string[] }>(`/cases/${id}/execute`, { method: 'POST' }),
```

5. `cases.patch` 的 `body: Partial<{...}>` 参数里（261 行起）与 `defaultEnvId` 同级加一行 `datasetId: string | null;`。

6. `environments` api 段（182-202 行）之后新增（接口定义放在文件后部接口区，与其它 interface 并列）：

```ts
  datasets: {
    list: (projectId: string) => request<DatasetSummary[]>(`/projects/${projectId}/datasets`),
    get: (projectId: string, id: string) => request<DatasetDetail>(`/projects/${projectId}/datasets/${id}`),
    create: (projectId: string, body: DatasetSaveBody) =>
      request<DatasetDetail>(`/projects/${projectId}/datasets`, { method: 'POST', body: JSON.stringify(body) }),
    update: (projectId: string, id: string, body: DatasetSaveBody) =>
      request<DatasetDetail>(`/projects/${projectId}/datasets/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    remove: (projectId: string, id: string, opts?: { confirm?: boolean }) =>
      request<{ ok: boolean; requiresConfirm?: boolean; caseCount?: number }>(
        `/projects/${projectId}/datasets/${id}${opts?.confirm ? '?confirm=true' : ''}`,
        { method: 'DELETE' },
      ),
  },
```

接口定义（放 `Report` 接口附近）：

```ts
export interface DatasetSaveBody {
  name: string;
  description?: string | null;
  columns: Array<{ name: string; sensitive?: boolean }>;
  rows: Array<{ disabled?: boolean; cells: Record<string, unknown> }>;
}
export interface DatasetSummary {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  columns: Array<{ name: string; sensitive: boolean }>;
  rowCount: number;
  enabledRowCount: number;
  updatedAt: string;
}
export interface DatasetMaskedCell { __masked: true }
export interface DatasetDetail extends DatasetSummary {
  rows: Array<{ disabled: boolean; cells: Record<string, string | DatasetMaskedCell> }>;
}
```

- [ ] **Step 2: Icon.tsx 加 table 图标**

`apps/web/src/components/Icon.tsx`：import 区加 `import Table from '@carbon/icons-react/es/Table';`，`iconMap` 里 `database: DataBase,` 之后加 `table: Table,`。

- [ ] **Step 3: App.tsx 加路由**

`apps/web/src/App.tsx`：

1. import 区 `import EnvironmentsPage from './pages/EnvironmentsPage';` 之后加 `import DatasetsPage from './pages/DatasetsPage';`
2. 路由 `<Route path="/p/:projectId/environments" element={<EnvironmentsPage />} />`（42 行）之后加：

```tsx
        {/* 项目级数据集维护：与环境页同层级，不依赖版本上下文 */}
        <Route path="/p/:projectId/datasets" element={<DatasetsPage />} />
```

- [ ] **Step 4: ProjectsHome 加「数据集」入口**

`apps/web/src/pages/ProjectsHome.tsx`（对照 `onOpenEnvironments` 的既有穿线）：

1. `ProjectRowProps` 接口里 `onOpenEnvironments` 之后加 `onOpenDatasets: () => void;`
2. `ProjectRow` 组件解构参数与组件内 `onOpenEnvironments` 使用点同步加 `onOpenDatasets`
3. 项目行操作按钮区（IconButton 行，`onOpenEnvironments` 对应的那个 IconButton 旁）加：

```tsx
        <IconButton icon="table" title="数据集" onClick={onOpenDatasets} />
```

4. 调用点（约 303 行，`onOpenEnvironments={() => navigate(\`/p/${p.id}/environments\`)}` 旁）加：

```tsx
          onOpenDatasets={() => navigate(`/p/${p.id}/datasets`)}
```

- [ ] **Step 5: 类型检查**

Run: `pnpm -C apps/web exec tsc --noEmit`
Expected: 报 `DatasetsPage` 不存在（Task 9 创建）——若只此一个错误即通过本步；其余错误必须修掉。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/components/Icon.tsx apps/web/src/App.tsx apps/web/src/pages/ProjectsHome.tsx
git commit -m "feat(web): 数据集 API client/图标/路由与项目入口"
```

（若 DatasetsPage 缺失导致 tsc 失败，可先 `git add` 上述四文件 + 空 `apps/web/src/pages/DatasetsPage.tsx` 占位 `export default function DatasetsPage() { return null; }` 一并提交，Task 9 覆写。）

---

### Task 9: DatasetsPage（列表 + 表格编辑器 + TSV 粘贴）

**Files:**
- Create: `apps/web/src/pages/DatasetsPage.tsx`

- [ ] **Step 1: 写完整页面**

```tsx
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DatasetMaskedCell, type DatasetSaveBody, type DatasetSummary } from '../api/client';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import EmptyState from '../components/ui/EmptyState';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import { useUIStore } from '../stores/ui';
import { fullDateTime } from '../lib/format';

type Masked = DatasetMaskedCell;
type DraftCell = string | Masked;
interface DraftRow { disabled: boolean; cells: Record<string, DraftCell> }
interface DraftColumn { name: string; sensitive: boolean }
interface Draft {
  id?: string;
  name: string;
  description: string;
  columns: DraftColumn[];
  rows: DraftRow[];
}

const emptyDraft: Draft = { name: '', description: '', columns: [{ name: 'col1', sensitive: false }], rows: [{ disabled: false, cells: {} }] };

const isMasked = (v: DraftCell): v is Masked => typeof v === 'object' && v !== null && (v as Masked).__masked === true;

export default function DatasetsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const { data: list, isLoading } = useQuery({
    queryKey: ['datasets', projectId],
    queryFn: () => api.datasets.list(projectId!),
    enabled: !!projectId,
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DatasetSummary | null>(null);
  const [tsvOpen, setTsvOpen] = useState(false);
  const [tsvText, setTsvText] = useState('');

  const loadDetail = useMutation({
    mutationFn: (id: string) => api.datasets.get(projectId!, id),
    onSuccess: (d) => {
      setDraft({
        id: d.id,
        name: d.name,
        description: d.description ?? '',
        columns: d.columns.map((c) => ({ name: c.name, sensitive: c.sensitive })),
        rows: d.rows.map((r) => ({ disabled: r.disabled, cells: { ...r.cells } })),
      });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const body: DatasetSaveBody = {
        name: d.name,
        description: d.description.trim() || null,
        columns: d.columns.map((c) => ({ name: c.name, sensitive: c.sensitive })),
        rows: d.rows.map((r) => ({ disabled: r.disabled, cells: { ...r.cells } })),
      };
      return d.id ? api.datasets.update(projectId!, d.id, body) : api.datasets.create(projectId!, body);
    },
    onSuccess: () => {
      toast('已保存', 'success');
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['datasets', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: async (target: DatasetSummary) => api.datasets.remove(projectId!, target.id, { confirm: true }),
    onSuccess: (_r, target) => {
      toast(`已删除数据集（${target.name}）`, 'success');
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ['datasets', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // ---- 编辑器操作（全部是本地 draft 变更，保存时一次性 PUT） ----
  const mutate = (fn: (d: Draft) => Draft) => setDraft((prev) => (prev ? fn(prev) : prev));

  const renameColumn = (i: number, name: string) => mutate((d) => {
    const old = d.columns[i]!.name;
    const columns = [...d.columns];
    columns[i] = { ...columns[i]!, name };
    const rows = d.rows.map((r) => {
      if (!(old in r.cells)) return r;
      const { [old]: v, ...rest } = r.cells;
      return { ...r, cells: { ...rest, [name]: v } };
    });
    return { ...d, columns, rows };
  });

  const toggleSensitive = (i: number) => mutate((d) => {
    // 敏感↔非敏感切换时清掉占位符（语义交给服务端 prev 规则处理不了本地 draft 的中间态）
    const col = d.columns[i]!;
    const columns = [...d.columns];
    columns[i] = { ...col, sensitive: !col.sensitive };
    const rows = d.rows.map((r) => {
      if (!(col.name in r.cells)) return r;
      return { ...r, cells: { ...r.cells, [col.name]: '' } };
    });
    return { ...d, columns, rows };
  });

  const removeColumn = (i: number) => mutate((d) => {
    const col = d.columns[i]!;
    return {
      ...d,
      columns: d.columns.filter((_, j) => j !== i),
      rows: d.rows.map((r) => {
        const { [col.name]: _v, ...rest } = r.cells;
        return { ...r, cells: rest };
      }),
    };
  });

  const addColumn = () => mutate((d) => {
    let n = d.columns.length + 1;
    while (d.columns.some((c) => c.name === `col${n}`)) n++;
    return { ...d, columns: [...d.columns, { name: `col${n}`, sensitive: false }] };
  });

  const addRow = () => mutate((d) => ({ ...d, rows: [...d.rows, { disabled: false, cells: {} }] }));
  const removeRow = (i: number) => mutate((d) => ({ ...d, rows: d.rows.filter((_, j) => j !== i) }));
  const setCell = (ri: number, colName: string, value: DraftCell) => mutate((d) => {
    const rows = [...d.rows];
    rows[ri] = { ...rows[ri]!, cells: { ...rows[ri]!.cells, [colName]: value } };
    return { ...d, rows };
  });

  /** TSV 粘贴：首行是表头（列名），其余为数据行；已有同名列复用，新列按非敏感创建。 */
  const applyTsv = () => {
    const lines = tsvText.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) {
      toast('至少需要表头 + 1 行数据', 'error');
      return;
    }
    const headers = lines[0]!.split('\t').map((h) => h.trim());
    mutate((d) => {
      const columns = [...d.columns];
      for (const h of headers) {
        if (h && !columns.some((c) => c.name === h)) columns.push({ name: h, sensitive: false });
      }
      const rows = [...d.rows];
      for (const line of lines.slice(1)) {
        const cells: Record<string, DraftCell> = {};
        line.split('\t').forEach((v, i) => {
          if (headers[i]) cells[headers[i]!] = v;
        });
        rows.push({ disabled: false, cells });
      }
      return { ...d, columns, rows };
    });
    setTsvOpen(false);
    setTsvText('');
    toast(`已导入 ${lines.length - 1} 行`, 'success');
  };

  const saveBlocked = useMemo(() => {
    if (!draft) return true;
    if (!draft.name.trim()) return true;
    const names = draft.columns.map((c) => c.name.trim());
    return names.some((n) => !n) || new Set(names).size !== names.length;
  }, [draft]);

  if (!projectId) return null;

  // ---- 列表视图 ----
  if (!draft) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
            <Icon name="chevronLeft" size={12} />
            项目列表
          </Button>
          <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
          <h1 className="text-[16px] font-semibold" style={{ color: 'var(--foreground)' }}>数据集</h1>
          <div className="flex-1" />
          <Button onClick={() => setDraft({ ...emptyDraft, rows: [{ disabled: false, cells: {} }] })}>
            <Icon name="plus" size={12} />
            新建数据集
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          <div className="bg-card border rounded-[var(--radius-md)] overflow-hidden">
            {isLoading ? (
              <div className="flex items-center justify-center py-10" style={{ color: 'var(--muted-foreground)' }}>
                <Icon name="loader" size={16} className="animate-spin" />
              </div>
            ) : (list ?? []).length === 0 ? (
              <EmptyState
                icon="table"
                title="暂无数据集"
                description="新建数据集后，在用例执行设置里绑定即可实现数据驱动回放（N 行 = N 次回放）。"
              />
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="hairline-bottom" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>
                    <th className="text-left font-medium px-4 py-2">名称</th>
                    <th className="text-left font-medium px-4 py-2">列</th>
                    <th className="text-left font-medium px-4 py-2">行（启用/总数）</th>
                    <th className="text-left font-medium px-4 py-2">更新时间</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {(list ?? []).map((d) => (
                    <tr key={d.id} className="hairline-bottom">
                      <td className="px-4 py-2.5" style={{ color: 'var(--foreground)' }}>
                        <button className="press text-left" onClick={() => loadDetail.mutate(d.id)}>{d.name}</button>
                      </td>
                      <td className="px-4 py-2.5 font-mono" style={{ color: 'var(--muted-foreground)' }}>
                        {d.columns.map((c) => c.name + (c.sensitive ? '🔒' : '')).join(', ')}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted-foreground)' }}>
                        {d.enabledRowCount}/{d.rowCount}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted-foreground)' }}>{fullDateTime(d.updatedAt)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Button variant="ghost" size="sm" tone="destructive" onClick={() => setConfirmDelete(d)}>
                          <Icon name="trash" size={12} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent style={{ maxWidth: 420 }}>
            <DialogHeader><DialogTitle>删除数据集</DialogTitle></DialogHeader>
            <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
              确认删除「{confirmDelete?.name}」？{confirmDelete ? `${confirmDelete.enabledRowCount} 个启用行将一并删除` : ''}
              ，绑定该数据集的用例将自动解绑（回放退回单次执行）。
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>取消</Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => confirmDelete && remove.mutate(confirmDelete)}>
                {remove.isPending ? '删除中...' : '确认删除'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ---- 编辑器视图 ----
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
          <Icon name="chevronLeft" size={12} />
          返回列表
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold" style={{ color: 'var(--foreground)' }}>
          {draft.id ? '编辑数据集' : '新建数据集'}
        </h1>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setTsvOpen(true)}>
          <Icon name="upload" size={12} />
          从 Excel 粘贴
        </Button>
        <Button onClick={() => save.mutate(draft)} disabled={saveBlocked || save.isPending}>
          {save.isPending ? '保存中...' : '保存'}
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-6">
        <div className="flex flex-col gap-4 max-w-[960px]">
          <div className="flex gap-3">
            <Input label="名称" value={draft.name} onChange={(e) => mutate((d) => ({ ...d, name: e.target.value }))} className="flex-1" />
            <Input label="描述（可选）" value={draft.description} onChange={(e) => mutate((d) => ({ ...d, description: e.target.value }))} className="flex-1" />
          </div>
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            列名即回放变量名（{'{{列名}}'}），须字母/下划线开头。敏感列加密存储，报告与详情中显示为掩码。禁用行回放时跳过。
          </p>

          <div className="bg-card border rounded-[var(--radius-md)] overflow-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ background: 'var(--muted)' }}>
                  <th className="px-3 py-2 w-[70px]">
                    <span className="text-[10px] font-medium" style={{ color: 'var(--muted-foreground)' }}>禁用</span>
                  </th>
                  <th className="px-2 py-2 w-[36px]">
                    <span className="text-[10px] font-medium" style={{ color: 'var(--muted-foreground)' }}>#</span>
                  </th>
                  {draft.columns.map((c, ci) => (
                    <th key={ci} className="px-2 py-2 min-w-[160px]">
                      <div className="flex items-center gap-1">
                        <input
                          className="input-base input-sm font-mono"
                          value={c.name}
                          onChange={(e) => renameColumn(ci, e.target.value)}
                        />
                        <label className="flex items-center gap-0.5 text-[10px] cursor-pointer shrink-0" style={{ color: 'var(--muted-foreground)' }} title="敏感列加密存储">
                          <input
                            type="checkbox"
                            checked={c.sensitive}
                            onChange={() => toggleSensitive(ci)}
                            style={{ accentColor: 'var(--primary)' }}
                          />
                          敏感
                        </label>
                        <button
                          className="press shrink-0"
                          title="删除该列"
                          onClick={() => removeColumn(ci)}
                          disabled={draft.columns.length <= 1}
                          style={{ color: 'var(--destructive)' }}
                        >
                          <Icon name="close" size={10} />
                        </button>
                      </div>
                    </th>
                  ))}
                  <th className="px-2 py-2 w-[40px]">
                    <button className="press" title="加列" onClick={addColumn} style={{ color: 'var(--primary)' }}>
                      <Icon name="plus" size={12} />
                    </button>
                  </th>
                  <th className="px-2 py-2 w-[36px]" />
                </tr>
              </thead>
              <tbody>
                {draft.rows.map((row, ri) => (
                  <tr key={ri} className="hairline-bottom">
                    <td className="px-3 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={row.disabled}
                        onChange={(e) => mutate((d) => {
                          const rows = [...d.rows];
                          rows[ri] = { ...rows[ri]!, disabled: e.target.checked };
                          return { ...d, rows };
                        })}
                        title="禁用后回放跳过该行"
                        style={{ accentColor: 'var(--warning)' }}
                      />
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{ri + 1}</td>
                    {draft.columns.map((c) => {
                      const cell = row.cells[c.name];
                      return (
                        <td key={c.name} className="px-2 py-1.5">
                          {c.sensitive ? (
                            <input
                              type="password"
                              className="input-base input-sm w-full font-mono"
                              value={isMasked(cell) ? '' : (cell ?? '')}
                              placeholder={isMasked(cell) ? '••••••（未修改）' : ''}
                              onChange={(e) => setCell(ri, c.name, e.target.value)}
                              autoComplete="new-password"
                            />
                          ) : (
                            <input
                              type="text"
                              className="input-base input-sm w-full font-mono"
                              value={cell ?? ''}
                              onChange={(e) => setCell(ri, c.name, e.target.value)}
                            />
                          )}
                        </td>
                      );
                    })}
                    <td />
                    <td className="px-2 py-1.5 text-center">
                      <button className="press" title="删除该行" onClick={() => removeRow(ri)} style={{ color: 'var(--destructive)' }}>
                        <Icon name="close" size={10} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 py-2">
              <Button variant="ghost" size="sm" onClick={addRow}>
                <Icon name="plus" size={12} />
                加行
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={tsvOpen} onOpenChange={setTsvOpen}>
        <DialogContent style={{ maxWidth: 560 }}>
          <DialogHeader><DialogTitle>从 Excel 粘贴（TSV）</DialogTitle></DialogHeader>
          <p className="text-[12px] mb-2" style={{ color: 'var(--muted-foreground)' }}>
            在 Excel/表格里复制区域后粘贴到这里：首行是列名，其余每行一条数据。同名列自动复用，新列默认非敏感。
          </p>
          <textarea
            className="input-base input-sm w-full"
            rows={8}
            style={{ fontFamily: 'monospace' }}
            placeholder={'username\tpassword\nalice\tpw1'}
            value={tsvText}
            onChange={(e) => setTsvText(e.target.value)}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setTsvOpen(false)}>取消</Button>
            <Button size="sm" onClick={applyTsv}>导入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

注意：
- `Button` 组件若无 `tone="destructive"` prop，去掉该 prop（保留图标语义即可），以组件实际 props 为准。
- `Input` 的 `label` prop 已有（CaseDetail 在用）；`input-base input-sm` class 是全局样式。

- [ ] **Step 2: 类型检查 + 构建**

Run: `pnpm -C apps/web exec tsc --noEmit`
Expected: 无错误。

Run: `pnpm -C apps/web build`
Expected: 构建成功。

- [ ] **Step 3: 浏览器手动验证编辑器**

启动 dev（web 5173 / api 54321 已在跑则直接用）：登录 admin/admin123 → 项目列表行点「数据集」→ 新建（2 列其中 1 敏感，2 行）→ 保存 → 重新打开编辑器确认敏感格显示「••••••（未修改）」且不改直接保存不丢值（改密码 → 保存 → 再开仍掩码）。删除走两步确认。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/DatasetsPage.tsx
git commit -m "feat(web): 数据集管理页（表格编辑/敏感列密码框/TSV 粘贴导入）"
```

---

### Task 10: CaseDetail 绑定 + 变量来源合并 + 执行跳转

**Files:**
- Modify: `apps/web/src/pages/CaseDetail.tsx`
- Modify: `apps/web/src/components/step-form/FillValueEditor.tsx`

- [ ] **Step 1: CaseDetail 状态与同步**

`apps/web/src/pages/CaseDetail.tsx`：

1. `const [defaultEnvId, setDefaultEnvId] = useState<string | null>(null);`（72 行）之后加：

```ts
  const [datasetId, setDatasetId] = useState<string | null>(null);
```

2. 运行设置同步 effect（213-230 行）：`serverKey` 数组末尾加 `caseDetail.datasetId ?? null,`；`localKey` 数组末尾加 `datasetId,`；`setDefaultEnvId(...)` 之后加 `setDatasetId(caseDetail.datasetId ?? null);`；依赖数组加 `datasetId`。

3. `saveRuntime`（524-541 行）patch body 里 `defaultEnvId,` 之后加 `datasetId,`。

- [ ] **Step 2: datasets 查询 + 执行设置 UI**

1. environments useQuery（260-264 行）之后加：

```ts
  const { data: datasetList } = useQuery({
    queryKey: ['datasets', projectId],
    queryFn: () => api.datasets.list(projectId!),
    enabled: !!projectId,
  });
```

2. 执行设置卡片里「默认环境」label 块（669-684 行）之后加：

```tsx
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>测试数据集</span>
                    <select
                      className="input-base input-sm"
                      value={datasetId ?? ''}
                      onChange={(e) => setDatasetId(e.target.value || null)}
                    >
                      <option value="">不绑定（单次回放）</option>
                      {(datasetList ?? []).map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}（{d.enabledRowCount} 启用行）
                        </option>
                      ))}
                    </select>
                    {datasetId && (
                      <span className="text-[10px]" style={{ color: 'var(--info)' }}>
                        回放将按启用行数逐行执行，每行产生一条独立报告；步骤中用 {'{{列名}}'} 引用数据。
                      </span>
                    )}
                  </label>
```

（此块放在「保存」按钮之前，与默认环境同卡片；保存按钮仍走 saveRuntime。）

- [ ] **Step 3: 执行跳转（多行 → 报告列表）**

`execute` mutation（452-460 行）onSuccess 改为：

```ts
    onSuccess: (r) => {
      toast('执行完成', 'success');
      qc.invalidateQueries({ queryKey: ['reports'] });
      if (r.reportIds && r.reportIds.length > 1) {
        navigate(`/p/${projectId}/v/${versionId}/reports`);
      } else {
        navigate(`/p/${projectId}/v/${versionId}/reports/${r.reportId}`);
      }
    },
```

- [ ] **Step 4: 变量来源合并（availableVars）**

CaseDetail 顶部（`toClip` 定义之前）加 memo：

```ts
  /** 数据集列名（绑定的数据集）—— 与前置 extract 变量合并供 FillValueEditor 选择。 */
  const datasetVars = useMemo(() => {
    const ds = (datasetList ?? []).find((d) => d.id === datasetId);
    return ds ? ds.columns.map((c) => c.name) : [];
  }, [datasetList, datasetId]);
```

StepEditDrawer 调用处（1250-1293 行）`availableVars={...}` 的内联数组（1254-1261 行那个 map/filter 表达式）改为先抽 const 再合并——在 return 之前加：

```ts
  const extractVars = caseDetail.steps
    .map((s) => {
      const head = Array.isArray(s.compiled) && s.compiled.length > 0
        ? (s.compiled[0] as { kind?: string; varName?: string })
        : undefined;
      return head?.kind === 'extract' ? head.varName : undefined;
    })
    .filter((v): v is string => !!v);
```

`availableVars=` 传：

```tsx
          availableVars={[...datasetVars, ...extractVars]}
          datasetVars={datasetVars}
```

- [ ] **Step 5: FillValueEditor 标注来源**

`apps/web/src/components/step-form/FillValueEditor.tsx`：组件 props 加可选 `datasetVars?: string[];`（默认 `[]`），在输入框（datalist）下方渲染一行来源标注：

```tsx
      {(datasetVars?.length ?? 0) + (availableVars.length - (datasetVars?.length ?? 0)) > 0 && (
        <div className="text-[10px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
          {datasetVars && datasetVars.length > 0 && <span>数据集列：{datasetVars.map((v) => `{{${v}}}`).join('、')}　</span>}
          {availableVars.filter((v) => !(datasetVars ?? []).includes(v)).length > 0 && (
            <span>前置 extract：{availableVars.filter((v) => !(datasetVars ?? []).includes(v)).map((v) => `{{${v}}}`).join('、')}</span>
          )}
        </div>
      )}
```

（按该组件实际 JSX 结构把这段插到 datalist input 的紧下方；不改变现有 datalist 值 `{{var}}` 的插入行为。）

- [ ] **Step 6: 类型检查 + 浏览器验证**

Run: `pnpm -C apps/web exec tsc --noEmit`
Expected: 无错误。

浏览器：用例详情 → 执行设置出现「测试数据集」下拉（含行数提示）→ 绑定 → 保存 → 刷新后仍选中；打开某 fill 步骤编辑器，变量提示区出现「数据集列」标注；解绑 → 保存 → 提示消失。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/CaseDetail.tsx apps/web/src/components/step-form/FillValueEditor.tsx
git commit -m "feat(web): 用例绑定数据集下拉 + 变量来源标注 + 多行执行跳报告列表"
```

---

### Task 11: 报告与计划运行展示

**Files:**
- Modify: `apps/web/src/pages/ReportDetail.tsx`
- Modify: `apps/web/src/pages/PlanRunDetail.tsx`

- [ ] **Step 1: ReportDetail 数据行展示**

`apps/web/src/pages/ReportDetail.tsx`：

1. 右栏「元数据」卡片（340-350 行）`报告 ID` MetaRow 之后加：

```tsx
              {data.datasetRowIndex != null && data.datasetSnapshot && (
                <MetaRow label="数据行" value={`${data.datasetSnapshot.rowIndex + 1}/${data.datasetSnapshot.totalRows}`} />
              )}
```

2. 「元数据」卡片 div 之后追加新卡片：

```tsx
            {data.datasetSnapshot && (
              <div className="bg-card border rounded-[var(--radius-md)] p-4">
                <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                  当次数据行
                </div>
                {Object.entries(data.datasetSnapshot.values).map(([k, v]) => (
                  <MetaRow key={k} label={k} value={<span className="font-mono text-[11px]">{v}</span>} />
                ))}
              </div>
            )}
```

- [ ] **Step 2: PlanRunDetail 行通过率 + 每行报告**

`apps/web/src/pages/PlanRunDetail.tsx`：

1. 用例行 caseTitle 区（72-77 行）`{c.durationMs ?? 0} ms</span>` 之后加：

```tsx
                      {(c.reportIds?.length ?? 0) > 1 && (
                        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                          {(c.rowStatuses ?? []).filter((s) => s === 'passed').length}/{c.reportIds!.length} 行通过
                        </span>
                      )}
```

2. 「报告」按钮块（80-84 行）替换为：

```tsx
                  {(c.reportIds?.length ?? 0) > 1 ? (
                    <div className="flex items-center gap-1 shrink-0">
                      {(c.reportIds ?? []).map((rid, i) => {
                        const st = c.rowStatuses?.[i];
                        return (
                          <Button
                            key={rid}
                            variant="ghost"
                            size="sm"
                            title={st ?? undefined}
                            onClick={() => navigate(`/p/${projectId}/v/${versionId}/reports/${rid}`)}
                          >
                            行{i + 1} {st === 'passed' ? '✓' : st === 'failed' ? '✕' : '·'}
                          </Button>
                        );
                      })}
                    </div>
                  ) : (
                    c.reportId && (
                      <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/v/${versionId}/reports/${c.reportId}`)}>
                        报告
                      </Button>
                    )
                  )}
```

- [ ] **Step 3: 类型检查**

Run: `pnpm -C apps/web exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/ReportDetail.tsx apps/web/src/pages/PlanRunDetail.tsx
git commit -m "feat(web): 报告展示数据行快照 + 计划运行行通过率与分行报告入口"
```

---

### Task 12: 全量回归 + 手动 E2E

**Files:** 无新文件（验证任务）

- [ ] **Step 1: API 全量测试**

Run: `pnpm -C apps/api exec vitest run`
Expected: 全部 PASS（含既有测试——未绑定数据集路径零行为变化的回归由此保证）。

- [ ] **Step 2: Web 构建**

Run: `pnpm -C apps/web exec tsc --noEmit && pnpm -C apps/web build`
Expected: 均成功。

- [ ] **Step 3: 手动 E2E（spec §6）**

前置：dev api（54321，带 ENCRYPTION_KEY 与 CHROMIUM_PATH）、web（5173）、目标系统可达。

1. 项目 → 数据集 → 新建「登录账号」：列 `username`（非敏感）、`password`（敏感）；行 1 正确账号、行 2 错误密码。
2. 登录用例步骤中 fill 值写 `{{username}}` / `{{password}}`；执行设置绑定该数据集 → 保存。
3. 用例页点「执行」→ 跳报告列表，出现 2 条报告。
4. 行 1 报告：passed；元数据「数据行 1/2」；「当次数据行」中 password 显示 `******`。
5. 行 2 报告：failed（断言/登录失败）；同样脱敏；stepResults 错误文本里不出现明文密码。
6. 把行 2 勾「禁用」→ 保存 → 再执行 → 只 1 条报告（禁用行跳过）。
7. 建计划（含该用例 + 1 个普通用例）→ 运行 → PlanRunDetail 绑定用例显示「1/2 行通过」与「行1 ✓ 行2 ✕」按钮；普通用例显示单个「报告」。
8. 数据集页删除该数据集 → 确认弹窗提示解绑 → 用例执行设置回落「不绑定」→ 执行 → 单条报告（回归）。

- [ ] **Step 4: 最终 Commit（如有 E2E 中的小修）**

```bash
git add -A
git commit -m "fix: 数据集 E2E 修复收尾"
```

（无修改则跳过。）

---

## Self-Review 记录

- **Spec 覆盖**：§2 数据模型→Task 1；§3 API→Task 2/3/4；§4.1 单用例迭代→Task 6；§4.2 执行器→Task 5；§4.3 计划→Task 7；§4.4 敏感边界→Task 2/5/6（快照打码 + 解密仅在内存 + 错误打码）；§5.1 管理页→Task 8/9；§5.2 用例侧→Task 10；§5.3 报告侧→Task 11；§6 测试→Task 2/5/6/7/12；§7 迁移→Task 1。
- **类型一致性**：`DatasetConfigError`/`loadDatasetForRun`/`DatasetRowExec`（service 定义，runCase/execute 引用）；`maskSensitiveValues`（cdp 导出，单测引用）；`reportIds`（runCase 返回 → execute 响应 → runPlan 写入 → planRuns rowStatuses → client.ts → 两个页面）；`__masked` 占位（service DATASET_MASKED_CELL ↔ web DatasetMaskedCell）。
- **已知偏差（对 spec 的实现细化）**：EncCell 用 `{c,i,t}`（代码库 AES 三元组惯例，语义同 spec 的 `{c,iv,tag}`）；执行器参数经 ExecContext 携带而非 runStepsInContext 新参（更小 diff，语义相同）；__masked 沿用旧密文按行索引对齐（前端语义：未改动的格原样回传）。
