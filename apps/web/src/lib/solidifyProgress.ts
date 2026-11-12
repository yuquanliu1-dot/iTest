/**
 * "In-flight" determination and progress derivation for batch solidification (pure functions, shared by the groups page and unit tests).
 * The in-flight status set is aligned with the backend's RUNNING_BATCH_STATUSES in apps/api/src/execute/batchSolidify.ts.
 */

/** In-progress row statuses (one-to-one with the backend's RUNNING_BATCH_STATUSES). */
export const SOLIDIFY_RUNNING_STATUSES = ['queued', 'solidifying', 'verifying'] as const;

/** Minimal shape of a batch row. */
export interface SolidifyCaseRef {
  caseId: string;
  status: string;
}

/** Minimal shape of a batch (for progress derivation). */
export interface SolidifyBatchRef {
  total: number;
  passed: number;
  failed: number;
  running: number;
  cases: SolidifyCaseRef[];
}

/** Whether the row status is in-flight (terminal states of completed solidification don't count). */
export function isSolidifyRunning(status: string): boolean {
  return (SOLIDIFY_RUNNING_STATUSES as readonly string[]).includes(status);
}

/**
 * Set of case ids currently running within in-flight batches (for the in-row "solidifying" badge).
 * Only in-flight rows count — cases already passed / failed in the same batch are not marked.
 */
export function runningCaseIds(batches: SolidifyBatchRef[]): Set<string> {
  const ids = new Set<string>();
  for (const b of batches) {
    for (const c of b.cases) {
      if (isSolidifyRunning(c.status)) ids.add(c.caseId);
    }
  }
  return ids;
}

/**
 * Batch completion percentage (rows with terminal states / total rows). In-flight rows have no result yet and don't enter the numerator.
 * Returns 0 when total is 0.
 */
export function batchProgressPercent(b: SolidifyBatchRef): number {
  if (b.total <= 0) return 0;
  const done = b.passed + b.failed;
  return Math.round((done / b.total) * 100);
}
