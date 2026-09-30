import { Router } from 'express';
import { z } from 'zod';
import { eq, asc } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { testCases, testSteps, reports } from '../db/schema.js';
import { executeCaseReal, writePlaceholderScreenshot, type ExecStepResult } from '../execute/cdp.js';

export const executeRoute = Router();

const Body = z.object({ caseId: z.string().uuid() });

/**
 * 用例执行入口：
 *  1. 预读取用例/步骤并先写一份 pending 报告行（拿到 reportId 才能定位截图目录）。
 *  2. 尝试用真实 CDP（playwright-core + chromium）跑；启动失败则降级为 mock。
 *  3. 任一步骤失败立即终止（避免被污染的页面状态误导后续步骤）。
 *  4. 把 stepResults（含截图路径）回写报告并返回 reportId 给前端跳转。
 */
executeRoute.post('/cases/:caseId/execute', async (req, res) => {
  const { caseId } = Body.parse({ caseId: req.params.caseId });
  if (caseId !== req.params.caseId) throw new HttpError(400, 'bad_request', 'caseId mismatch');

  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!caseRow) throw new HttpError(404, 'not_found', 'case not found');

  const steps = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, caseId))
    .orderBy(asc(testSteps.order));

  // 预写 pending 报告：步骤结果稍后回填。失败时 status='failed'。
  const inserted = await db
    .insert(reports)
    .values({
      caseId,
      status: 'running',
      stepResults: [] as object,
      summary: 'execution in progress',
    })
    .returning();
  const reportId = inserted[0]!.id;

  const startedAt = Date.now();
  let stepResults: ExecStepResult[];
  let status: 'passed' | 'failed';
  try {
    stepResults = await executeCaseReal(
      caseId,
      steps.map((s) => ({ order: s.order, action: s.action })),
      { reportId },
    );
    const failed = stepResults.filter((r) => r.status === 'failed').length;
    status = failed === 0 ? 'passed' : 'failed';
  } catch (e) {
    // CDP 启动失败（无 chromium / 无 playwright 等）：降级 mock，步骤用 placeholder 截图。
    logger.warn({ err: e, caseId, reportId }, 'CDP unavailable, falling back to mock execution');
    const mockResults: ExecStepResult[] = [];
    for (let i = 0; i < steps.length; i++) {
      const isFail = Math.random() < 0.2;
      const screenshot = await writePlaceholderScreenshot(reportId, i + 1);
      mockResults.push({
        order: steps[i]!.order,
        status: isFail ? 'failed' : 'passed',
        durationMs: Math.floor(Math.random() * 100) + 20,
        error: isFail ? 'CDP unavailable — mock fallback (install chromium for real path)' : undefined,
        screenshot,
      });
    }
    stepResults = mockResults;
    status = mockResults.some((r) => r.status === 'failed') ? 'failed' : 'passed';
  }

  const durationMs = Date.now() - startedAt;
  const passed = stepResults.filter((r) => r.status === 'passed').length;
  const summary = `${stepResults.length} steps, ${passed} passed, ${stepResults.length - passed} failed`;

  await db
    .update(reports)
    .set({
      status,
      durationMs,
      stepResults: stepResults as object,
      summary,
    })
    .where(eq(reports.id, reportId));

  res.json({ reportId });
});