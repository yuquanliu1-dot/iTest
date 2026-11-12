/**
 * R3.6 session quality signals: metrics computed on the fly from pi-sessions JSONL + suspicion score + collector (zero LLM).
 * Import constraints: only trajectoryParse (pure) + repo.ts (DATA_DIR) + db/schema are allowed;
 * importing pi/space/session.ts (heavy runtime) and scheduler/trajectoryWorker.ts (bullmq) is forbidden —
 * DEFAULT_SESSIONS_ROOT and findSessionFile are re-derived/copied in place (same loop-breaking precedent as the three withLlmTimeout copies).
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

/** Same source as pi/space/session.ts:42 SESSIONS_ROOT (DATA_DIR/pi-sessions). */
export const DEFAULT_SESSIONS_ROOT = join(DATA_DIR, 'pi-sessions');

/** Locate a thread's session file. In the DB, pi_thread_id is the sessionFile full path; bare UUIDs are also accepted (matched by `*_<piThreadId>.jsonl`).
 *  Same copy as trajectoryWorker.ts — this module must not depend back on scheduler (loop breaking). */
export async function findSessionFile(sessionsRoot: string, piThreadId: string): Promise<string | null> {
  if (piThreadId.endsWith('.jsonl')) {
    try {
      await access(piThreadId);
      return piThreadId;
    } catch { /* path invalid (volume migration etc.) → fall back to directory scan */ }
  }
  try {
    const names = await readdir(sessionsRoot);
    const hit = names.find((n) => n.endsWith(`_${piThreadId}.jsonl`));
    return hit ? join(sessionsRoot, hit) : null;
  } catch {
    return null;
  }
}

// ── Metrics + suspicion score (pure functions) ──

export interface SessionMetrics {
  /** Last turn − first turn timestamp; <2 timestamps → null (unknown duration, not scored). */
  durationMs: number | null;
  turns: number;
  toolCallsByName: Record<string, number>;
  toolResultErrors: number;
  verifyCalls: number;
  /** Number of repeated calls with identical name+arguments (the sum of occurrences beyond each first occurrence). */
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

/** Suspicion score (spec §4.3 weight table): tiers don't stack, errors ×2 capped, nlAiFail first +2 then +1 each, capped at 4. */
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

// ── Collector (DB+fs) ──

/** Per-file read cap: >8MB skips and records a note (one of the shared-volume IO guardrails). */
const FILE_SIZE_CAP = 8 * 1024 * 1024;
/** Candidate thread count (top N by updatedAt desc) and sample count (top N by suspicion score). */
const CANDIDATE_CAP = 30;
const SAMPLE_CAP = 12;
/** Session window (days). */
const WINDOW_DAYS = 7;

export interface SessionSignalInput {
  /** Set of refIds already referenced by lessons of any status (computed by failureLessons and passed in — bookkeeping ownership stays with the caller). */
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

/** Session candidate (internal structure: parsed with metrics and score, for ranking and sampling). */
interface SessionCandidate {
  refId: string;
  key: string;
  updatedAt: Date;
  score: number;
  title: string;
  excerpt: string;
}

/**
 * Session signal collection: chat threads from the last 7 days → metrics computed on the fly from JSONL → top 12 by suspicion score.
 * Consumption idempotence: refId = session#<threadId>#<updatedAtEpochMs>; already-consumed threads are excluded before reading files (saves IO).
 * Guardrails: 30 candidates / >8MB skipped with a note / bad lines & missing files silent / top-12 sampling.
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
  // Auxiliary mappings (one batched query, no per-thread N+1): negative-feedback threadId set + nl_ai_fail counts
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
    if (input.consumedRefIds.has(refId)) continue; // excluded before reading the file (saves IO)
    const file = await findSessionFile(input.sessionsRoot ?? DEFAULT_SESSIONS_ROOT, t.piThreadId);
    if (!file) continue; // missing file, skip silently
    let content: string;
    try {
      const st = await stat(file);
      if (st.size > FILE_SIZE_CAP) { notes.push(`会话 ${t.id} 文件超 8MB 跳过`); continue; }
      content = await readFile(file, 'utf8');
    } catch {
      continue; // read failure, skip silently
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
