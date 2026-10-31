/**
 * 轨迹蒸馏 worker：定位会话 JSONL → 判据核实（verify_case 成功链）→ LLM 蒸馏 → 入库。
 * 失败语义（设计 §4.2）：LLM 超时/输出不合法/文件缺失/项目未归线 → 丢弃 + warn，不重试
 * 不阻塞（transcript 仍在卷上，R3 可重蒸）。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { z } from 'zod';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { aiThreads, testCases, testSteps } from '../db/schema.js';
import { SESSIONS_ROOT } from '../pi/space/session.js';
import { resolveProductLineId } from '../pi/space/memories.js';
import { insertTrajectory } from '../pi/space/trajectories.js';
import { resolveVersionProjectId } from '../services/projectAccess.js';
import { readLlmConfig } from '../pi/modelBridge.js';
import { completeJson, getLlmClient, type LLMClient } from '../agent/llm-client.js';
import { buildTrajectoryWorker, type TrajectoryJob } from './trajectoryQueue.js';
import { compressConversation, findVerifiedLocalIds, parseSessionJsonl } from './trajectoryParse.js';

const DISTILL_SYSTEM_PROMPT = `你是测试轨迹蒸馏器。输入是一次「为用户创建测试用例」的助手会话压缩流与最终落库的用例形态。产出一条可复用的成功轨迹 exemplar，供同产品线后续相似任务 few-shot。

输出只含 JSON（不要 markdown 围栏）：
{"task_title":"…","task_keywords":"…","digest":"…"}

字段要求：
- task_title：≤60 字的人话任务指纹——什么类型的被测任务（页面/动作/断言要点），例如「SOC 事件管理列表页——筛选后导出 Excel」。不要含用例标题原文照抄。
- task_keywords：空格分隔的检索关键词（8~15 个词，覆盖页面名、功能、动作、断言对象）。
- digest：markdown，固定五段骨架，每段 1~4 行：
  ## 任务描述
  ## 环境事实（URL/账号/入口等会话中实际用到的）
  ## 关键决策（步骤怎么拆、断言怎么定、踩过什么坑怎么修的——从工具结果与修正过程提炼）
  ## 最终用例形态（步骤序列与断言要点概括）
  ## verify 证据（实测结果一句话）
只依据输入材料，禁止臆造输入中没有的行为或结论。`;

const DistillOutput = z.object({
  task_title: z.string().min(1).max(200),
  task_keywords: z.string().min(1),
  digest: z.string().min(1),
});

/** 定位线程会话文件：SESSIONS_ROOT 下 `*_<piThreadId>.jsonl`。 */
export async function findSessionFile(sessionsRoot: string, piThreadId: string): Promise<string | null> {
  try {
    const names = await readdir(sessionsRoot);
    const hit = names.find((n) => n.endsWith(`_${piThreadId}.jsonl`));
    return hit ? join(sessionsRoot, hit) : null;
  } catch {
    return null;
  }
}

/** 用例最终形态（DB 读）：标题/预期/步骤指令序列。 */
async function buildCaseShape(caseId: string): Promise<string> {
  const c = (await db.select().from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!c) return '（用例已不存在）';
  const steps = await db.select({ order: testSteps.order, instruction: testSteps.instruction })
    .from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
  const stepLines = steps.map((s) => `${s.order + 1}. ${s.instruction ?? '（机械步骤）'}`).join('\n');
  return `【最终用例】\n标题：${c.title}\n预期结果：${c.expectedOutcome ?? '（无）'}\n步骤：\n${stepLines}`;
}

export interface TrajectoryJobDeps {
  client: LLMClient;
  sessionsRoot?: string;
}

/** 核心：判据核实 → 蒸馏 → 入库。client/sessionsRoot 可注入（测试）。 */
export async function processTrajectoryJob(data: TrajectoryJob, deps: TrajectoryJobDeps): Promise<void> {
  const thread = (await db.select({ piThreadId: aiThreads.piThreadId }).from(aiThreads).where(eq(aiThreads.id, data.threadId)).limit(1))[0];
  if (!thread) { logger.warn({ threadId: data.threadId }, 'trajectory: thread not found; skip'); return; }
  const file = await findSessionFile(deps.sessionsRoot ?? SESSIONS_ROOT, thread.piThreadId);
  if (!file) { logger.warn({ threadId: data.threadId }, 'trajectory: session file missing; skip'); return; }
  const turns = parseSessionJsonl(await readFile(file, 'utf8'));
  const verified = findVerifiedLocalIds(turns, data.items.map((i) => i.localId));
  const items = data.items.filter((i) => verified.has(i.localId));
  if (items.length === 0) { logger.info({ threadId: data.threadId }, 'trajectory: no verified items; skip'); return; }
  const projectId = await resolveVersionProjectId(data.versionId);
  const lineId = projectId ? await resolveProductLineId(projectId) : null;
  if (!projectId || !lineId) { logger.warn({ versionId: data.versionId }, 'trajectory: product line unresolved (项目未归线?); skip'); return; }
  const conv = compressConversation(turns);
  for (const item of items) {
    try {
      const r = await completeJson(deps.client, {
        systemPrompt: DISTILL_SYSTEM_PROMPT,
        userMessage: `${conv}\n\n${await buildCaseShape(item.caseId)}`,
      });
      const parsed = DistillOutput.safeParse(r.value);
      if (!parsed.success) {
        logger.warn({ threadId: data.threadId, caseId: item.caseId, issues: parsed.error.issues.length }, 'trajectory: distill output invalid; drop item');
        continue;
      }
      const inserted = await insertTrajectory({
        productLineId: lineId,
        taskTitle: parsed.data.task_title.slice(0, 200),
        taskKeywords: parsed.data.task_keywords,
        digest: parsed.data.digest,
        caseTitle: (await db.select({ title: testCases.title }).from(testCases).where(eq(testCases.id, item.caseId)).limit(1))[0]?.title?.slice(0, 200) ?? '（未知用例）',
        status: 'active',
        sourceThreadId: data.threadId,
        sourceCaseId: item.caseId,
        sourceProjectId: projectId,
        sourceVersionId: data.versionId,
        createdByUserId: data.userId,
        distillModel: r.model ?? 'unknown',
      });
      if (inserted) logger.info({ threadId: data.threadId, caseId: item.caseId }, 'trajectory: distilled and stored');
      else logger.info({ caseId: item.caseId }, 'trajectory: duplicate (active row exists); skipped');
    } catch (e) {
      logger.warn({ err: e, caseId: item.caseId }, 'trajectory: distill failed; drop item');
    }
  }
}

/** inline 路径：settings 建 client（未配置 → warn 跳过）。 */
export async function processTrajectoryJobInline(data: TrajectoryJob): Promise<void> {
  const cfg = await readLlmConfig();
  if (!cfg) { logger.warn('trajectory: LLM not configured; skip inline distill'); return; }
  await processTrajectoryJob(data, { client: getLlmClient({ provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl ?? undefined }) });
}

let _worker: Worker<TrajectoryJob> | null = null;

/** API 进程启动时调用（index.ts）。无 REDIS → inline 模式（enqueue 直接跑），不建 worker。 */
export async function startTrajectoryWorker(): Promise<void> {
  if (!process.env.REDIS_URL) {
    logger.info('REDIS_URL not set; trajectory queue inline mode');
    return;
  }
  try {
    const cfg = await readLlmConfig();
    if (!cfg) { logger.info('trajectory: LLM not configured; worker not started'); return; }
    const client = getLlmClient({ provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl ?? undefined });
    _worker = buildTrajectoryWorker((job) => processTrajectoryJob(job, { client }));
    _worker.on('ready', () => logger.info('trajectory worker ready'));
    _worker.on('error', (err) => logger.warn({ err: err.message }, 'trajectory worker error'));
    _worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message }, 'trajectory job failed'));
    logger.info('trajectory worker started');
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'trajectory worker init failed; continuing inline');
    _worker = null;
  }
}
