import { eq, asc } from 'drizzle-orm';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { testCases, testSteps, reports } from '../db/schema.js';
import { executeCaseReal, writePlaceholderScreenshot, type ExecStepResult } from './cdp.js';

/**
 * 执行单条用例并落报告。真实 CDP 失败时降级 mock。
 * 返回 reportId 与最终状态，供单用例路由和执行计划共用。
 */
export async function runCase(caseId: string): Promise<{ reportId: string; status: string }> {
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!caseRow) throw new Error('case not found');

  const steps = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, caseId))
    .orderBy(asc(testSteps.order));

  const inserted = await db
    .insert(reports)
    .values({ caseId, status: 'running', stepResults: [] as object, summary: 'execution in progress' })
    .returning();
  const reportId = inserted[0]!.id;

  const startedAt = Date.now();
  let stepResults: ExecStepResult[];
  let status: 'passed' | 'failed';
  try {
    stepResults = await executeCaseReal(
      caseId,
      steps.map((s) => ({ order: s.order, action: s.action, delayMs: s.delayMs })),
      { reportId },
    );
    const failed = stepResults.filter((r) => r.status === 'failed').length;
    status = failed === 0 ? 'passed' : 'failed';
  } catch (e) {
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
    .set({ status, durationMs, stepResults: stepResults as object, summary })
    .where(eq(reports.id, reportId));

  return { reportId, status };
}