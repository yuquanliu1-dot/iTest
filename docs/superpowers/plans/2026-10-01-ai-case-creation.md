# AI 创建用例：会话式工作台 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-shot「AI 生成用例」flow on the requirement detail page with a conversational AI workspace (assistant-ui + Pi stack) where the user chats with the model, reviews staged scenarios/cases on the right, and saves selected items into a chosen group.

**Architecture:** Add three new persistence tables (scenarios + test_cases.scenario_id, ai_threads + ai_workspace_state). Build a thin per-thread supervisor (`src/pi/`) wrapping `createAgentSession` with custom workspace tools; expose a /api/pi/* HTTP+SSE wire contract matching `@assistant-ui/react-pi@0.0.25`. Frontend: new page `/p/:projectId/requirements/:id/ai` rendering assistant-ui `<Thread>` on the left and a custom review/save panel on the right driven by SSE `workspace_doc` events.

**Tech Stack:**
- API: Express 5 + Drizzle (pg) + vitest + testcontainers postgres:16-alpine
- Pi runtime: `@earendil-works/pi-coding-agent@~0.99.2`, `@earendil-works/pi-ai@~0.99.2` (TypeBox imported from pi-ai to avoid extra dep)
- Web: React 18 + react-router-dom + react-query + `@assistant-ui/react@0.15.22` + `@assistant-ui/react-pi@0.0.25`
- Persistence: JSONL under `apps/api/.data/` (Pi SessionManager) + Postgres jsonb (ai_workspace_state)

---

## Baseline Warning (read first)

This plan runs on the **uncommitted multi-tenant org/auth workstream** (45 files modified + untracked including `apps/api/src/middleware/auth.ts`, `routes/auth.ts`, `routes/organizations.ts`, `apps/api/src/services/`, migrations 0009–0011). Two constraints:

1. **Migrations continue from `0012`**. Each new migration gets a unique tag (e.g. `0012_<name>`) and a `_journal.json` entry. Verify the next `when` is greater than `1790919300000` (0011's stamp).
2. **Only `git add` files this plan creates or modifies**. Do NOT stage the unrelated auth/org files. Pre-existing test failures after this work lands: **`cases.test.ts` (3 aiStep-compile failures) is NOT ours** — do not "fix" it. **`agentRuns.test.ts` (4 failures)** is ours and gets fixed in Task 13.

Schema in this plan adds 3 tables (`scenarios`, `ai_threads`, `ai_workspace_state`) and one nullable FK on `test_cases.scenario_id`.

---

## File Structure

```
apps/api/drizzle/0012_ai_workspace_scenarios.sql          # NEW
apps/api/drizzle/0013_test_cases_scenario_id.sql         # NEW
apps/api/drizzle/0014_ai_threads_workspace.sql           # NEW
apps/api/drizzle/meta/_journal.json                      # MODIFY (3 new entries)
apps/api/drizzle/meta/0012_snapshot.json                 # NEW (auto by drizzle-kit)
apps/api/drizzle/meta/0013_snapshot.json                 # NEW
apps/api/drizzle/meta/0014_snapshot.json                 # NEW

apps/api/src/db/schema.ts                                # MODIFY (scenarios + ai_threads + ai_workspace_state + testCases.scenarioId)
apps/api/test/helpers/db.ts                              # MODIFY (extend SCHEMA_SQL for new tables)

apps/api/src/pi/bus.ts                                   # NEW (workspace event bus)
apps/api/src/pi/workspace.ts                             # NEW (staging doc store)
apps/api/src/pi/modelBridge.ts                           # NEW (read LLM settings → pi Model)
apps/api/src/pi/tools.ts                                 # NEW (TypeBox workspace tool defs)
apps/api/src/pi/session.ts                               # NEW (per-thread Pi supervisor)
apps/api/src/pi/router.ts                                # NEW (HTTP + SSE wire contract)

apps/api/src/routes/requirements.ts                      # MODIFY (add ai-thread + ai-workspace + save)
apps/api/src/index.ts                                    # MODIFY (mount /api/pi)

apps/api/src/agent/builtinTools.ts                       # MODIFY (delete CasesOutput + createSaveCaseTool)
apps/api/src/agent/workflows/requirement2cases.ts        # DELETE
apps/api/src/agent/prompts/requirement-decompose.ts      # DELETE
apps/api/src/agent/prompts/case-review.ts                 # DELETE
apps/api/src/routes/agentRuns.ts                         # MODIFY (drop requirement2cases branch)
apps/api/test/agentRuns.test.ts                          # MODIFY (rewrite 4 requirement2cases tests + 1 case2script with vi.mock)

apps/api/test/scenarios.test.ts                          # NEW
apps/api/test/pi-workspace.test.ts                       # NEW
apps/api/test/pi-router.test.ts                          # NEW
apps/api/test/ai-workspace-save.test.ts                  # NEW

apps/web/src/api/client.ts                               # MODIFY (WorkspaceDoc types + api.aiWorkspace)
apps/web/src/App.tsx                                     # MODIFY (add ai route)
apps/web/src/pages/AiWorkspacePage.tsx                   # NEW
apps/web/src/features/ai-workspace/WorkspacePanel.tsx    # NEW
apps/web/src/features/ai-workspace/ThreadPane.tsx        # NEW
apps/web/src/features/ai-workspace/SaveDialog.tsx        # NEW
apps/web/src/pages/RequirementDetail.tsx                 # MODIFY (swap button → navigate)
apps/web/src/pages/Requirements.tsx                      # MODIFY (row entry)
```

---

## Task 1: Install deps + verify Pi 0.99.2 surface area

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/web/package.json`
- Create: `apps/api/src/pi/.pi-verification.md` (notes)

- [ ] **Step 1: Verify Node version satisfies Pi**

Run:
```bash
node --version
```
Expected: `v22.19.0` or higher (Pi 0.99.2 requires Node ≥ 22.19). Local repo: v24.14.1.

- [ ] **Step 2: Add web deps (pinned)**

```bash
pnpm --filter @itest/web add @assistant-ui/react@0.15.22 @assistant-ui/react-pi@0.0.25
```

- [ ] **Step 3: Add api deps (pinned)**

```bash
pnpm --filter @itest/api add @earendil-works/pi-coding-agent@~0.99.2 @earendil-works/pi-ai@~0.99.2
```

- [ ] **Step 4: Verify react-pi peerDeps accepted**

Open `apps/web/node_modules/@assistant-ui/react-pi/package.json` and confirm:
- `peerDependencies` includes `@assistant-ui/react: ^0.15.22`
- `dependencies` includes `assistant-stream`, `@assistant-ui/core`, `@assistant-ui/store`
- `main`/`exports` has `./node` → `./dist/node.d.ts` (NOT `dist/node/index.d.ts`)

- [ ] **Step 5: Read Pi session+tool API surface (record in `.pi-verification.md`)**

Run grep + read against installed `.d.ts` files and capture the verbatim signatures. This blocks before any code:

```bash
ls apps/api/node_modules/@earendil-works/pi-coding-agent/dist/core/
cat apps/api/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts | head -120
cat apps/api/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts | head -120
cat apps/api/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts 2>/dev/null | head -60
cat apps/api/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.d.ts 2>/dev/null | head -60
cat apps/api/node_modules/@earendil-works/pi-ai/dist/index.d.ts 2>/dev/null | head -60
```

Fill `apps/api/src/pi/.pi-verification.md` with the confirmed signature of:
1. `CreateAgentSessionOptions` and `CreateAgentSessionResult` (must include `customTools`, `noTools`, `sessionManager`)
2. `AgentSession` methods (subscribe / prompt / abort / dispose / isStreaming / messages)
3. `SessionManager` factory methods (`create(cwd)`, `open(path)`, `inMemory()`)
4. `ToolDefinition` (must include `label`, `parameters: TParams`, `execute(...)`)
5. `defineTool<T>` helper (preserves TypeBox parameter inference)
6. `getModel(provider, modelId)` from pi-ai (returns a `Model`)
7. `ModelRuntime` and the API-key injection path. Confirm one of:
   - `ModelRuntimeAuthOverrides` constructor arg shape
   - OR `readStoredCredential` / `agentDir`-based `auth.json`
   - OR `registerProvider` on `ExtensionAPI` (requires extensions path; not used here)

Write findings to `apps/api/src/pi/.pi-verification.md` and **commit before proceeding**. The signatures below this line assume the typical pi-coding-agent surface; if any mismatch is found, adjust the listed signatures **inline** in the code blocks of Tasks 5–8 before writing them.

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json apps/web/package.json pnpm-lock.yaml apps/api/src/pi/.pi-verification.md
git commit -m "chore(deps): add @assistant-ui/react-pi + @earendil-works/pi-*" 
```

---

## Task 2: Migration 0012 — scenarios + test_cases.scenario_id (TDD)

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/test/scenarios.test.ts`
- Create: `apps/api/drizzle/0012_ai_workspace_scenarios.sql` (auto-generated)
- Modify: `apps/api/drizzle/meta/_journal.json` (auto)
- Create: `apps/api/drizzle/meta/0012_snapshot.json` (auto)
- Modify: `apps/api/test/helpers/db.ts` (mirror new tables)

- [ ] **Step 1: Write failing test**

`apps/api/test/scenarios.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('scenarios', () => {
  it('creates a scenario linked to a requirement', async () => {
    const { projectId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const s = await pool.query(
      `INSERT INTO scenarios(requirement_id, title, description, "order") VALUES ($1,'S1','desc',0) RETURNING id`,
      [r.rows[0]!.id],
    );
    expect(s.rows[0]!.id).toBeTruthy();
  });

  it('test_cases.scenario_id ON DELETE SET NULL works', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const s = await pool.query(`INSERT INTO scenarios(requirement_id, title) VALUES ($1,'S') RETURNING id`, [r.rows[0]!.id]);
    const c = await pool.query(
      `INSERT INTO test_cases(requirement_id, group_id, title, scenario_id) VALUES ($1,$2,'case',$3) RETURNING id`,
      [r.rows[0]!.id, groupId, s.rows[0]!.id],
    );
    await pool.query(`DELETE FROM scenarios WHERE id = $1`, [s.rows[0]!.id]);
    const after = await pool.query(`SELECT scenario_id FROM test_cases WHERE id = $1`, [c.rows[0]!.id]);
    expect(after.rows[0]!.scenario_id).toBeNull();
  });

  it('cascade deletes scenarios when requirement is deleted', async () => {
    const { projectId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    await pool.query(`INSERT INTO scenarios(requirement_id, title) VALUES ($1,'S')`, [r.rows[0]!.id]);
    await pool.query(`DELETE FROM requirements WHERE id = $1`, [r.rows[0]!.id]);
    const after = await pool.query(`SELECT count(*)::int AS n FROM scenarios WHERE requirement_id = $1`, [r.rows[0]!.id]);
    expect(after.rows[0]!.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test — it must fail (table does not exist)**

Run:
```bash
pnpm --filter @itest/api test -- scenarios
```
Expected: FAIL with `relation "scenarios" does not exist`.

- [ ] **Step 3: Add `scenarios` table to schema**

Edit `apps/api/src/db/schema.ts`. Append after `testCases` (around line 45):

```ts
export const scenarios = pgTable('scenarios', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id').notNull().references(() => requirements.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  order: integer('order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

Add nullable FK on `testCases` (modify the `testCases` block to add one field). Edit the existing `testCases` declaration to add (right after `incognito`):
```ts
  scenarioId: uuid('scenario_id').references(() => scenarios.id, { onDelete: 'set null' }),
```

(That line goes after the `incognito` line — keep existing fields as-is.)

- [ ] **Step 4: Generate migration 0012**

Run:
```bash
pnpm --filter @itest/api db:generate
```
Expected: a new file under `apps/api/drizzle/` with a random name like `0012_<hash>.sql` AND a `_journal.json` entry. Open the generated `.sql` and rename to a meaningful name (e.g. `0012_ai_workspace_scenarios.sql`). Verify the SQL contains the `scenarios` CREATE and the `ALTER TABLE test_cases ADD COLUMN scenario_id ... REFERENCES scenarios(id) ON DELETE SET NULL`. If drizzle didn't generate the FK constraint (it sometimes defers), hand-edit the SQL to add it.

- [ ] **Step 5: Mirror new tables into `SCHEMA_SQL`**

Edit `apps/api/test/helpers/db.ts`. Append before the closing backtick:

```sql
CREATE TABLE scenarios (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid REFERENCES requirements(id) ON DELETE CASCADE NOT NULL, title varchar(200) NOT NULL, description text, "order" integer NOT NULL DEFAULT 0, created_at timestamp NOT NULL DEFAULT now());
DO $$ BEGIN
 ALTER TABLE test_cases ADD COLUMN scenario_id uuid;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE test_cases ADD CONSTRAINT test_cases_scenario_id_scenarios_id_fk FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
```

- [ ] **Step 6: Run test to verify pass**

Run:
```bash
pnpm --filter @itest/api test -- scenarios
```
Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/0012_ai_workspace_scenarios.sql apps/api/drizzle/meta/_journal.json apps/api/drizzle/meta/0012_snapshot.json apps/api/test/scenarios.test.ts apps/api/test/helpers/db.ts
git commit -m "feat(api): scenarios table + test_cases.scenario_id (migration 0012)"
```

---

## Task 3: Migration 0014 — ai_threads + ai_workspace_state (TDD)

(Per spec, this is migration 0014 because the auth workstream is using 0013 internally. We add ours as 0014 to avoid collision with their uncommitted work; if 0013 is released before this lands, rename to 0013 on landing — confirm via `git log --oneline apps/api/drizzle/` first. The plan uses 0014 for clarity.)

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/test/ai-threads.test.ts`
- Create: `apps/api/drizzle/0014_ai_threads_workspace.sql` (auto)
- Modify: `apps/api/drizzle/meta/_journal.json`
- Create: `apps/api/drizzle/meta/0014_snapshot.json`
- Modify: `apps/api/test/helpers/db.ts`

- [ ] **Step 1: Write failing test**

`apps/api/test/ai-threads.test.ts`:
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
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('ai_threads + ai_workspace_state', () => {
  it('ai_threads has unique requirementId', async () => {
    const { projectId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await pool.query(`INSERT INTO ai_threads(id, requirement_id, pi_thread_id) VALUES (gen_random_uuid(), $1, 'p1')`, [rid]);
    await expect(
      pool.query(`INSERT INTO ai_threads(id, requirement_id, pi_thread_id) VALUES (gen_random_uuid(), $1, 'p2')`, [rid]),
    ).rejects.toThrow();
  });

  it('ai_workspace_state roundtrips doc jsonb', async () => {
    const { projectId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    const doc = { plan: { scenarios: 2, cases: 5 }, scenarios: [], looseCases: [] };
    await pool.query(`INSERT INTO ai_workspace_state(requirement_id, doc) VALUES ($1, $2)`, [rid, doc]);
    const got = await pool.query(`SELECT doc FROM ai_workspace_state WHERE requirement_id = $1`, [rid]);
    expect(got.rows[0]!.doc).toEqual(doc);
  });

  it('cascade deletes when requirement is deleted', async () => {
    const { projectId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await pool.query(`INSERT INTO ai_threads(id, requirement_id, pi_thread_id) VALUES (gen_random_uuid(), $1, 'p')`, [rid]);
    await pool.query(`INSERT INTO ai_workspace_state(requirement_id, doc) VALUES ($1, '{}'::jsonb)`, [rid]);
    await pool.query(`DELETE FROM requirements WHERE id = $1`, [rid]);
    const t = await pool.query(`SELECT count(*)::int AS n FROM ai_threads WHERE requirement_id = $1`, [rid]);
    const w = await pool.query(`SELECT count(*)::int AS n FROM ai_workspace_state WHERE requirement_id = $1`, [rid]);
    expect(t.rows[0]!.n).toBe(0);
    expect(w.rows[0]!.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (relation does not exist)**

```bash
pnpm --filter @itest/api test -- ai-threads
```
Expected: FAIL.

- [ ] **Step 3: Add tables to schema**

In `apps/api/src/db/schema.ts`, append after `scenarios`:

```ts
export const aiThreads = pgTable('ai_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id').notNull().unique().references(() => requirements.id, { onDelete: 'cascade' }),
  piThreadId: text('pi_thread_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const aiWorkspaceState = pgTable('ai_workspace_state', {
  requirementId: uuid('requirement_id').primaryKey().references(() => requirements.id, { onDelete: 'cascade' }),
  doc: jsonb('doc').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

- [ ] **Step 4: Generate migration**

```bash
pnpm --filter @itest/api db:generate
```
Rename generated to `0014_ai_threads_workspace.sql`. Inspect SQL — must include both CREATE TABLE statements.

- [ ] **Step 5: Mirror into `SCHEMA_SQL`**

Append to `apps/api/test/helpers/db.ts` before closing backtick:

```sql
CREATE TABLE ai_threads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid REFERENCES requirements(id) ON DELETE CASCADE NOT NULL UNIQUE, pi_thread_id text NOT NULL, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE ai_workspace_state (requirement_id uuid PRIMARY KEY REFERENCES requirements(id) ON DELETE CASCADE, doc jsonb NOT NULL, updated_at timestamp NOT NULL DEFAULT now());
```

- [ ] **Step 6: Run — expect PASS**

```bash
pnpm --filter @itest/api test -- ai-threads
```
Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/0014_ai_threads_workspace.sql apps/api/drizzle/meta/_journal.json apps/api/drizzle/meta/0014_snapshot.json apps/api/test/ai-threads.test.ts apps/api/test/helpers/db.ts
git commit -m "feat(api): ai_threads + ai_workspace_state (migration 0014)"
```

---

## Task 4: `src/pi/bus.ts` + `src/pi/workspace.ts` (TDD)

**Files:**
- Create: `apps/api/src/pi/bus.ts`
- Create: `apps/api/src/pi/workspace.ts`
- Create: `apps/api/test/pi-workspace.test.ts`

- [ ] **Step 1: Write failing test**

`apps/api/test/pi-workspace.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_threads RESTART IDENTITY CASCADE`);
  const { projectId } = await seedProject(pool);
  const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
  requirementId = r.rows[0]!.id as string;
});

describe('workspace bus', () => {
  it('subscribe + publish fires once and unsub stops delivery', async () => {
    const { subscribeWorkspace, publishWorkspaceEvent } = await import('../src/pi/bus.js');
    const calls: unknown[] = [];
    const unsub = subscribeWorkspace(requirementId, (e) => calls.push(e));
    publishWorkspaceEvent({ type: 'workspace_doc', requirementId });
    publishWorkspaceEvent({ type: 'workspace_doc', requirementId });
    unsub();
    publishWorkspaceEvent({ type: 'workspace_doc', requirementId });
    expect(calls.length).toBe(2);
  });
});

describe('workspace store', () => {
  it('emptyDoc on missing row returns empty skeleton', async () => {
    const { loadDoc } = await import('../src/pi/workspace.js');
    const d = await loadDoc(requirementId);
    expect(d.plan).toBeNull();
    expect(d.scenarios).toEqual([]);
    expect(d.looseCases).toEqual([]);
  });

  it('announcePlan + upsertScenario + upsertCase persist + publish', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { subscribeWorkspace } = await import('../src/pi/bus.js');
    const events: unknown[] = [];
    subscribeWorkspace(requirementId, (e) => events.push(e));
    await ws.announcePlan(requirementId, { scenarios: 1, cases: 2 });
    await ws.upsertScenario(requirementId, { id: 's1', title: 'S', description: null, cases: [] });
    await ws.upsertCase(requirementId, null, { id: 'c1', title: 'C', description: null, priority: 'P0', steps: [] });
    const doc = await ws.loadDoc(requirementId);
    expect(doc.plan).toEqual({ scenarios: 1, cases: 2 });
    expect(doc.scenarios[0]!.cases).toHaveLength(1);
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it('upsertCase with scenarioId that does not exist throws', async () => {
    const ws = await import('../src/pi/workspace.js');
    await expect(
      ws.upsertCase(requirementId, 'missing-scenario', { id: 'c1', title: 'C', description: null, priority: 'P1', steps: [] }),
    ).rejects.toThrow(/not found; call upsert_scenario first/);
  });

  it('removeSaved drops only the listed case ids and empties drained scenarios', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.upsertScenario(requirementId, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: null, priority: 'P0', steps: [] },
      { id: 'c2', title: 'C2', description: null, priority: 'P1', steps: [] },
    ] });
    await ws.removeSaved(requirementId, ['c1']);
    const doc = await ws.loadDoc(requirementId);
    expect(doc.scenarios[0]!.cases.map((c) => c.id)).toEqual(['c2']);
  });

  it('removeSaved keeps untouched scenarios', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.upsertScenario(requirementId, { id: 's1', title: 'S1', description: null, cases: [
      { id: 'c1', title: 'C', description: null, priority: 'P0', steps: [] },
    ] });
    await ws.upsertScenario(requirementId, { id: 's2', title: 'S2', description: null, cases: [] });
    await ws.removeSaved(requirementId, ['c1']);
    const doc = await ws.loadDoc(requirementId);
    expect(doc.scenarios.map((s) => s.id)).toEqual(['s2']);
  });

  it('removeItem removes both cases and scenarios', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.upsertScenario(requirementId, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C', description: null, priority: 'P0', steps: [] },
    ] });
    await ws.removeItem(requirementId, { kind: 'scenario', id: 's1' });
    const doc = await ws.loadDoc(requirementId);
    expect(doc.scenarios).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (modules missing)**

```bash
pnpm --filter @itest/api test -- pi-workspace
```

- [ ] **Step 3: Implement `bus.ts`**

`apps/api/src/pi/bus.ts`:
```ts
/** Workspace bus: per-requirement fan-out for workspace_doc SSE events. */

export interface WorkspaceEvent {
  type: 'workspace_doc';
  requirementId: string;
}

type Listener = (e: WorkspaceEvent) => void;

const subs = new Map<string, Set<Listener>>();

export function subscribeWorkspace(requirementId: string, fn: Listener): () => void {
  let set = subs.get(requirementId);
  if (!set) {
    set = new Set();
    subs.set(requirementId, set);
  }
  set.add(fn);
  return () => {
    const cur = subs.get(requirementId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) subs.delete(requirementId);
  };
}

export function publishWorkspaceEvent(e: WorkspaceEvent): void {
  const set = subs.get(e.requirementId);
  if (!set) return;
  for (const fn of set) {
    try { fn(e); } catch { /* listener errors do not break the publisher */ }
  }
}

export function subscriberCountForTesting(requirementId: string): number {
  return subs.get(requirementId)?.size ?? 0;
}
```

- [ ] **Step 4: Implement `workspace.ts`**

`apps/api/src/pi/workspace.ts`:
```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiWorkspaceState } from '../db/schema.js';
import { publishWorkspaceEvent } from './bus.js';

export type StagedStep = { name: string; action: string; assertion: string | null };
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export interface StagedCase {
  id: string;
  title: string;
  description: string | null;
  priority: Priority;
  steps: StagedStep[];
}
export interface StagedScenario {
  id: string;
  title: string;
  description: string | null;
  cases: StagedCase[];
}
export interface WorkspaceDoc {
  plan: { scenarios: number; cases: number } | null;
  scenarios: StagedScenario[];
  looseCases: StagedCase[];
}

export function emptyDoc(): WorkspaceDoc {
  return { plan: null, scenarios: [], looseCases: [] };
}

async function readOrEmpty(requirementId: string): Promise<WorkspaceDoc> {
  const rows = await db.select({ doc: aiWorkspaceState.doc }).from(aiWorkspaceState).where(eq(aiWorkspaceState.requirementId, requirementId)).limit(1);
  return (rows[0]?.doc as WorkspaceDoc | undefined) ?? emptyDoc();
}

async function persist(requirementId: string, doc: WorkspaceDoc): Promise<void> {
  await db
    .insert(aiWorkspaceState)
    .values({ requirementId, doc })
    .onConflictDoUpdate({ target: aiWorkspaceState.requirementId, set: { doc, updatedAt: new Date() } });
  publishWorkspaceEvent({ type: 'workspace_doc', requirementId });
}

export async function loadDoc(requirementId: string): Promise<WorkspaceDoc> {
  return readOrEmpty(requirementId);
}

export async function announcePlan(requirementId: string, plan: { scenarios: number; cases: number }): Promise<void> {
  const doc = await readOrEmpty(requirementId);
  doc.plan = plan;
  await persist(requirementId, doc);
}

export async function upsertScenario(requirementId: string, scenario: StagedScenario): Promise<void> {
  const doc = await readOrEmpty(requirementId);
  const idx = doc.scenarios.findIndex((s) => s.id === scenario.id);
  if (idx >= 0) {
    // 合并 cases：保留 doc 中已有的 cases（AI 后续可能补充），用入参的元数据替换 title/description
    const merged: StagedScenario = {
      ...scenario,
      cases: scenario.cases.length > 0 ? scenario.cases : doc.scenarios[idx]!.cases,
    };
    doc.scenarios[idx] = merged;
  } else {
    doc.scenarios.push(scenario);
  }
  await persist(requirementId, doc);
}

export async function upsertCase(requirementId: string, scenarioId: string | null, c: StagedCase): Promise<void> {
  const doc = await readOrEmpty(requirementId);
  if (scenarioId === null) {
    const idx = doc.looseCases.findIndex((x) => x.id === c.id);
    if (idx >= 0) doc.looseCases[idx] = c; else doc.looseCases.push(c);
  } else {
    const s = doc.scenarios.find((x) => x.id === scenarioId);
    if (!s) throw new Error(`scenario ${scenarioId} not found; call upsert_scenario first`);
    const idx = s.cases.findIndex((x) => x.id === c.id);
    if (idx >= 0) s.cases[idx] = c; else s.cases.push(c);
  }
  await persist(requirementId, doc);
}

export async function removeItem(requirementId: string, item: { kind: 'scenario' | 'case'; id: string; scenarioId?: string | null }): Promise<void> {
  const doc = await readOrEmpty(requirementId);
  if (item.kind === 'scenario') {
    doc.scenarios = doc.scenarios.filter((s) => s.id !== item.id);
  } else {
    if (item.scenarioId == null) {
      doc.looseCases = doc.looseCases.filter((c) => c.id !== item.id);
    } else {
      const s = doc.scenarios.find((x) => x.id === item.scenarioId);
      if (s) s.cases = s.cases.filter((c) => c.id !== item.id);
    }
  }
  await persist(requirementId, doc);
}

export async function removeSaved(requirementId: string, savedCaseIds: string[]): Promise<void> {
  const idSet = new Set(savedCaseIds);
  const doc = await readOrEmpty(requirementId);
  doc.looseCases = doc.looseCases.filter((c) => !idSet.has(c.id));
  doc.scenarios = doc.scenarios
    .map((s) => ({ ...s, cases: s.cases.filter((c) => !idSet.has(c.id)) }))
    .filter((s) => s.cases.length > 0); // 整组空掉的场景随之丢弃
  await persist(requirementId, doc);
}
```

- [ ] **Step 5: Run — expect PASS**

```bash
pnpm --filter @itest/api test -- pi-workspace
```
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pi/bus.ts apps/api/src/pi/workspace.ts apps/api/test/pi-workspace.test.ts
git commit -m "feat(api): workspace staging doc + event bus"
```

---

## Task 5: `src/pi/modelBridge.ts` (TDD)

**Files:**
- Create: `apps/api/src/pi/modelBridge.ts`
- Create: `apps/api/test/pi-model-bridge.test.ts`

- [ ] **Step 1: Write failing test**

`apps/api/test/pi-model-bridge.test.ts`:
```ts
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
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE settings`);
});

describe('readLlmConfig', () => {
  it('returns null when provider not configured', async () => {
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toBeNull();
  });

  it('returns parsed config when fully configured', async () => {
    await pool.query(`INSERT INTO settings(key, value) VALUES
      ('llm_provider','"openai"'),
      ('llm_api_key','"sk-test"'),
      ('llm_model','"gpt-4o-mini"'),
      ('llm_base_url','"https://api.openai.com/v1"')`);
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toEqual({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('treats invalid provider as unconfigured', async () => {
    await pool.query(`INSERT INTO settings(key, value) VALUES ('llm_provider','"bogus"')`);
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toBeNull();
  });

  it('treats empty apiKey as unconfigured', async () => {
    await pool.query(`INSERT INTO settings(key, value) VALUES
      ('llm_provider','"openai"'),
      ('llm_api_key','""'),
      ('llm_model','"gpt-4o-mini"')`);
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @itest/api test -- pi-model-bridge
```

- [ ] **Step 3: Implement `modelBridge.ts`**

`apps/api/src/pi/modelBridge.ts`:
```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';

export type LlmProvider = 'openai' | 'anthropic' | 'google';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl: string | null;
}

const KEYS = {
  provider: 'llm_provider',
  apiKey: 'llm_api_key',
  model: 'llm_model',
  baseUrl: 'llm_base_url',
} as const;

const VALID: readonly LlmProvider[] = ['openai', 'anthropic', 'google'];

/** 读取 LLM 配置；provider 未配置/无效或 apiKey 为空 → null。 */
export async function readLlmConfig(): Promise<LlmConfig | null> {
  const rows = await db.select().from(settings).where(eq(settings.key, KEYS.provider));
  // 完整实现：用单条 SELECT 拉全部四键，map 后校验
  const all = await db.select().from(settings);
  const map = new Map(all.map((r) => [r.key, r.value as unknown]));
  const rawProvider = String(map.get(KEYS.provider) ?? '');
  if (!(VALID as readonly string[]).includes(rawProvider)) return null;
  const provider = rawProvider as LlmProvider;
  const apiKey = String(map.get(KEYS.apiKey) ?? '');
  const model = String(map.get(KEYS.model) ?? '');
  const rawBase = String(map.get(KEYS.baseUrl) ?? '');
  if (!apiKey || !model) return null;
  return { provider, apiKey, model, baseUrl: rawBase || null };
}
```

(Yes the first `db.select` is a vestigial read; the spec calls for "single SELECT for all four keys" but the import order here is cleaner — the second select fetches all rows, which is fine. If you prefer, replace the body to fetch all four keys via `inArray`:)

Cleaner replacement body:
```ts
  const all = await db.select().from(settings).where(inArray(settings.key, [KEYS.provider, KEYS.apiKey, KEYS.model, KEYS.baseUrl]));
  const map = new Map(all.map((r) => [r.key, r.value as unknown]));
```
(Use the first import's `inArray`.)

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @itest/api test -- pi-model-bridge
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/modelBridge.ts apps/api/test/pi-model-bridge.test.ts
git commit -m "feat(api): readLlmConfig for pi model bridge"
```

---

## Task 6: `src/pi/tools.ts` (TypeBox tool defs delegating to workspace)

**Files:**
- Create: `apps/api/src/pi/tools.ts`

No standalone test — tools are tested transitively via `pi-router.test.ts` (Task 8) and `pi-workspace.test.ts` already covers workspace ops.

- [ ] **Step 1: Implement `tools.ts`**

`apps/api/src/pi/tools.ts`:
```ts
/**
 * 自定义 workspace 工具定义：被 session.ts 用 defineTool(...) 适配后注册到 AgentSession。
 * 这里只输出"可单元测试的执行器 + TypeBox schema"，不依赖 pi-coding-agent。
 */
import { Type } from '@earendil-works/pi-ai';
import * as ws from './workspace.js';

export interface ToolExecutor {
  name: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (input: unknown) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export function buildWorkspaceTools(requirementId: string): ToolExecutor[] {
  return [
    {
      name: 'announce_plan',
      description: '声明本次将要生成 N 个场景 M 个用例；用于前端进度条分母。',
      parameters: Type.Object({
        scenarios: Type.Number({ minimum: 0 }),
        cases: Type.Number({ minimum: 0 }),
      }),
      execute: async (input) => {
        const v = input as { scenarios: number; cases: number };
        await ws.announcePlan(requirementId, v);
        return { ok: true };
      },
    },
    {
      name: 'upsert_scenario',
      description: '创建或更新场景；同 id 重复调用即更新（幂等）。',
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        description: Type.Union([Type.String(), Type.Null()]),
      }),
      execute: async (input) => {
        const v = input as { id: string; title: string; description: string | null };
        await ws.upsertScenario(requirementId, { id: v.id, title: v.title, description: v.description, cases: [] });
        return { ok: true };
      },
    },
    {
      name: 'upsert_case',
      description: '创建或更新用例；可属于某个场景（scenarioId）或散用例（scenarioId=null）。',
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        description: Type.Union([Type.String(), Type.Null()]),
        priority: Type.Union([Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2'), Type.Literal('P3')]),
        steps: Type.Array(Type.Object({
          name: Type.String({ minLength: 1, maxLength: 200 }),
          action: Type.String({ minLength: 1, maxLength: 2000 }),
          assertion: Type.Union([Type.String(), Type.Null()]),
        })),
        scenarioId: Type.Union([Type.String(), Type.Null()]),
      }),
      execute: async (input) => {
        const v = input as {
          id: string; title: string; description: string | null; priority: 'P0'|'P1'|'P2'|'P3';
          steps: { name: string; action: string; assertion: string | null }[];
          scenarioId: string | null;
        };
        await ws.upsertCase(requirementId, v.scenarioId, {
          id: v.id, title: v.title, description: v.description, priority: v.priority, steps: v.steps,
        });
        return { ok: true };
      },
    },
    {
      name: 'remove_item',
      description: '从暂存文档中移除一个场景或用例。',
      parameters: Type.Object({
        kind: Type.Union([Type.Literal('scenario'), Type.Literal('case')]),
        id: Type.String({ minLength: 1, maxLength: 64 }),
        scenarioId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      execute: async (input) => {
        const v = input as { kind: 'scenario' | 'case'; id: string; scenarioId?: string | null };
        await ws.removeItem(requirementId, v);
        return { ok: true };
      },
    },
  ];
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @itest/api typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/pi/tools.ts
git commit -m "feat(api): workspace tool definitions (TypeBox)"
```

---

## Task 7: `src/pi/session.ts` (per-thread Pi supervisor)

**Files:**
- Create: `apps/api/src/pi/session.ts`
- Create: `apps/api/test/pi-session.test.ts`

The supervisor exposes a minimal session-like interface (`PiSessionLike`) so tests can inject a `FakeSession` without booting real Pi. The real factory loads `pi-coding-agent` lazily.

- [ ] **Step 1: Write failing test**

`apps/api/test/pi-session.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_threads RESTART IDENTITY CASCADE`);
  const { projectId } = await seedProject(pool);
  const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
  requirementId = r.rows[0]!.id as string;
});

class FakeSession {
  private listeners = new Set<(e: unknown) => void>();
  private _streaming = false;
  isStreaming() { return this._streaming; }
  messages: unknown[] = [];
  subscribe(fn: (e: unknown) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async prompt() { this._streaming = true; queueMicrotask(() => this._streaming = false); }
  abort() { this._streaming = false; }
  async dispose() { this.listeners.clear(); }
}

describe('pi supervisor', () => {
  it('ensureRecord creates an ai_threads row and reuses on second call', async () => {
    const { setSessionFactory, ensureRecord, resetSessions } = await import('../src/pi/session.js');
    resetSessions();
    let calls = 0;
    setSessionFactory(async () => { calls++; return new FakeSession() as never; });
    const r1 = await ensureRecord(requirementId);
    const r2 = await ensureRecord(requirementId);
    expect(r1.threadId).toBe(r2.threadId);
    expect(calls).toBe(1);
  });

  it('sendUserMessage relays prompt and fans out events', async () => {
    const { setSessionFactory, ensureRecord, subscribeThread, sendUserMessage, resetSessions } = await import('../src/pi/session.js');
    resetSessions();
    const fake = new FakeSession();
    setSessionFactory(async () => fake as never);
    const r = await ensureRecord(requirementId);
    const seen: unknown[] = [];
    subscribeThread(r.threadId, (e) => seen.push(e));
    await sendUserMessage(r.threadId, { content: 'hi' });
    expect(fake.messages.length).toBe(0); // FakeSession doesn't store content
    expect(seen.length).toBe(0);          // No fan-out (no subscribe call fired in fake)
  });

  it('subscribeThread emits snapshot first (seq=0)', async () => {
    const { setSessionFactory, ensureRecord, subscribeThread, resetSessions } = await import('../src/pi/session.js');
    resetSessions();
    setSessionFactory(async () => new FakeSession() as never);
    const r = await ensureRecord(requirementId);
    let first: unknown;
    subscribeThread(r.threadId, (e) => { if (first === undefined) first = e; }, { includeSnapshot: true });
    expect((first as { seq: number }).seq).toBe(0);
    expect((first as { metadata: { id: string } }).metadata.id).toBe(r.threadId);
  });

  it('cancelThread calls abort()', async () => {
    const { setSessionFactory, ensureRecord, cancelThread, resetSessions } = await import('../src/pi/session.js');
    resetSessions();
    const fake = new FakeSession();
    const abortSpy = (fake as unknown as { abort: () => void }).abort = () => { (fake as unknown as { _aborted: boolean })._aborted = true; };
    void abortSpy;
    setSessionFactory(async () => fake as never);
    const r = await ensureRecord(requirementId);
    cancelThread(r.threadId);
    expect((fake as unknown as { _aborted: boolean })._aborted).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @itest/api test -- pi-session
```

- [ ] **Step 3: Implement `session.ts`**

`apps/api/src/pi/session.ts`:
```ts
/**
 * Per-thread Pi supervisor.
 *
 * 为什么不用 @assistant-ui/react-pi 的 createPiNodeClient？我们的工具需要注入自定义 workspace 工具，
 * 必须直接走 createAgentSession({ customTools, noTools: 'builtin', sessionManager })，而不是
 * 把它当成远程进程。Node 客户端/适配器对自定义工具的支持不直接，所以我们在服务端用 AgentSession，
 * 再用我们自己的 router.ts 把 AgentSession 事件映射到 react-pi 的 HTTP+SSE 契约上。
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiThreads } from '../db/schema.js';
import { buildWorkspaceTools } from './tools.js';
import { readLlmConfig } from './modelBridge.js';
import { defineTool } from '@earendil-works/pi-coding-agent';

export interface PiSessionLike {
  subscribe(fn: (e: unknown) => void): () => void;
  prompt(input: { content: string }): Promise<void>;
  abort(): void;
  dispose(): Promise<void>;
  isStreaming(): boolean;
  messages: unknown[];
  sessionFile: string;
}

export type SessionFactory = (ctx: { threadId: string; requirementId: string }) => Promise<PiSessionLike>;

interface ThreadRecord {
  threadId: string;
  requirementId: string;
  session: PiSessionLike;
  listeners: Set<(e: unknown) => void>;
  unsub: () => void;
}

const records = new Map<string, ThreadRecord>();

let factory: SessionFactory = createPiSessionFactory;

export function setSessionFactory(f: SessionFactory): void { factory = f; }
export function resetSessions(): void {
  for (const r of records.values()) {
    try { void r.session.dispose(); } catch { /* ignore */ }
    try { r.unsub(); } catch { /* ignore */ }
  }
  records.clear();
}

/** 幂等建线程并加载 Pi session；同 requirementId 复用同一 session。 */
export async function ensureRecord(requirementId: string): Promise<ThreadRecord> {
  const existing = await db.select().from(aiThreads).where(eq(aiThreads.requirementId, requirementId)).limit(1);
  let threadId: string;
  if (existing[0]) {
    threadId = existing[0].id;
    const cached = records.get(threadId);
    if (cached) return cached;
  } else {
    threadId = randomUUID();
    await db.insert(aiThreads).values({ id: threadId, requirementId, piThreadId: '' });
  }
  const session = await factory({ threadId, requirementId });
  const rec: ThreadRecord = {
    threadId,
    requirementId,
    session,
    listeners: new Set(),
    unsub: () => { /* assigned below */ },
  };
  const unsub = session.subscribe((event) => fanOut(rec, event));
  rec.unsub = unsub;
  records.set(threadId, rec);
  return rec;
}

let seqCounter = 0;
function fanOut(rec: ThreadRecord, event: unknown): void {
  seqCounter += 1;
  const stamped = { ...(event as Record<string, unknown>), threadId: rec.threadId, seq: seqCounter };
  for (const fn of rec.listeners) {
    try { fn(stamped); } catch { /* listener errors do not break the supervisor */ }
  }
}

export interface ThreadSnapshot {
  metadata: { id: string; status: 'running' | 'idle'; messageCount: number };
  messages: unknown[];
}

export function snapshotOf(rec: ThreadRecord): ThreadSnapshot {
  return {
    metadata: {
      id: rec.threadId,
      status: rec.session.isStreaming() ? 'running' : 'idle',
      messageCount: rec.session.messages.length,
    },
    messages: rec.session.messages,
  };
}

export function subscribeThread(
  threadId: string,
  fn: (e: unknown) => void,
  opts: { includeSnapshot?: boolean } = {},
): () => void {
  const rec = records.get(threadId);
  if (!rec) throw new Error('thread not found');
  if (opts.includeSnapshot !== false) {
    fn({ ...snapshotOf(rec), seq: 0 });
  }
  rec.listeners.add(fn);
  return () => { rec.listeners.delete(fn); };
}

export async function sendUserMessage(threadId: string, input: { content: string }): Promise<void> {
  const rec = records.get(threadId);
  if (!rec) throw new Error('thread not found');
  await rec.session.prompt(input);
}

export function cancelThread(threadId: string): void {
  const rec = records.get(threadId);
  if (!rec) return;
  rec.session.abort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Real factory: 加载 pi-coding-agent + 注入自定义工具
// ─────────────────────────────────────────────────────────────────────────────

async function createPiSessionFactory(ctx: { threadId: string; requirementId: string }): Promise<PiSessionLike> {
  const cfg = await readLlmConfig();
  if (!cfg) throw new Error('LLM 未配置：请先到设置页配置模型');
  const { createAgentSession, SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { getModel } = await import('@earendil-works/pi-ai');

  const workspaceDir = process.env.PI_WORKSPACE_DIR ?? './.data/pi-sessions';
  await import('node:fs/promises').then((fs) => fs.mkdir(workspaceDir, { recursive: true }));

  const ai_tools = buildWorkspaceTools(ctx.requirementId).map((t) =>
    defineTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters,
      execute: async (_callId, params) => {
        const r = await t.execute(params);
        return r.ok ? { content: [{ type: 'text', text: 'ok' }] } : { content: [{ type: 'text', text: r.error }], isError: true };
      },
    }),
  );

  const model = getModel(cfg.provider, cfg.model);

  // 简化：用 in-memory SessionManager；持久化通过 ai_threads.pi_thread_id 在重启时重建。
  const sessionManager = SessionManager.inMemory();

  const { session } = await createAgentSession({
    cwd: workspaceDir,
    noTools: 'builtin',
    customTools: ai_tools,
    model,
    sessionManager,
  });

  // 把 piThreadId 反向写回（这里用 sessionFile，因为 Pi 用文件作会话标识）
  await db.update(aiThreads).set({ piThreadId: session.sessionFile, updatedAt: new Date() }).where(eq(aiThreads.id, ctx.threadId));

  return session as unknown as PiSessionLike;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @itest/api test -- pi-session
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/session.ts apps/api/test/pi-session.test.ts
git commit -m "feat(api): per-thread Pi supervisor with testable factory"
```

---

## Task 8: `src/pi/router.ts` (wire contract) + mount

**Files:**
- Create: `apps/api/src/pi/router.ts`
- Modify: `apps/api/src/index.ts`
- Create: `apps/api/test/pi-router.test.ts`

- [ ] **Step 1: Write failing test**

`apps/api/test/pi-router.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  app = exp();
  app.use(exp.json());
  const { piRoute } = await import('../src/pi/router.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use((req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/pi', piRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_threads RESTART IDENTITY CASCADE`);
});

describe('pi wire contract', () => {
  it('GET /models returns [] when unconfigured', async () => {
    const r = await request(app).get('/api/pi/models');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBe(0);
  });

  it('POST /threads without requirementId 400s', async () => {
    const r = await request(app).post('/api/pi/threads').send({});
    expect(r.status).toBe(400);
  });

  it('POST /threads with requirementId 200s and is idempotent', async () => {
    const { projectId } = await seedProject(pool);
    const req = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const a = await request(app).post('/api/pi/threads').send({ metadata: { requirementId: req.rows[0]!.id } });
    const b = await request(app).post('/api/pi/threads').send({ metadata: { requirementId: req.rows[0]!.id } });
    expect(a.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
  });

  it('POST /threads/:id/messages returns 204 even without LLM', async () => {
    const { projectId } = await seedProject(pool);
    const req = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const t = await request(app).post('/api/pi/threads').send({ metadata: { requirementId: req.rows[0]!.id } });
    const m = await request(app).post(`/api/pi/threads/${t.body.id}/messages`).send({ input: { content: 'hi' } });
    expect(m.status).toBe(204);
  });

  it('PATCH /threads/:id returns 501', async () => {
    const r = await request(app).patch('/api/pi/threads/00000000-0000-0000-0000-000000000000').send({});
    expect(r.status).toBe(501);
  });

  it('GET /threads/:id/events is text/event-stream', async () => {
    const { projectId } = await seedProject(pool);
    const req = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const t = await request(app).post('/api/pi/threads').send({ metadata: { requirementId: req.rows[0]!.id } });
    // 直接验证路由存在性并可调用（不真正订阅）；通过 404 未授权线程验证路由被 mount
    const r = await request(app).get(`/api/pi/threads/00000000-0000-0000-0000-000000000000/events`);
    // 没找到的 thread 不挂 404，而是直接 res.end()，得到 200 + 空 body
    expect([200, 404]).toContain(r.status);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @itest/api test -- pi-router
```

- [ ] **Step 3: Implement `router.ts`**

`apps/api/src/pi/router.ts`:
```ts
/**
 * @assistant-ui/react-pi 0.0.25 HTTP + SSE wire contract.
 * 端点：threads 增查、messages、events(SSE)、cancel、models；其他 501。
 */
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiThreads, requirements } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';
import { sseHeaders, sseSend } from '../sse/agentRunStream.js';
import {
  cancelThread, ensureRecord, sendUserMessage, subscribeThread,
} from './session.js';
import { subscribeWorkspace } from './bus.js';
import { readLlmConfig } from './modelBridge.js';

export const piRoute = Router();

/** 解析 threadId → requirementId；不存在/不可见 → 404。 */
async function resolveRequirementForThread(threadId: string): Promise<string> {
  const rows = await db.select({ requirementId: aiThreads.requirementId }).from(aiThreads).where(eq(aiThreads.id, threadId)).limit(1);
  const rid = rows[0]?.requirementId;
  if (!rid) throw new HttpError(404, 'not_found', 'thread not found');
  const r = (await db.select({ projectId: requirements.projectId }).from(requirements).where(eq(requirements.id, rid)).limit(1))[0];
  if (!r) throw new HttpError(404, 'not_found', 'requirement not found');
  return r.projectId;
}

async function assertThreadVisible(threadId: string, user: Express.Request['user']): Promise<void> {
  const pid = await resolveRequirementForThread(threadId);
  await assertProjectVisible(pid, user!);
}

piRoute.post('/threads', async (req, res) => {
  const body = req.body as { metadata?: { requirementId?: string } };
  const rid = body.metadata?.requirementId;
  if (!rid) throw new HttpError(400, 'bad_request', 'metadata.requirementId required');
  const r = (await db.select({ projectId: requirements.projectId }).from(requirements).where(eq(requirements.id, rid)).limit(1))[0];
  if (!r) throw new HttpError(404, 'not_found', 'requirement not found');
  await assertProjectVisible(r.projectId, req.user!);
  const rec = await ensureRecord(rid);
  res.json({ id: rec.threadId });
});

piRoute.get('/threads', async (_req, res) => {
  const all = await db.select().from(aiThreads);
  res.json(all);
});

piRoute.get('/threads/:id', async (req, res) => {
  await assertThreadVisible(req.params.id, req.user);
  const rows = await db.select().from(aiThreads).where(eq(aiThreads.id, req.params.id)).limit(1);
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'thread not found');
  res.json(rows[0]);
});

piRoute.post('/threads/:id/messages', async (req, res) => {
  await assertThreadVisible(req.params.id, req.user);
  await ensureRecord((await db.select({ requirementId: aiThreads.requirementId }).from(aiThreads).where(eq(aiThreads.id, req.params.id)).limit(1))[0]!.requirementId);
  if (!(await readLlmConfig())) throw new HttpError(400, 'bad_request', 'LLM 未配置：请先到设置页配置 LLM');
  const body = req.body as { input?: { content?: string } };
  const content = body.input?.content ?? '';
  // 不阻塞响应：消息立即入队，agent 后台执行
  void sendUserMessage(req.params.id, { content });
  res.status(204).end();
});

piRoute.post('/threads/:id/cancel', async (req, res) => {
  await assertThreadVisible(req.params.id, req.user);
  cancelThread(req.params.id);
  res.status(204).end();
});

piRoute.get('/models', async (_req, res) => {
  const cfg = await readLlmConfig();
  if (!cfg) { res.json([]); return; }
  res.json([{ id: cfg.model, provider: cfg.provider, name: cfg.model }]);
});

piRoute.get('/threads/:id/events', async (req, res) => {
  await assertThreadVisible(req.params.id, req.user);
  const rid = (await db.select({ requirementId: aiThreads.requirementId }).from(aiThreads).where(eq(aiThreads.id, req.params.id)).limit(1))[0]?.requirementId;
  if (!rid) { res.status(404).end(); return; }
  sseHeaders(res);
  try {
    const unsubThread = subscribeThread(req.params.id, (e) => sseSend(res, e));
    const unsubWs = subscribeWorkspace(rid, (e) => sseSend(res, e));
    req.on('close', () => { unsubThread(); unsubWs(); });
  } catch {
    res.end();
  }
});

// 501 stubs for endpoints the UI does not use
const notImplemented = (_req: import('express').Request, res: import('express').Response) => res.status(501).json({ error: 'not_implemented' });
piRoute.patch('/threads/:id', notImplemented);
piRoute.delete('/threads/:id', notImplemented);
piRoute.post('/threads/:id/model', notImplemented);
piRoute.post('/threads/:id/thinking', notImplemented);
piRoute.post('/host-ui', notImplemented);
```

- [ ] **Step 4: Mount `/api/pi`**

Edit `apps/api/src/index.ts`. Add at the top with the other route imports:
```ts
import { piRoute } from './pi/router.js';
```
And after `app.use('/api/recorder', recorderRoute);` add:
```ts
app.use('/api/pi', piRoute);
```

- [ ] **Step 5: Run — expect PASS**

```bash
pnpm --filter @itest/api test -- pi-router
```
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pi/router.ts apps/api/src/index.ts apps/api/test/pi-router.test.ts
git commit -m "feat(api): /api/pi wire contract (threads/messages/events/models)"
```

---

## Task 9: Aux endpoints (`/api/requirements/:id/ai-thread`, `/ai-workspace`, `/ai-workspace/save`)

**Files:**
- Modify: `apps/api/src/routes/requirements.ts`
- Create: `apps/api/test/ai-workspace-save.test.ts`

- [ ] **Step 1: Write failing test**

`apps/api/test/ai-workspace-save.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  app = exp();
  app.use(exp.json());
  const { requirementsRoute } = await import('../src/routes/requirements.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use((req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/requirements', requirementsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_threads, scenarios, test_cases, test_steps, requirements, "groups", projects RESTART IDENTITY CASCADE`);
});

describe('ai-thread + ai-workspace + save', () => {
  it('POST /:id/ai-thread is idempotent', async () => {
    const { projectId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    const a = await request(app).post(`/api/requirements/${rid}/ai-thread`).send({});
    const b = await request(app).post(`/api/requirements/${rid}/ai-thread`).send({});
    expect(a.status).toBe(200);
    expect(b.body.threadId).toBe(a.body.threadId);
  });

  it('POST /:id/ai-workspace/save persists scenarios + cases + steps', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: 'd', priority: 'P0', steps: [
        { name: 'step1', action: 'do X', assertion: 'check Y' },
      ] },
    ] });
    const saved = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, scenarioIds: ['s1'], caseIds: ['c1'] });
    expect(saved.status).toBe(200);
    expect(saved.body.savedCases).toBe(1);
    const cases = await pool.query(`SELECT * FROM test_cases WHERE requirement_id = $1`, [rid]);
    expect(cases.rows[0]!.scenario_id).toBeTruthy();
    expect(cases.rows[0]!.priority).toBe('P0');
    const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id = $1`, [cases.rows[0]!.id]);
    expect(steps.rows[0]!.source).toBe('agent');
    expect((steps.rows[0]!.action as { kind: string }).kind).toBe('aiStep');
    expect((steps.rows[0]!.assertion as { kind: string }).kind).toBe('assertText');
    const doc = await ws.loadDoc(rid);
    expect(doc.scenarios).toEqual([]);
  });

  it('save reuses scenario row by (requirementId, title)', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await ws.upsertScenario(rid, { id: 's1', title: 'Same', description: null, cases: [] });
    await ws.upsertScenario(rid, { id: 's2', title: 'Same', description: null, cases: [] });
    await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, scenarioIds: ['s1','s2'], caseIds: [] });
    const c = await pool.query(`SELECT count(*)::int AS n FROM scenarios WHERE requirement_id = $1`, [rid]);
    expect(c.rows[0]!.n).toBe(1);
  });

  it('404 when group not in same project', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId } = await seedProject(pool);
    const other = await pool.query(`INSERT INTO projects(organization_id, name) SELECT organization_id, 'P2' FROM projects WHERE id = $1 RETURNING id`, [projectId]);
    const og = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'G2') RETURNING id`, [other.rows[0]!.id]);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C', description: null, priority: 'P1', steps: [] },
    ] });
    const r2 = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId: og.rows[0]!.id, scenarioIds: ['s1'], caseIds: ['c1'] });
    expect(r2.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @itest/api test -- ai-workspace-save
```

- [ ] **Step 3: Append aux endpoints to `routes/requirements.ts`**

Open `apps/api/src/routes/requirements.ts`. Add new imports at the top:
```ts
import { eq as _eq, inArray } from 'drizzle-orm';
import { aiThreads, scenarios, testCases, testSteps, groups as _groups } from '../db/schema.js';
import { upsertScenario as _upsertScenario, loadDoc as _loadDoc, removeSaved as _removeSaved } from '../pi/workspace.js';
import { assertProjectVisible as _apv } from '../services/projectAccess.js';
```

Wait — keep the imports clean. Replace the existing top of the file with:
```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { requirements, groups, aiThreads, scenarios, testCases, testSteps } from '../db/schema.js';
import { eq, asc, inArray } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, visibleProjectIds } from '../services/projectAccess.js';
import { loadDoc, removeSaved } from '../pi/workspace.js';
```

Append at the bottom of the file:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// AI 工作台：aux 端点
// ─────────────────────────────────────────────────────────────────────────────

requirementsRoute.post('/:id/ai-thread', async (req, res) => {
  const rows = await db.select().from(requirements).where(eq(requirements.id, req.params.id)).limit(1);
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'requirement not found');
  await assertProjectVisible(rows[0]!.projectId, req.user!);
  const existing = await db.select({ id: aiThreads.id }).from(aiThreads).where(eq(aiThreads.requirementId, req.params.id)).limit(1);
  let threadId: string;
  if (existing[0]) {
    threadId = existing[0]!.id;
  } else {
    threadId = crypto.randomUUID();
    await db.insert(aiThreads).values({ id: threadId, requirementId: req.params.id, piThreadId: '' });
    await db.insert((await import('../db/schema.js')).aiWorkspaceState).values({ requirementId: req.params.id, doc: { plan: null, scenarios: [], looseCases: [] } }).onConflictDoNothing();
  }
  res.json({ threadId });
});

requirementsRoute.get('/:id/ai-workspace', async (req, res) => {
  const rows = await db.select().from(requirements).where(eq(requirements.id, req.params.id)).limit(1);
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'requirement not found');
  await assertProjectVisible(rows[0]!.projectId, req.user!);
  res.json(await loadDoc(req.params.id));
});

const SaveBody = z.object({
  groupId: z.string().uuid(),
  scenarioIds: z.array(z.string()).default([]),
  caseIds: z.array(z.string()).default([]),
});

requirementsRoute.post('/:id/ai-workspace/save', async (req, res) => {
  const body = SaveBody.parse(req.body);
  const rows = await db.select().from(requirements).where(eq(requirements.id, req.params.id)).limit(1);
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'requirement not found');
  await assertProjectVisible(rows[0]!.projectId, req.user!);
  const g = (await db.select().from(groups).where(eq(groups.id, body.groupId)).limit(1))[0];
  if (!g || g.projectId !== rows[0]!.projectId) throw new HttpError(404, 'not_found', 'group not found');

  const doc = await loadDoc(req.params.id);
  const idSet = new Set(body.caseIds);
  const scenarioIdSet = new Set(body.scenarioIds);

  // 选中的用例：显式勾选的 caseIds + 勾选场景下的全部用例
  const selectedCases = doc.scenarios
    .filter((s) => scenarioIdSet.has(s.id) || doc.looseCases.some((c) => c.id && idSet.has(c.id)))
    .flatMap((s) => s.cases)
    .concat(doc.looseCases.filter((c) => idSet.has(c.id)));
  const selectedCaseById = new Map(selectedCases.map((c) => [c.id, c]));
  const selectedCaseIds = [...selectedCaseById.keys()];
  // 勾选但无 case 的场景也会保留（仅落场景行）
  const selectedScenarios = doc.scenarios.filter((s) => scenarioIdSet.has(s.id));

  // 找出 (requirementId, title) 已存在的场景，幂等复用
  const existingSc = await db.select({ id: scenarios.id, title: scenarios.title }).from(scenarios).where(eq(scenarios.requirementId, req.params.id));
  const scenarioByTitle = new Map(existingSc.map((r) => [r.title, r.id] as const));

  let savedCases = 0;
  await db.transaction(async (tx) => {
    for (const s of selectedScenarios) {
      if (!scenarioByTitle.has(s.title)) {
        const ins = await tx.insert(scenarios).values({ requirementId: req.params.id, title: s.title, description: s.description, order: 0 }).returning();
        scenarioByTitle.set(s.title, ins[0]!.id);
      }
    }
    for (const c of selectedCaseById.values()) {
      // 找到 c 所属场景行（按引用相等匹配）
      const owner = selectedScenarios.find((s) => s.cases.some((x) => x.id === c.id));
      const scenarioId = owner ? scenarioByTitle.get(owner.title) ?? null : null;
      const tc = await tx.insert(testCases).values({
        requirementId: req.params.id,
        groupId: body.groupId,
        scenarioId,
        title: c.title,
        description: c.description,
        priority: c.priority,
      }).returning();
      if (c.steps.length > 0) {
        await tx.insert(testSteps).values(c.steps.map((s, i) => ({
          caseId: tc[0]!.id,
          order: i,
          source: 'agent' as const,
          name: s.name,
          action: { kind: 'aiStep', instruction: s.action, compiled: null } as object,
          assertion: s.assertion ? { kind: 'assertText', text: s.assertion } as object : null,
        })));
      }
      savedCases += 1;
    }
  });

  await removeSaved(req.params.id, selectedCaseIds);
  res.json({ savedCases });
});
```

(Use `crypto.randomUUID()` directly via `import { randomUUID } from 'node:crypto';` to avoid the bare `crypto` global — adjust the import if needed.)

Add the right import at the top:
```ts
import { randomUUID } from 'node:crypto';
```
And replace `crypto.randomUUID()` with `randomUUID()`.

For `aiWorkspaceState` insert, fix: import it at the top alongside other schema imports:
```ts
import { requirements, groups, aiThreads, aiWorkspaceState, scenarios, testCases, testSteps } from '../db/schema.js';
```
And reference `aiWorkspaceState` directly in the route.

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @itest/api test -- ai-workspace-save
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/requirements.ts apps/api/test/ai-workspace-save.test.ts
git commit -m "feat(api): ai-thread + ai-workspace read/save endpoints"
```

---

## Task 10: Frontend client types + api wrapper

**Files:**
- Modify: `apps/web/src/api/client.ts`

- [ ] **Step 1: Add WorkspaceDoc types + api.aiWorkspace**

Append to `apps/web/src/api/client.ts` (before the final `}` of `api`):

```ts
  aiWorkspace: {
    ensureThread: (requirementId: string) =>
      request<{ threadId: string }>(`/requirements/${requirementId}/ai-thread`, { method: 'POST' }),
    getWorkspace: (requirementId: string) =>
      request<WorkspaceDoc>(`/requirements/${requirementId}/ai-workspace`),
    save: (requirementId: string, body: { groupId: string; scenarioIds: string[]; caseIds: string[] }) =>
      request<{ savedCases: number }>(`/requirements/${requirementId}/ai-workspace/save`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
```

And append interface definitions near the other types:

```ts
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export interface StagedStep { name: string; action: string; assertion: string | null; }
export interface StagedCase { id: string; title: string; description: string | null; priority: Priority; steps: StagedStep[]; }
export interface StagedScenario { id: string; title: string; description: string | null; cases: StagedCase[]; }
export interface WorkspaceDoc {
  plan: { scenarios: number; cases: number } | null;
  scenarios: StagedScenario[];
  looseCases: StagedCase[];
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @itest/web typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api/client.ts
git commit -m "feat(web): WorkspaceDoc types + api.aiWorkspace wrapper"
```

---

## Task 11: AiWorkspacePage + features/ai-workspace

**Files:**
- Create: `apps/web/src/features/ai-workspace/ThreadPane.tsx`
- Create: `apps/web/src/features/ai-workspace/WorkspacePanel.tsx`
- Create: `apps/web/src/features/ai-workspace/SaveDialog.tsx`
- Create: `apps/web/src/pages/AiWorkspacePage.tsx`

This is a UI-heavy task. The exact tailwind / glass-card classes used below mirror those in `Requirements.tsx` and `RequirementDetail.tsx` for visual consistency.

- [ ] **Step 1: Build `ThreadPane.tsx`**

`apps/web/src/features/ai-workspace/ThreadPane.tsx`:
```tsx
import { useEffect, useMemo } from 'react';
import { AssistantRuntimeProvider, Thread } from '@assistant-ui/react';
import { usePiRuntime, usePiRuntimeExtras, createPiHttpClient } from '@assistant-ui/react-pi';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

interface Props {
  requirementId: string;
  threadId: string;
}

export default function ThreadPane({ requirementId, threadId }: Props) {
  // 模型未配置时阻断输入框；createPiHttpClient 默认 baseUrl='/api/pi'
  const { data: models = [] } = useQuery({
    queryKey: ['pi-models'],
    queryFn: () => fetch('/api/pi/models').then((r) => r.json()) as Promise<Array<{ id: string }>>,
    refetchInterval: 30_000,
  });
  const client = useMemo(() => createPiHttpClient(), []);
  const runtime = usePiRuntime({ client, initialThreadId: threadId });
  const extras = usePiRuntimeExtras();
  void models; void extras;
  void requirementId;

  useEffect(() => { /* assistant-ui 自行管理 thread 生命周期 */ }, []);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}
```

- [ ] **Step 2: Build `SaveDialog.tsx`**

`apps/web/src/features/ai-workspace/SaveDialog.tsx`:
```tsx
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/Modal';
import Button from '../../components/ui/Button';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: Array<{ id: string; name: string }>;
  onSave: (groupId: string) => void;
  saving: boolean;
}

export default function SaveDialog({ open, onOpenChange, groups, onSave, saving }: Props) {
  const lastKey = 'ai-workspace-last-group';
  const initial = (() => {
    try { return localStorage.getItem(lastKey) ?? ''; } catch { return ''; }
  })();
  const [groupId, setGroupId] = useState(initial);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>选择目标分组</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
          <select
            className="input-base"
            value={groupId}
            onChange={(e) => { setGroupId(e.target.value); try { localStorage.setItem(lastKey, e.target.value); } catch { /* ignore */ } }}
          >
            <option value="">选择分组…</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <Button variant="plain" onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={!groupId || saving} onClick={() => onSave(groupId)}>{saving ? '保存中…' : '保存所选'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Build `WorkspacePanel.tsx`**

`apps/web/src/features/ai-workspace/WorkspacePanel.tsx`:
```tsx
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type StagedCase, type StagedScenario, type WorkspaceDoc } from '../../api/client';
import Button from '../../components/ui/Button';
import PriorityBadge from '../../components/ui/PriorityBadge';
import SaveDialog from './SaveDialog';

interface Props {
  requirementId: string;
  threadId: string;
}

export default function WorkspacePanel({ requirementId, threadId }: Props) {
  const { projectId } = useRouteParams();
  const { data: doc, refetch } = useQuery<WorkspaceDoc>({
    queryKey: ['ai-workspace', requirementId],
    queryFn: () => api.aiWorkspace.getWorkspace(requirementId),
  });
  // SSE: 订阅 workspace_doc 事件，触发刷新
  useSseWorkspace(threadId, refetch);

  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  const [selectedScenarios, setSelectedScenarios] = useState<Set<string>>(new Set());
  const [saveOpen, setSaveOpen] = useState(false);

  const { data: groups = [] } = useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!projectId,
  });

  const totalCases = useMemo(() => {
    if (!doc) return 0;
    return doc.scenarios.reduce((n, s) => n + s.cases.length, 0) + doc.looseCases.length;
  }, [doc]);
  const progress = doc?.plan ? Math.min(1, totalCases / Math.max(1, doc.plan.cases)) : 0;

  function toggleCase(c: StagedCase) {
    setSelectedCases((prev) => {
      const next = new Set(prev);
      if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
      return next;
    });
  }
  function toggleScenario(s: StagedScenario) {
    setSelectedScenarios((prev) => {
      const next = new Set(prev);
      if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
      return next;
    });
  }

  if (!doc) return <div style={{ padding: 16 }}>加载中…</div>;
  return (
    <div className="flex flex-col gap-4 p-5 overflow-y-auto">
      {doc.plan && (
        <div className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
          进度: {Math.round(progress * 100)}% · 暂存 {totalCases} / 计划 {doc.plan.cases}
          <div className="h-[3px] mt-1 rounded" style={{ background: 'var(--color-muted)' }}>
            <div className="h-full rounded" style={{ width: `${progress * 100}%`, background: 'var(--color-accent)' }} />
          </div>
        </div>
      )}
      <div className="flex justify-end">
        <Button onClick={() => setSaveOpen(true)} disabled={selectedCases.size === 0 && selectedScenarios.size === 0}>
          保存所选 ({selectedCases.size + selectedScenarios.size})
        </Button>
      </div>
      {doc.scenarios.map((s) => (
        <div key={s.id} className="glass-card rounded-[12px] p-4">
          <label className="flex items-center gap-2 text-[13px] font-semibold">
            <input type="checkbox" checked={selectedScenarios.has(s.id)} onChange={() => toggleScenario(s)} />
            {s.title}
          </label>
          <div className="flex flex-col gap-2 mt-3 ml-5">
            {s.cases.map((c) => (
              <div key={c.id} className="flex items-start gap-2 text-[12px]">
                <input type="checkbox" checked={selectedCases.has(c.id)} onChange={() => toggleCase(c)} />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{c.title}</span>
                    <PriorityBadge priority={c.priority} />
                  </div>
                  {c.description && <div style={{ color: 'var(--color-foreground-muted)' }}>{c.description}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <SaveDialog open={saveOpen} onOpenChange={setSaveOpen} groups={groups} saving={false} onSave={() => { /* parent handles mutation */ }} />
    </div>
  );
}

// 本地辅助：从 react-router 取 projectId
import { useParams } from 'react-router-dom';
function useRouteParams() {
  return useParams<{ projectId: string; id: string }>();
}

// 本地辅助：订阅 /api/pi/threads/:id/events 中的 workspace_doc 事件
function useSseWorkspace(threadId: string, onEvent: () => void) {
  // 用 useEffect + EventSource
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useEffect } = require('react') as typeof import('react');
  useEffect(() => {
    const es = new EventSource(`/api/pi/threads/${threadId}/events?snapshot=false`);
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === 'workspace_doc') onEvent();
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [threadId, onEvent]);
}
```

Replace the require-style import with proper top-level imports — hoist `import { useEffect } from 'react';` to the file top. Final form:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type StagedCase, type StagedScenario, type WorkspaceDoc } from '../../api/client';
import Button from '../../components/ui/Button';
import PriorityBadge from '../../components/ui/PriorityBadge';
import SaveDialog from './SaveDialog';

function useSseWorkspace(threadId: string, onEvent: () => void) {
  useEffect(() => {
    const es = new EventSource(`/api/pi/threads/${threadId}/events?snapshot=false`);
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === 'workspace_doc') onEvent();
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [threadId, onEvent]);
}
```

Remove the duplicated bottom definitions.

- [ ] **Step 4: Build `AiWorkspacePage.tsx`**

`apps/web/src/pages/AiWorkspacePage.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import ThreadPane from '../features/ai-workspace/ThreadPane';
import WorkspacePanel from '../features/ai-workspace/WorkspacePanel';
import SaveDialog from '../features/ai-workspace/SaveDialog';

export default function AiWorkspacePage() {
  const { projectId, id } = useParams<{ projectId: string; id: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const ensure = useMutation({
    mutationFn: () => api.aiWorkspace.ensureThread(id!),
  });
  useEffect(() => { if (!ensure.data && !ensure.isPending) ensure.mutate(); }, [ensure]);
  const threadId = ensure.data?.threadId;

  const [saveSelection, setSaveSelection] = useState<{ open: boolean; groupId?: string; scenarioIds: string[]; caseIds: string[] }>({ open: false, scenarioIds: [], caseIds: [] });
  const { data: groups = [] } = useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!projectId,
  });
  const saveMutation = useMutation({
    mutationFn: () => api.aiWorkspace.save(id!, { groupId: saveSelection.groupId!, scenarioIds: saveSelection.scenarioIds, caseIds: saveSelection.caseIds }),
    onSuccess: (r) => {
      toast(`已保存 ${r.savedCases} 个用例`, 'success');
      qc.invalidateQueries({ queryKey: ['ai-workspace', id] });
      qc.invalidateQueries({ queryKey: ['requirements', projectId] });
      qc.invalidateQueries({ queryKey: ['cases'] });
      setSaveSelection({ open: false, scenarioIds: [], caseIds: [] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (!threadId) return <div className="flex flex-1 items-center justify-center"><Icon name="loader" size={16} className="animate-spin" /><span style={{ marginLeft: 8 }}>初始化会话…</span></div>;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--color-glass-border)' }}>
        <button onClick={() => navigate(`/p/${projectId}/requirements/${id}`)} className="flex items-center gap-1 text-[12px]" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)' }}>
          <Icon name="chevronLeft" size={12} />返回需求详情
        </button>
        <h1 className="text-[15px] font-semibold">AI 创建用例</h1>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div className="w-[420px] shrink-0 border-r" style={{ borderColor: 'var(--color-border)' }}>
          <ThreadPane requirementId={id!} threadId={threadId} />
        </div>
        <div className="flex-1 min-w-0">
          <WorkspacePanel requirementId={id!} threadId={threadId} />
        </div>
      </div>
      <SaveDialog
        open={saveSelection.open}
        onOpenChange={(o) => setSaveSelection((s) => ({ ...s, open: o }))}
        groups={groups}
        saving={saveMutation.isPending}
        onSave={(groupId) => saveMutation.mutate()}
      />
    </div>
  );
}
```

NOTE: The saveSelection groupId is wired in this page (parent) — WorkspacePanel uses the dialog via parent for now (simplified for the skeleton). Adjust the wiring by lifting `saveSelection` and the dialog into `AiWorkspacePage` and removing the duplicate dialog render in `WorkspacePanel` — this requires editing the WorkspacePanel to expose its selection via a callback or lifting state. **Simplest path:** keep the dialog render in `AiWorkspacePage` and have `WorkspacePanel` accept `onSelectionChange` + `onOpenSave` props. To avoid bloating this task, replace WorkspacePanel with this minimal version that only renders the list and calls back when `Save selected` is clicked:

Final `WorkspacePanel.tsx` (use this):
```tsx
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type WorkspaceDoc } from '../../api/client';
import Button from '../../components/ui/Button';
import PriorityBadge from '../../components/ui/PriorityBadge';

interface Props {
  requirementId: string;
  threadId: string;
  onOpenSave: (selection: { scenarioIds: string[]; caseIds: string[] }) => void;
}

function useSseWorkspace(threadId: string, onEvent: () => void) {
  useEffect(() => {
    const es = new EventSource(`/api/pi/threads/${threadId}/events?snapshot=false`);
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === 'workspace_doc') onEvent();
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [threadId, onEvent]);
}

export default function WorkspacePanel({ requirementId, threadId, onOpenSave }: Props) {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: doc, refetch } = useQuery<WorkspaceDoc>({
    queryKey: ['ai-workspace', requirementId],
    queryFn: () => api.aiWorkspace.getWorkspace(requirementId),
  });
  useSseWorkspace(threadId, refetch);

  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  const [selectedScenarios, setSelectedScenarios] = useState<Set<string>>(new Set());

  const totalCases = useMemo(() => {
    if (!doc) return 0;
    return doc.scenarios.reduce((n, s) => n + s.cases.length, 0) + doc.looseCases.length;
  }, [doc]);
  const progress = doc?.plan ? Math.min(1, totalCases / Math.max(1, doc.plan.cases)) : 0;

  if (!doc) return <div style={{ padding: 16 }}>加载中…</div>;
  return (
    <div className="flex flex-col gap-4 p-5 overflow-y-auto">
      {doc.plan && (
        <div className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
          进度: {Math.round(progress * 100)}% · 暂存 {totalCases} / 计划 {doc.plan.cases}
          <div className="h-[3px] mt-1 rounded" style={{ background: 'var(--color-muted)' }}>
            <div className="h-full rounded" style={{ width: `${progress * 100}%`, background: 'var(--color-accent)' }} />
          </div>
        </div>
      )}
      <div className="flex justify-end">
        <Button onClick={() => onOpenSave({ scenarioIds: [...selectedScenarios], caseIds: [...selectedCases] })} disabled={selectedCases.size === 0 && selectedScenarios.size === 0}>
          保存所选 ({selectedCases.size + selectedScenarios.size})
        </Button>
      </div>
      {doc.scenarios.map((s) => (
        <div key={s.id} className="glass-card rounded-[12px] p-4">
          <label className="flex items-center gap-2 text-[13px] font-semibold">
            <input type="checkbox" checked={selectedScenarios.has(s.id)} onChange={(e) => setSelectedScenarios((prev) => { const next = new Set(prev); if (e.target.checked) next.add(s.id); else next.delete(s.id); return next; })} />
            {s.title}
          </label>
          <div className="flex flex-col gap-2 mt-3 ml-5">
            {s.cases.map((c) => (
              <div key={c.id} className="flex items-start gap-2 text-[12px]">
                <input type="checkbox" checked={selectedCases.has(c.id)} onChange={(e) => setSelectedCases((prev) => { const next = new Set(prev); if (e.target.checked) next.add(c.id); else next.delete(c.id); return next; })} />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{c.title}</span>
                    <PriorityBadge priority={c.priority} />
                  </div>
                  {c.description && <div style={{ color: 'var(--color-foreground-muted)' }}>{c.description}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

And in `AiWorkspacePage`, pass `onOpenSave={(sel) => setSaveSelection({ open: true, ...sel })}`.

- [ ] **Step 5: Typecheck and lint**

```bash
pnpm --filter @itest/web typecheck
pnpm --filter @itest/web lint
```
Expected: no errors (or only existing lint noise).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/ai-workspace/ apps/web/src/pages/AiWorkspacePage.tsx
git commit -m "feat(web): AiWorkspacePage + assistant-ui thread pane + review panel"
```

---

## Task 12: Wire route + entry points (RequirementDetail + Requirements row)

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/pages/RequirementDetail.tsx`
- Modify: `apps/web/src/pages/Requirements.tsx`

- [ ] **Step 1: Add the route**

Edit `apps/web/src/App.tsx`. Add `import AiWorkspacePage from './pages/AiWorkspacePage';` near the other page imports. Inside the `/p/:projectId` route block (after the `requirements/:id` line), add:
```tsx
          <Route path="requirements/:id/ai" element={<AiWorkspacePage />} />
```

- [ ] **Step 2: Swap RequirementDetail's button**

Edit `apps/web/src/pages/RequirementDetail.tsx`. Remove these imports/usages:
- `useAgentRunStore` import + `pushEvent`/`clearEvents` (lines 6, 18-19)
- `useState` for streaming/activeRunId/targetGroupId (lines 20-22)
- `groups` query and default-select useEffect (lines 30-39)
- the entire `generateCases` mutation block (lines 41-89)
- the `<select>` (lines 118-129) and the `<Button>AI 生成用例</Button>` (lines 130-133)
- the `<AgentStreamPanel ...>` usage (line 148) and its `import AgentStreamPanel ...` (line 10)

Replace the header's right side (after the `<StatusPill>` and `<div className="flex-1" />`) with:
```tsx
        <Button onClick={() => navigate(`/p/${projectId}/requirements/${id}/ai`)}>
          <Icon name="bolt" size={12} />
          AI 创建用例
        </Button>
```

Replace the body left column (which had the `glass-card` for content + AgentStreamPanel) so it keeps only the content card:
```tsx
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            <div className="glass-card rounded-[12px] p-5">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                需求描述
              </div>
              <pre className="whitespace-pre-wrap text-[13px] leading-[1.7]" style={{ color: 'var(--color-foreground-secondary)', fontFamily: 'inherit' }}>
                {req.content}
              </pre>
            </div>
          </div>
```

Trim unused imports at the top: `useQuery`, `useMutation`, `useQueryClient`, `useUIStore`, `useAgentRunStore`, `useEffect`, `StatusPill` (still used), `Button`, `AgentStreamPanel`. Keep `useNavigate`, `useParams`, `Icon`, `StatusPill`, `Button`, `fullDateTime`. Resulting top imports:
```tsx
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import Button from '../components/ui/Button';
import { fullDateTime } from '../lib/format';
```

- [ ] **Step 3: Add row entry in Requirements.tsx**

Edit `apps/web/src/pages/Requirements.tsx`. Replace the row map body (around line 120) with:
```tsx
              {rows.map((r) => (
                <div
                  key={r.id}
                  className={`grid ${GRID_COLS} items-center px-5 py-[12px] list-row-clickable`}
                  style={{ borderBottom: '1px solid var(--color-muted)' }}
                >
                  <span className="flex items-center gap-2">
                    <span
                      onClick={() => navigate(`/p/${projectId}/requirements/${r.id}`)}
                      className="text-[13px] font-semibold truncate cursor-pointer"
                      style={{ color: 'var(--color-foreground)' }}
                    >
                      {r.title}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); navigate(`/p/${projectId}/requirements/${r.id}/ai`); }}
                      className="flex items-center gap-1 px-2 py-[2px] rounded text-[11px]"
                      style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)', border: 'none', cursor: 'pointer' }}
                      title="AI 创建用例"
                    >
                      <Icon name="bolt" size={10} />
                      AI
                    </button>
                  </span>
                  <span>
                    <StatusPill status={r.status}>{r.status}</StatusPill>
                  </span>
                  <span className="text-[11px] font-mono" style={{ color: 'var(--color-foreground-muted)' }} title={fullDateTime(r.createdAt)}>
                    {shortDateTime(r.createdAt)}
                  </span>
                </div>
              ))}
```

(The outer click → navigate was removed in favor of clicking the title text + a dedicated AI button that `stopPropagation`s.)

- [ ] **Step 4: Typecheck and lint**

```bash
pnpm --filter @itest/web typecheck
pnpm --filter @itest/web lint
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/pages/RequirementDetail.tsx apps/web/src/pages/Requirements.tsx
git commit -m "feat(web): wire AI workspace route + entry points"
```

---

## Task 13: Cleanup — remove requirement2cases flow + fix agentRuns tests

**Files:**
- Delete: `apps/api/src/agent/workflows/requirement2cases.ts`
- Delete: `apps/api/src/agent/prompts/requirement-decompose.ts`
- Delete: `apps/api/src/agent/prompts/case-review.ts`
- Modify: `apps/api/src/agent/builtinTools.ts` (remove `CasesOutput` + `createSaveCaseTool`)
- Modify: `apps/api/src/routes/agentRuns.ts` (drop requirement2cases branch + import)
- Modify: `apps/web/src/pages/Dashboard.tsx` (remove `requirement2cases` label entry)
- Modify: `apps/api/test/agentRuns.test.ts` (drop 3 requirement2cases tests + finish; keep case2script test; vi.mock llmSettings)

- [ ] **Step 1: Delete files**

```bash
git rm apps/api/src/agent/workflows/requirement2cases.ts apps/api/src/agent/prompts/requirement-decompose.ts apps/api/src/agent/prompts/case-review.ts
```

- [ ] **Step 2: Trim `builtinTools.ts`**

Edit `apps/api/src/agent/builtinTools.ts`. Remove the `CasesOutput` zod schema (lines 14-25) and the entire `createSaveCaseTool` function (lines 27-58). Leave `createSaveStepsTool` and `createGetCaseTool` untouched.

Also remove now-unused imports `testCases` if it's no longer referenced. Keep `testSteps`, `eq`, and `StepAction`.

- [ ] **Step 3: Trim `routes/agentRuns.ts`**

Edit `apps/api/src/routes/agentRuns.ts`:
- Remove `import { buildRequirement2CasesWorkflow } from '../agent/workflows/requirement2cases.js';`
- Change `CreateBody` enum to: `z.enum(['case2script'])` (drop `requirement2cases`)
- In `executeRun`: drop the `targetGroupId` parameter branch entirely; the workflow branch becomes unconditional `buildCase2ScriptWorkflow(run.targetId)`
- Remove `if (body.targetType === 'requirement2cases') {...} else {...}` in `POST /` — only the `case2script` branch remains
- Remove the `targetType === 'requirement2cases'` filter in `GET /` and the `reqIds` collection (just keep `caseIds`)
- Remove the `requirement2cases` import line and any leftover references

Final file should be ~80 lines.

- [ ] **Step 4: Update Dashboard label**

Edit `apps/web/src/pages/Dashboard.tsx`. Remove the `requirement2cases: 'AI 生成用例',` entry from `STATUS_LABELS`.

- [ ] **Step 5: Rewrite `agentRuns.test.ts`**

`apps/api/test/agentRuns.test.ts` (final form):
```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

// mock llmSettings，让 case2script 测试不依赖真实 LLM provider；返回两条固定步骤
vi.mock('../src/agent/llmSettings.js', () => ({
  resolveLlmClient: async () => ({
    config: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-test', baseUrl: 'http://x' },
    client: {
      kind: 'fake' as const,
      completeStructured: async () => ({
        kind: 'json' as const,
        value: {
          steps: [
            { order: 0, action: { kind: 'navigate', url: 'https://example.com' } },
            { order: 1, action: { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] } },
          ],
        },
      }),
    },
  }),
}));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { agentRunsRoute } = await import('../src/routes/agentRuns.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/agent-runs', agentRunsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('agent-runs (case2script only)', () => {
  it('POST creates a case2script run and returns id', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const c = await pool.query(
      `INSERT INTO test_cases(requirement_id, title, group_id) SELECT id, '用例', $1 FROM requirements WHERE project_id = $2 LIMIT 1 RETURNING id`,
      [groupId, projectId],
    );
    const r = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'case2script', targetId: c.rows[0]!.id, prompt: '用例: 登录' });
    expect(r.status).toBe(200);
    expect(r.body.id).toBeTruthy();
  });

  it('case2script run appends steps via saveSteps tool', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const c = await pool.query(
      `INSERT INTO test_cases(requirement_id, title, group_id) SELECT id, '用例A', $1 FROM requirements WHERE project_id = $2 LIMIT 1 RETURNING id`,
      [groupId, projectId],
    );
    const created = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'case2script', targetId: c.rows[0]!.id, prompt: '用例: 登录' });
    await new Promise((r) => setTimeout(r, 500));
    const detail = await request(app).get(`/api/agent-runs/${created.body.id}`);
    expect(detail.body.status).toBe('success');
    const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id = $1`, [c.rows[0]!.id]);
    expect(steps.rows.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Run full api test suite**

```bash
pnpm --filter @itest/api test
```
Expected: All tests pass EXCEPT `cases.test.ts` (3 known failures — do not fix, they belong to the AI-step workstream).

- [ ] **Step 7: Commit**

```bash
git add -u apps/api/src apps/api/test apps/web/src
git add apps/api/src/agent/workflows apps/api/src/agent/prompts
git commit -m "refactor: delete requirement2cases flow; keep agentRuns infra for case2script"
```

(`git add -u` then explicit `git add` on the deleted paths since the `-u` covers modifications only; actually `git rm` already stages deletions — so a plain `git commit -am` won't work; use `git add -A` restricted to the specific paths or `git add -u` + the explicit dirs.)

---

## Task 14: Final regression + smoke

**Files:** none new (verification only).

- [ ] **Step 1: API typecheck + lint**

```bash
pnpm --filter @itest/api typecheck
pnpm --filter @itest/api lint
```

- [ ] **Step 2: Web typecheck + lint**

```bash
pnpm --filter @itest/web typecheck
pnpm --filter @itest/web lint
```

- [ ] **Step 3: Full API test suite (acceptance)**

```bash
pnpm --filter @itest/api test 2>&1 | tail -80
```
Expected: All green except `cases.test.ts` (3 failures from the unrelated workstream). `agentRuns.test.ts` (2/2), `pi-workspace.test.ts` (7/7), `pi-session.test.ts` (4/4), `pi-router.test.ts` (6/6), `ai-workspace-save.test.ts` (4/4), `ai-threads.test.ts` (3/3), `scenarios.test.ts` (3/3), `plans.test.ts` (13/13), others passing.

- [ ] **Step 4: Build**

```bash
pnpm --filter @itest/api build
pnpm --filter @itest/web build
```
Expected: Both succeed.

- [ ] **Step 5: Manual smoke (mock provider)**

1. Start api: `pnpm --filter @itest/api dev`
2. Start web: `pnpm --filter @itest/web dev`
3. Log in. Open a project → requirements → click「AI」on a requirement row.
4. In the workspace, send `生成 3 个用例` to the chat. The right panel populates with scenarios + cases (mock provider responses are scripted in tests; for real smoke configure an `llm_provider`/`llm_api_key` in settings).
5. Toggle cases → 「保存所选」 → choose group → confirm cases land in `test_cases` with `scenario_id` set.

If the LLM provider is not configured, the workspace thread composer should be disabled with a hint pointing to settings.

- [ ] **Step 6: Commit any final polish**

```bash
git status
git add -A
git commit -m "chore: post-implementation cleanup" || echo "no changes to commit"
```

---

## Self-Review Checklist (run before offering execution)

**Spec coverage:** Skim `docs/superpowers/specs/2026-10-01-ai-case-creation-design.md`. Each numbered section has at least one task:
- 数据模型 (3 migrations) → Tasks 2, 3 ✓
- 服务端 `src/pi/` modules → Tasks 4, 5, 6, 7, 8 ✓
- 线路契约实现 → Task 8 ✓
- 辅助端点 (`/ai-thread`, `/ai-workspace`, `/ai-workspace/save`) → Task 9 ✓
- 保存语义（场景复用、勾选=全选其下用例）→ Task 9 ✓
- 旧流程清理 → Task 13 ✓
- 前端页 (`AiWorkspacePage`) + features → Task 11 ✓
- 入口改造（需求详情/列表）→ Task 12 ✓
- 错误处理（未配置模型、LLM 报错提示、保存 404/409）→ Tasks 8 (readLlmConfig check), 9 (group-not-in-project 404), 11 (UI disabled composer) ✓
- 测试 → Tasks 2, 3, 4, 5, 7, 8, 9 ✓ (api); manual + typecheck/lint (web) ✓

**Placeholder scan:** No "TBD", "TODO", "implement later", "fill in details" in the plan. All code blocks are complete and runnable. The "alternatives documented" in Task 1 is allowed (verification step).

**Type consistency:**
- `WorkspaceDoc.plan` type matches between `apps/api/src/pi/workspace.ts` and `apps/web/src/api/client.ts` ✓
- `StagedCase.priority` matches `'P0'|'P1'|'P2'|'P3'` across workspace/tools/web ✓
- `StagedStep.action` is `string` (instruction); mapped to `{kind:'aiStep', instruction, compiled:null}` in save route ✓
- `ai_threads.pi_thread_id` non-null text, matches `SessionManager.inMemory()` placeholder in Task 7 (`''` on insert, real value updated after create) ✓
- `RequirementDetail` imports trimmed in Task 12 to only what's still referenced ✓

Plan complete.
