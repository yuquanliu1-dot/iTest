/**
 * Exploration session watchdog: declares dead the stale sessions whose executor is gone but whose status is still running.
 *
 * Scenario (proven by the 2026-11-11 release): rebuilding the api container killed the executor process →
 * the exec worker's catch only logged, never wrote status (execWorker.ts) → the session stayed running forever →
 * delete always 409'd (routes/explorations.ts); users could neither delete it nor see why.
 *
 * Criterion = heartbeat timeout. The heartbeat is refreshed by the runner before each turn (heartbeat() in exploration.ts);
 * the window must be wider than the worst per-turn latency (slow LLM calls), or live sessions get falsely killed.
 * Concurrent sweeps across replicas are harmless: the UPDATE condition includes status='running', so already-judged rows no longer match.
 */
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { explorationSessions } from '../db/schema.js';
import { logger } from '../logger.js';

/** Heartbeat window: no heartbeat for 5 minutes → declared dead (a single LLM call can take 1-2 minutes at worst; 2-3 consecutive slow turns are tolerated without false kills). */
export const EXPLORATION_STALE_MS = 5 * 60_000;

/** Declares dead the stale running sessions; returns how many were killed. */
export async function sweepStaleExplorations(): Promise<number> {
  const cutoff = new Date(Date.now() - EXPLORATION_STALE_MS);
  const stale = await db
    .update(explorationSessions)
    .set({
      status: 'failed',
      error: '执行器中断（心跳超时，会话未正常收尾）——可按同一章程重跑',
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(explorationSessions.status, 'running'),
        or(isNull(explorationSessions.heartbeatAt), lt(explorationSessions.heartbeatAt, cutoff)),
      ),
    )
    .returning({ id: explorationSessions.id });
  if (stale.length > 0) {
    logger.warn({ count: stale.length, cutoff: cutoff.toISOString() }, 'exploration stale sweep marked sessions failed');
  }
  return stale.length;
}

/** Sweep once at startup + once per minute afterwards. unref: doesn't hold up process exit. */
export async function startExplorationSweeper(): Promise<void> {
  try {
    await sweepStaleExplorations();
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'exploration stale sweep failed');
  }
  const timer = setInterval(() => {
    void sweepStaleExplorations().catch((e) => logger.warn({ err: (e as Error).message }, 'exploration stale sweep failed'));
  }, 60_000);
  timer.unref?.();
}
