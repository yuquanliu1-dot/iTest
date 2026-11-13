/**
 * Shared foundation of exploratory-testing sessions: claim / heartbeat / finish / evidence paths / timeout racing.
 *
 * Extracted from execute/exploration.ts — after the exploration execution core moved to the pi tool chain (pi/exploration/runner.ts),
 * these runtime-agnostic orchestration pieces must be shared by both chains as one copy: claim idempotency, the heartbeat window,
 * and the "persist the action trail before setting the final state" finish semantics, once drifted, make cancel/watchdog/detail-page timing behave inconsistently across the two chains.
 */
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { explorationSessions } from '../db/schema.js';
import { recomputeMatrixIntersection } from '../pi/exploration/matrix.js';
import { logger } from '../logger.js';

/** Waiting-side timeout: the race rejects as soon as the deadline hits. The underlying promise settling late never becomes unhandledRejection
 *  (Promise.race attaches handlers to both promises). */
export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function screenshotDiskPath(sessionId: string, order: number): string {
  return join(process.cwd(), 'screenshots', sessionId, `finding-${order}.png`);
}

/** Appends "model reported N / saved M" to the session summary — avoids the self-contradiction of the summary claiming several findings while the DB holds 0. */
export function withFindingCounts(summary: string | null | undefined, modelReported: number, savedCount: number): string | null {
  const base = (summary ?? '').trim();
  if (modelReported === 0) return base || null;
  const note = `模型报告 ${modelReported} 条，落库 ${savedCount} 条`;
  return base ? `${base}（${note}）` : `（${note}）`;
}

/**
 * Per-turn heartbeat: refreshes heartbeat_at (the watchdog uses it to declare zombie sessions dead — a release rebuilds the container → the process is killed →
 * status stays running forever → deletes always 409), and incidentally reads the cancel flag (one SQL round-trip saved).
 */
export async function heartbeat(sessionId: string): Promise<boolean> {
  const row = (await db
    .update(explorationSessions)
    .set({ heartbeatAt: new Date(), updatedAt: new Date() })
    .where(eq(explorationSessions.id, sessionId))
    .returning({ cancelRequested: explorationSessions.cancelRequested }))[0];
  return row?.cancelRequested ?? false;
}

/**
 * Live turn-progress persistence: turns_used used to be written only by finishSession, so a running session's charter card
 * showed 0 forever (the runner's turnCount never reached the DB while the trail kept advancing — the numbers contradicted each
 * other). Written at every turn boundary: one light UPDATE, turns are tens of seconds apart, ≤240 per session. Best-effort —
 * callers fire-and-forget with a swallowed error; finishSession still writes the authoritative final count.
 */
export async function persistTurnProgress(sessionId: string, turnsUsed: number): Promise<void> {
  await db
    .update(explorationSessions)
    .set({ turnsUsed })
    .where(eq(explorationSessions.id, sessionId));
}

/** Idempotent claim: pending → running (atomic conditional update); losers (duplicate job / already deleted) bail directly. */
export async function claimSession(sessionId: string): Promise<boolean> {
  const now = new Date();
  const claimed = await db
    .update(explorationSessions)
    .set({ status: 'running', startedAt: now, heartbeatAt: now, updatedAt: now })
    .where(and(eq(explorationSessions.id, sessionId), eq(explorationSessions.status, 'pending')))
    .returning({ id: explorationSessions.id });
  return claimed.length > 0;
}

export async function finishSession(
  sessionId: string,
  patch: { status: string; summary?: string | null; error?: string | null; turnsUsed: number; usage: unknown },
): Promise<void> {
  await db
    .update(explorationSessions)
    .set({
      status: patch.status,
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      turnsUsed: patch.turnsUsed,
      usage: patch.usage as object,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(explorationSessions.id, sessionId));
  // S2 cross-session intersection: recomputed once a matrix session reaches a final state (fire-and-forget, best-effort; recompute itself never throws).
  // A single session with matrixId null → returns after one light query. Both chains share this one place: the intersection updates as soon as either member finishes.
  const mid = (
    await db
      .select({ matrixId: explorationSessions.matrixId })
      .from(explorationSessions)
      .where(eq(explorationSessions.id, sessionId))
  )[0]?.matrixId;
  if (mid) void recomputeMatrixIntersection(mid).catch((e) => logger.warn({ err: e, matrixId: mid }, 'matrix recompute failed'));
}
