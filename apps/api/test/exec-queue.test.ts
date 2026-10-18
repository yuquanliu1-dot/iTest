/**
 * exec queue 分发测试：mock 掉 execQueue / runPlan 模块，覆盖 enqueuePlanRun 两个分支。
 * - isExecutionQueueReady()===true  → 任务入队 exec.add('exec', {kind:'plan',planRunId})，inline runPlanAsync 不调用
 * - isExecutionQueueReady()===false → 回落 inline runPlanAsync({planRunId})，不入队
 *
 * 测试环境无 redis；分支由 mocked isExecutionQueueReady 的返回值控制（不改 env，避免真的构造 Queue）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

import { getExecutionQueue, isExecutionQueueReady, EXEC_QUEUE_NAME } from '../src/scheduler/execQueue.js';
import { runPlanAsync } from '../src/execute/runPlan.js';

vi.mock('../src/scheduler/execQueue.js', () => ({
  EXEC_QUEUE_NAME: 'exec',
  isExecutionQueueReady: vi.fn(),
  getExecutionQueue: vi.fn(),
}));

vi.mock('../src/execute/runPlan.js', () => ({
  runPlanAsync: vi.fn().mockResolvedValue(undefined),
  findIncognitoCaseIds: vi.fn().mockResolvedValue([]),
}));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let addMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  delete process.env.REDIS_URL;
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

beforeEach(() => {
  addMock = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getExecutionQueue).mockReturnValue({ add: addMock } as unknown as ReturnType<typeof getExecutionQueue>);
  vi.mocked(isExecutionQueueReady).mockReset().mockReturnValue(false);
  vi.mocked(runPlanAsync).mockReset();
  vi.mocked(runPlanAsync).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function newPlan(): Promise<{ planId: string; userId: string }> {
  const { orgId, userId } = await seedOrg(pool);
  const { projectId } = await seedProject(pool);
  const planId = (await pool.query(
    `INSERT INTO execution_plans(project_id, name) VALUES ($1, 'exec-queue-test') RETURNING id`,
    [projectId],
  )).rows[0]!.id as string;
  void orgId;
  return { planId, userId };
}

describe('enqueuePlanRun exec-queue 分发', () => {
  it('isExecutionQueueReady=true:任务入队 exec.add,runPlanAsync 不调,plan_runs 落 running 行', async () => {
    const { enqueuePlanRun } = await import('../src/execute/enqueuePlanRun.js');
    const { planId, userId } = await newPlan();
    vi.mocked(isExecutionQueueReady).mockReturnValue(true);

    const { runId } = await enqueuePlanRun({
      planId,
      trigger: { source: 'manual', userId, scheduleId: null },
      callerUser: null,
    });

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(EXEC_QUEUE_NAME, { kind: 'plan', planRunId: runId });
    expect(vi.mocked(runPlanAsync)).not.toHaveBeenCalled();

    const row = (await pool.query(`SELECT status FROM plan_runs WHERE id=$1`, [runId])).rows[0];
    expect(row).toBeDefined();
    expect(row.status).toBe('running');
  });

  it('isExecutionQueueReady=false:不入队,回落 inline runPlanAsync', async () => {
    const { enqueuePlanRun } = await import('../src/execute/enqueuePlanRun.js');
    const { planId, userId } = await newPlan();
    vi.mocked(isExecutionQueueReady).mockReturnValue(false);

    const { runId } = await enqueuePlanRun({
      planId,
      trigger: { source: 'manual', userId, scheduleId: null },
      callerUser: null,
    });

    expect(addMock).not.toHaveBeenCalled();
    expect(vi.mocked(runPlanAsync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runPlanAsync)).toHaveBeenCalledWith({ planRunId: runId });
  });
});