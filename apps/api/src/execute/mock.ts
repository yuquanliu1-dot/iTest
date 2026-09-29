import { db } from '../db/client.js';
import { testCases, testSteps, reports } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { writePlaceholderScreenshot } from './screenshot.js';

export async function mockExecuteCase(caseId: string): Promise<{ reportId: string }> {
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!caseRow) throw new Error('case not found');
  const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
  const startedAt = Date.now();
  const tempResults: Array<{ order: number; status: string; durationMs: number; error?: string }> = [];
  let failed = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const isFail = Math.random() < 0.2;
    if (isFail) failed++;
    tempResults.push({
      order: step.order,
      status: isFail ? 'failed' : 'passed',
      durationMs: Math.floor(Math.random() * 100) + 20,
      error: isFail ? 'mock failure (CDP not wired in MVP)' : undefined,
    });
  }
  const durationMs = Date.now() - startedAt;
  const status = failed === 0 ? 'passed' : 'failed';
  const inserted = await db
    .insert(reports)
    .values({
      caseId,
      status,
      durationMs,
      stepResults: tempResults as object,
      summary: `${steps.length} steps, ${steps.length - failed} passed, ${failed} failed`,
    })
    .returning();
  const reportId = inserted[0]!.id;
  const realResults = await Promise.all(
    tempResults.map(async (r, i) => ({
      ...r,
      screenshot: await writePlaceholderScreenshot(reportId, i + 1),
    })),
  );
  await db.update(reports).set({ stepResults: realResults as object }).where(eq(reports.id, reportId));
  return { reportId };
}
