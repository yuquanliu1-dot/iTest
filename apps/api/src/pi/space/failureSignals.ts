/**
 * R3.5 failure-signal collection (zero LLM): records one raw signal row when verify routes an
 * nlAiFail. Fire-and-forget: an INSERT failure only warns, never affects the verify main flow
 * (same semantics as the distillation worker).
 */
import { eq } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { db } from '../../db/client.js';
import { assistantFailureSignals, projects } from '../../db/schema.js';

export interface NlAiFailSignalPayload {
  caseTitle: string;
  stepInstruction: string;
  failureReason: string;
  targetUrl: string | null;
  pageUrl: string | null;
}

/** Records one nl_ai_fail signal; productLine is looked up from the project (the lesson layer does not isolate by line; for approval display only). */
export async function recordNlAiFailSignal(input: {
  threadId: string;
  projectId: string;
  caseId: string;
  stepOrder: number;
  payload: NlAiFailSignalPayload;
}): Promise<void> {
  try {
    const project = (await db.select({ productLineId: projects.productLineId }).from(projects)
      .where(eq(projects.id, input.projectId)).limit(1))[0];
    await db.insert(assistantFailureSignals).values({
      type: 'nl_ai_fail',
      threadId: input.threadId,
      caseId: input.caseId,
      stepOrder: input.stepOrder,
      productLineId: project?.productLineId ?? null,
      payload: input.payload,
    }).onConflictDoNothing();
  } catch (e) {
    logger.warn({ err: e }, 'failureSignals: record nl_ai_fail signal failed');
  }
}
