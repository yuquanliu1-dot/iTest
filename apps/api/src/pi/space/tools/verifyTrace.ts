/**
 * verify_case live-test trace cache: the per-step action traces collected along the way by full mode's AI phase, letting solidify_case
 * finish solidification with zero execution when step content is unchanged (the key to the 1 AI execution + 1 mechanical execution speedup).
 *
 * Neutral module: doesn't import verifyCase/solidifyCase (they already have a solidify→verify one-way dependency; the reverse would form a cycle).
 * Lifecycle follows the same pattern as verifyConfirmCache: in-process Map + sticky routing (nginx ip_hash) guarantees the same thread's
 * verify→solidify hits the same replica; on replica restart/re-shuffle loss, solidify automatically falls back to real execution, only losing performance.
 * Freshness = per-step hash + meta hash element-wise equality (the same hash functions as verify prefix confirmation) + 30min TTL.
 */
import { createHash } from 'node:crypto';
import type { AiAction } from '../../../execute/aiTask.js';
import type { EffectiveStep } from './case-ops-tools.js';

/** Per-step semantic hash: covers all of the step's AI-phase inputs; any change invalidates the trace (shares semantics with verifyCase's prefix confirmation). */
export function hashEffectiveSteps(steps: EffectiveStep[]): string[] {
  return steps.map((s) =>
    createHash('sha1')
      .update(
        JSON.stringify({
          inst: s.instruction,
          compiled: s.compiled,
          assertion: s.assertion,
          sensitive: s.sensitive,
          delayMs: s.delayMs,
        }),
      )
      .digest('hex'),
  );
}

/** Environment-binding hash: any change to URL/default environment/version = a different test target, invalidating all traces. expectedOutcome/title deliberately excluded. */
export function hashVerifyMeta(m: { url: string | null; defaultEnvId: string | null; versionId: string | null }): string {
  return createHash('sha1').update(JSON.stringify([m.url, m.defaultEnvId, m.versionId])).digest('hex');
}

export interface VerifiedTraceEntry {
  stepsHash: string[];
  metaHash: string;
  /** stepId → successful AI actions collected for that step (in execution order; empty array = step passed but had no mappable actions). */
  trace: Map<string, AiAction[]>;
  savedAt: number;
}

const TRACE_TTL_MS = 30 * 60 * 1000; // Aligned with loginStateCache: the live-test→solidify gap is usually minutes
const TRACE_MAX_ENTRIES = 64;

const verifyTraceCache = new Map<string, VerifiedTraceEntry>();

export function traceKey(threadId: string, caseId: string): string {
  return `${threadId}::${caseId}`;
}

export function saveVerifiedTrace(key: string, stepsHash: string[], metaHash: string, trace: Map<string, AiAction[]>): void {
  if (verifyTraceCache.size >= TRACE_MAX_ENTRIES) {
    // Evict the oldest: the thread count is bounded and normal flow overwrites entries; hitting the cap is long-session pileup fallback
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of verifyTraceCache) {
      if (v.savedAt < oldestAt) {
        oldestAt = v.savedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) verifyTraceCache.delete(oldestKey);
  }
  verifyTraceCache.set(key, { stepsHash, metaHash, trace, savedAt: Date.now() });
}

export function clearVerifiedTrace(key: string): void {
  verifyTraceCache.delete(key);
}

/** Take a fresh trace: hash element-wise equality + all requiredStepIds on record + within TTL; any miss deletes the entry and returns null. */
export function takeFreshTrace(
  key: string,
  stepsHash: string[],
  metaHash: string,
  requiredStepIds: string[],
): Map<string, AiAction[]> | null {
  const entry = verifyTraceCache.get(key);
  if (!entry) return null;
  const stale =
    entry.metaHash !== metaHash ||
    entry.stepsHash.length !== stepsHash.length ||
    entry.stepsHash.some((h, i) => h !== stepsHash[i]) ||
    requiredStepIds.some((id) => !entry.trace.has(id)) ||
    Date.now() - entry.savedAt > TRACE_TTL_MS;
  if (stale) {
    verifyTraceCache.delete(key);
    return null;
  }
  return entry.trace;
}

/** Read-only peek (for tests). */
export function getVerifiedTrace(key: string): VerifiedTraceEntry | null {
  return verifyTraceCache.get(key) ?? null;
}
