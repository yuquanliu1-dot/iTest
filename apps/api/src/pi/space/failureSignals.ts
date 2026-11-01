/**
 * R3.5 失败信号采集（零 LLM）：verify nlAiFail 分流时落一行原始信号。
 * fire-and-forget：INSERT 失败只 warn，绝不影响 verify 主流程（对齐蒸馏 worker 语义）。
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

/** 落一条 nl_ai_fail 信号；productLine 由 project 反查（教训层不做线隔离，仅供审批展示）。 */
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
