/**
 * R3.6 会话质量信号：pi-sessions JSONL 现算指标 + 嫌疑分 + 采集器（零 LLM）。
 * import 约束：只许 trajectoryParse（纯）+ repo.ts（DATA_DIR）+ db/schema；
 * 禁止 import pi/space/session.ts（重型运行时）与 scheduler/trajectoryWorker.ts（bullmq）——
 * DEFAULT_SESSIONS_ROOT 与 findSessionFile 就地重推导/复制（与 withLlmTimeout 三处复制同为断环先例）。
 */
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  aiAssistantFeedback, aiThreads, assistantFailureSignals,
} from '../../db/schema.js';
import { DATA_DIR } from '../repo.js';
import { compressConversation, parseSessionJsonl, type ParsedTurn } from '../../scheduler/trajectoryParse.js';

/** 与 pi/space/session.ts:42 SESSIONS_ROOT 同源（DATA_DIR/pi-sessions）。 */
export const DEFAULT_SESSIONS_ROOT = join(DATA_DIR, 'pi-sessions');

/** 定位线程会话文件。DB 里 pi_thread_id 是 sessionFile 完整路径；兼容裸 UUID（按 `*_<piThreadId>.jsonl` 匹配）。
 *  trajectoryWorker.ts 同款复制——本模块不得反向依赖 scheduler（断环）。 */
export async function findSessionFile(sessionsRoot: string, piThreadId: string): Promise<string | null> {
  if (piThreadId.endsWith('.jsonl')) {
    try {
      await access(piThreadId);
      return piThreadId;
    } catch { /* 路径失效（卷迁移等）→ 落回目录扫描 */ }
  }
  try {
    const names = await readdir(sessionsRoot);
    const hit = names.find((n) => n.endsWith(`_${piThreadId}.jsonl`));
    return hit ? join(sessionsRoot, hit) : null;
  } catch {
    return null;
  }
}

// ── 指标 + 嫌疑分（纯函数）──

export interface SessionMetrics {
  /** 末轮 - 首轮 timestamp；<2 个 timestamp → null（时长未知不计分）。 */
  durationMs: number | null;
  turns: number;
  toolCallsByName: Record<string, number>;
  toolResultErrors: number;
  verifyCalls: number;
  /** 同 name+arguments 完全相同的重复调用次数（超出首现的次数之和）。 */
  repeatedIdenticalToolCalls: number;
}

export function computeSessionMetrics(turns: ParsedTurn[]): SessionMetrics {
  const toolCallsByName: Record<string, number> = {};
  let toolResultErrors = 0;
  let stampCount = 0;
  let minTs: number | undefined;
  let maxTs: number | undefined;
  const identicalCounts = new Map<string, number>();
  for (const t of turns) {
    if (t.timestamp != null) {
      stampCount += 1;
      minTs = minTs === undefined ? t.timestamp : Math.min(minTs, t.timestamp);
      maxTs = maxTs === undefined ? t.timestamp : Math.max(maxTs, t.timestamp);
    }
    if (t.role === 'assistant') {
      for (const c of t.toolCalls) {
        toolCallsByName[c.name] = (toolCallsByName[c.name] ?? 0) + 1;
        const k = `${c.name}\u0000${JSON.stringify(c.arguments)}`;
        identicalCounts.set(k, (identicalCounts.get(k) ?? 0) + 1);
      }
    } else if (t.role === 'toolResult' && t.isError === true) {
      toolResultErrors += 1;
    }
  }
  let repeatedIdenticalToolCalls = 0;
  for (const n of identicalCounts.values()) if (n > 1) repeatedIdenticalToolCalls += n - 1;
  return {
    durationMs: stampCount >= 2 && minTs !== undefined && maxTs !== undefined ? maxTs - minTs : null,
    turns: turns.length,
    toolCallsByName,
    toolResultErrors,
    verifyCalls: toolCallsByName['verify_case'] ?? 0,
    repeatedIdenticalToolCalls,
  };
}

/** 嫌疑分（spec §4.3 权重表）：分档不叠加，错误 ×2 封顶，nlAiFail 首条 +2 每多 +1 封顶 4。 */
export function sessionSuspicionScore(
  m: SessionMetrics,
  ctx: { negativeFeedback: boolean; nlAiFailCount: number },
): number {
  let s = 0;
  if (m.durationMs != null) {
    const min = m.durationMs / 60_000;
    if (min >= 30) s += 3;
    else if (min >= 10) s += 2;
  }
  if (m.verifyCalls >= 6) s += 4;
  else if (m.verifyCalls >= 3) s += 2;
  s += Math.min(4, m.toolResultErrors * 2);
  if (m.repeatedIdenticalToolCalls >= 2) s += 2;
  if (m.turns >= 20) s += 1;
  if (ctx.negativeFeedback) s += 3;
  if (ctx.nlAiFailCount > 0) s += Math.min(4, 2 + (ctx.nlAiFailCount - 1));
  return s;
}

// ── 采集器（DB+fs）──

/** 单文件读取上限：>8MB 跳过记 note（共享卷 IO 护栏之一）。 */
const FILE_SIZE_CAP = 8 * 1024 * 1024;
/** 候选线程数（updatedAt desc 取前 N）与选样数（嫌疑分 top N）。 */
const CANDIDATE_CAP = 30;
const SAMPLE_CAP = 12;
/** 会话窗口（天）。 */
const WINDOW_DAYS = 7;

export interface SessionSignalInput {
  /** 已被任意 status 教训引用的 refId 集合（failureLessons 计算好传入——记账所有权留在调用方）。 */
  consumedRefIds: ReadonlySet<string>;
  sessionsRoot?: string;
  now?: Date;
}

export interface CollectedSessionSignal {
  key: string;
  refId: string;
  title: string;
  excerpt: string;
  time: string;
}

/** 会话候选（内部结构：解析后带指标与分数，供排序选样）。 */
interface SessionCandidate {
  refId: string;
  key: string;
  updatedAt: Date;
  score: number;
  title: string;
  excerpt: string;
}

/**
 * 会话信号采集：近 7 天 chat 线程 → JSONL 现算指标 → 嫌疑分 top12。
 * 消费幂等：refId = session#<threadId>#<updatedAtEpochMs>，已消费线程读文件前剔除（省 IO）。
 * 护栏：30 候选 / >8MB 跳过记 note / 坏行缺文件静默 / top12 选样。
 */
export async function collectSessionSignals(input: SessionSignalInput): Promise<{ signals: CollectedSessionSignal[]; notes: string[] }> {
  const now = input.now ?? new Date();
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const threads = await db
    .select({ id: aiThreads.id, piThreadId: aiThreads.piThreadId, updatedAt: aiThreads.updatedAt })
    .from(aiThreads)
    .where(and(eq(aiThreads.purpose, 'chat'), gte(aiThreads.updatedAt, windowStart), sql`${aiThreads.piThreadId} <> ''`))
    .orderBy(desc(aiThreads.updatedAt))
    .limit(CANDIDATE_CAP);

  const notes: string[] = [];
  // 辅助映射（一次性批量查，不做 per-thread N+1）：负反馈 threadId 集合 + nl_ai_fail 计数
  const negThreads = new Set(
    (await db.select({ threadId: aiAssistantFeedback.threadId }).from(aiAssistantFeedback)
      .where(eq(aiAssistantFeedback.sentiment, 'negative'))).map((r) => r.threadId),
  );
  const nlAiFailCounts = new Map<string, number>(
    (await db.select({ threadId: assistantFailureSignals.threadId, n: sql<number>`count(*)::int` })
      .from(assistantFailureSignals)
      .where(eq(assistantFailureSignals.type, 'nl_ai_fail'))
      .groupBy(assistantFailureSignals.threadId)).map((r) => [r.threadId, r.n]),
  );
  const candidates: SessionCandidate[] = [];
  for (const t of threads) {
    const refId = `session#${t.id}#${t.updatedAt.getTime()}`;
    if (input.consumedRefIds.has(refId)) continue; // 读文件前剔除（省 IO）
    const file = await findSessionFile(input.sessionsRoot ?? DEFAULT_SESSIONS_ROOT, t.piThreadId);
    if (!file) continue; // 缺文件静默跳
    let content: string;
    try {
      const st = await stat(file);
      if (st.size > FILE_SIZE_CAP) { notes.push(`会话 ${t.id} 文件超 8MB 跳过`); continue; }
      content = await readFile(file, 'utf8');
    } catch {
      continue; // 读失败静默跳
    }
    const turns = parseSessionJsonl(content);
    if (turns.length === 0) continue;
    const metrics = computeSessionMetrics(turns);
    const score = sessionSuspicionScore(metrics, {
      negativeFeedback: negThreads.has(t.id),
      nlAiFailCount: nlAiFailCounts.get(t.id) ?? 0,
    });
    const min = metrics.durationMs != null ? Math.round(metrics.durationMs / 60_000) : null;
    candidates.push({
      refId,
      key: refId,
      updatedAt: t.updatedAt,
      score,
      title: `会话 ${metrics.turns} 轮${min != null ? `/${min}min` : ''} · verify ${metrics.verifyCalls} 次 · 工具错误 ${metrics.toolResultErrors}`,
      excerpt: [
        `时长=${min != null ? `${min}min` : '?'} 轮数=${metrics.turns} verify=${metrics.verifyCalls} 工具错误=${metrics.toolResultErrors} 重复调用=${metrics.repeatedIdenticalToolCalls} 嫌疑分=${score}`,
        compressConversation(turns, 2_000),
      ].join('\n'),
    });
  }

  const signals = candidates
    .sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, SAMPLE_CAP)
    .map((c) => ({ key: c.key, refId: c.refId, title: c.title, excerpt: c.excerpt, time: c.updatedAt.toISOString() }));
  return { signals, notes };
}
