import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentRuns, requirements, testCases, testSteps } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { runWorkflow } from '../agent/agentFactory.js';
import { getLlmClient } from '../agent/llm-client.js';
import { requirement2CasesWorkflow } from '../agent/workflows/requirement2cases.js';
import { case2ScriptWorkflow } from '../agent/workflows/case2script.js';
import { sseHeaders, sseSend } from '../sse/agentRunStream.js';
import { StepAction } from '@itest/shared';

export const agentRunsRoute = Router();

const CreateBody = z.object({
  targetType: z.enum(['requirement2cases', 'case2script']),
  targetId: z.string().uuid(),
  prompt: z.string().min(1),
});

type RunRow = typeof agentRuns.$inferSelect;

async function executeRun(run: RunRow) {
  const client = getLlmClient({ provider: 'mock', apiKey: '', model: '' });
  const wf = run.targetType === 'requirement2cases' ? requirement2CasesWorkflow : case2ScriptWorkflow;
  try {
    const result = (await runWorkflow({
      workflowId: wf.workflowId,
      steps: wf.steps,
      llmClient: client,
      initialMessage: run.prompt,
      onEvent: () => {},
    })) as unknown[];
    await db
      .update(agentRuns)
      .set({ status: 'success', result: result as object, finishedAt: new Date() })
      .where(eq(agentRuns.id, run.id));
    if (run.targetType === 'requirement2cases') {
      const reqData = (await db.select().from(requirements).where(eq(requirements.id, run.targetId)))[0];
      const finalJson = result.find((r) => r && typeof r === 'object' && 'cases' in (r as object)) as
        | {
            cases?: Array<{ title: string; description?: string; priority?: string; steps?: Array<{ order: number; action: unknown }> }>;
          }
        | undefined;
      if (reqData && finalJson?.cases) {
        for (const c of finalJson.cases) {
          const caseRows = await db
            .insert(testCases)
            .values({
              requirementId: reqData.id,
              title: c.title,
              description: c.description,
              priority: (c.priority ?? 'P1') as 'P0' | 'P1' | 'P2' | 'P3',
            })
            .returning();
          if (c.steps && c.steps.length > 0) {
            await db.insert(testSteps).values(
              c.steps.map((s) => {
                StepAction.parse(s.action);
                return {
                  caseId: caseRows[0]!.id,
                  order: s.order,
                  source: 'agent' as const,
                  action: s.action as object,
                };
              }),
            );
          }
        }
      }
    }
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
  const poll = setInterval(async () => {
    const current = (await db.select().from(agentRuns).where(eq(agentRuns.id, req.params.id)))[0];
    if (!current) {
      clearInterval(poll);
      res.end();
      return;
    }
    if (current.status === 'success') {
      clearInterval(poll);
      sseSend(res, { type: 'workflow_complete', runId: current.id, result: current.result });
      res.end();
    } else if (current.status === 'failed') {
      clearInterval(poll);
      sseSend(res, { type: 'workflow_error', runId: current.id, error: current.error ?? 'unknown', code: 'unknown' });
      res.end();
    }
  }, 200);
  res.on('close', () => clearInterval(poll));
});
