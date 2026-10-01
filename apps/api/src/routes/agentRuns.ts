import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentRuns, testCases, groups } from '../db/schema.js';
import { eq, desc, inArray } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { runWorkflow } from '../agent/agentFactory.js';
import { resolveLlmClient } from '../agent/llmSettings.js';
import { buildCase2ScriptWorkflow } from '../agent/workflows/case2script.js';
import { sseHeaders, sseSend } from '../sse/agentRunStream.js';
import { publishRunEvent, subscribeRun } from '../sse/runBus.js';
import { assertProjectVisible, resolveCaseProjectId, visibleProjectIds } from '../services/projectAccess.js';

export const agentRunsRoute = Router();

const CreateBody = z.object({
  targetType: z.enum(['case2script']),
  targetId: z.string().uuid(),
  prompt: z.string().min(1),
});

type RunRow = typeof agentRuns.$inferSelect;

/** 解析 agent run 的 target 所属项目 id；无法解析返回 null。 */
async function resolveRunProjectId(run: Pick<RunRow, 'targetType' | 'targetId'>): Promise<string | null> {
  return resolveCaseProjectId(run.targetId);
}

async function executeRun(run: RunRow) {
  // 走 settings 里的 LLM 配置；provider 未配置/无效或 apiKey 为空时，resolveLlmClient 抛错 → catch 把 error 写回 agent_runs。
  const { client, config } = await resolveLlmClient();
  const logger = (await import('../logger.js')).logger;
  try {
    // 工具白名单随 run.targetId 构建；落库由 step.tools 处理（见 builtinTools.ts）。
    const wf = buildCase2ScriptWorkflow(run.targetId);
    logger.info({ runId: run.id, provider: config.provider, model: config.model }, 'agent run start');
    const result = (await runWorkflow({
      workflowId: wf.workflowId,
      steps: wf.steps,
      llmClient: client,
      initialMessage: run.prompt,
      onEvent: (e) => publishRunEvent(run.id, e),
    })) as unknown[];
    await db
      .update(agentRuns)
      .set({ status: 'success', result: result as object, finishedAt: new Date() })
      .where(eq(agentRuns.id, run.id));
  } catch (e) {
    await db
      .update(agentRuns)
      .set({ status: 'failed', error: e instanceof Error ? e.message : String(e), finishedAt: new Date() })
      .where(eq(agentRuns.id, run.id));
  }
}

agentRunsRoute.get('/', async (req, res) => {
  const rows = await db.select().from(agentRuns).orderBy(desc(agentRuns.startedAt)).limit(50);
  // 按 target 归属项目做可见性过滤（批量解析，避免逐行查询）
  const visiblePids = new Set(await visibleProjectIds(req.user!));
  const caseIds = rows.map((r) => r.targetId);
  const caseProjects = caseIds.length
    ? await db
        .select({ id: testCases.id, projectId: groups.projectId })
        .from(testCases)
        .innerJoin(groups, eq(testCases.groupId, groups.id))
        .where(inArray(testCases.id, caseIds))
    : [];
  const pidByTarget = new Map<string, string>(caseProjects.map((r) => [r.id, r.projectId] as const));
  res.json(rows.filter((r) => visiblePids.has(pidByTarget.get(r.targetId) ?? '')));
});

agentRunsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'agent run not found');
  const run = rows[0]!;
  const pid = await resolveRunProjectId(run);
  if (!pid) throw new HttpError(404, 'not_found', 'agent run not found');
  try {
    await assertProjectVisible(pid, req.user!);
  } catch {
    throw new HttpError(404, 'not_found', 'agent run not found');
  }
  res.json(run);
});

agentRunsRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const pid = await resolveCaseProjectId(body.targetId);
  if (!pid) throw new HttpError(404, 'not_found', 'case not found');
  await assertProjectVisible(pid, req.user!);
  const rows = await db
    .insert(agentRuns)
    .values({ targetType: body.targetType, targetId: body.targetId, status: 'running', prompt: body.prompt })
    .returning();
  const run = rows[0]!;
  void executeRun(run);
  res.json(run);
});

agentRunsRoute.get('/:id/events', async (req, res) => {
  sseHeaders(res);
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, req.params.id));
  if (rows.length === 0) {
    res.end();
    return;
  }
  const run = rows[0]!;
  try {
    const pid = await resolveRunProjectId(run);
    if (!pid) throw new Error('unresolvable');
    await assertProjectVisible(pid, req.user!);
  } catch {
    res.status(404).end();
    return;
  }

  // 已结束的 run：直接补发终态事件后关闭（前端 EventSource 不会收到 step 流，但能拿到最终结果）。
  if (run.status === 'success' || run.status === 'failed') {
    if (run.status === 'success') {
      sseSend(res, { type: 'workflow_complete', runId: run.id, result: run.result });
    } else {
      sseSend(res, { type: 'workflow_error', runId: run.id, error: run.error ?? 'unknown', code: 'unknown' });
    }
    res.end();
    return;
  }

  // 运行中：订阅 runBus，runBus 由 executeRun 在 step_start/step_text/step_complete 时刻写入。
  const unsubscribe = subscribeRun(run.id, res);
  res.on('close', unsubscribe);
});