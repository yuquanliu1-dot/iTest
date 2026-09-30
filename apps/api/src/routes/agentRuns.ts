import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentRuns } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { runWorkflow } from '../agent/agentFactory.js';
import { resolveLlmClient } from '../agent/llmSettings.js';
import { buildRequirement2CasesWorkflow } from '../agent/workflows/requirement2cases.js';
import { buildCase2ScriptWorkflow } from '../agent/workflows/case2script.js';
import { sseHeaders, sseSend } from '../sse/agentRunStream.js';
import { publishRunEvent, subscribeRun } from '../sse/runBus.js';

export const agentRunsRoute = Router();

const CreateBody = z.object({
  targetType: z.enum(['requirement2cases', 'case2script']),
  targetId: z.string().uuid(),
  prompt: z.string().min(1),
  targetGroupId: z.string().uuid().optional(),
});

type RunRow = typeof agentRuns.$inferSelect;

async function executeRun(run: RunRow, opts: { targetGroupId?: string }) {
  // 走 settings 里的 LLM 配置；未配置 provider 默认为 mock（保持 MVP 启动体验）。
  // 当 provider != mock 且 apiKey 为空时，resolveLlmClient 抛错 → catch 把 error 写回 agent_runs。
  const { client, config } = await resolveLlmClient();
  const logger = (await import('../logger.js')).logger;
  try {
    if (run.targetType === 'requirement2cases' && !opts.targetGroupId) {
      throw new Error('targetGroupId is required for requirement2cases');
    }
    // 工具白名单随 run.targetId 构建；落库由 step.tools 处理（见 builtinTools.ts）。
    const wf = run.targetType === 'requirement2cases'
      ? buildRequirement2CasesWorkflow(run.targetId, opts.targetGroupId ?? '')
      : buildCase2ScriptWorkflow(run.targetId);
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

agentRunsRoute.get('/', async (_req, res) => {
  const rows = await db.select().from(agentRuns).orderBy(desc(agentRuns.startedAt)).limit(50);
  res.json(rows);
});

agentRunsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'agent run not found');
  res.json(rows[0]);
});

agentRunsRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const rows = await db
    .insert(agentRuns)
    .values({ targetType: body.targetType, targetId: body.targetId, status: 'running', prompt: body.prompt })
    .returning();
  const run = rows[0]!;
  void executeRun(run, { targetGroupId: body.targetGroupId });
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
