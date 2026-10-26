/**
 * 批量固化的「在途」判定与进度派生（纯函数，供分组页与单测共用）。
 * 在途状态集合与后端 apps/api/src/execute/batchSolidify.ts 的 RUNNING_BATCH_STATUSES 对齐。
 */

/** 进行中的行状态（与后端 RUNNING_BATCH_STATUSES 一一对应）。 */
export const SOLIDIFY_RUNNING_STATUSES = ['queued', 'solidifying', 'verifying'] as const;

/** 批次行最小形状。 */
export interface SolidifyCaseRef {
  caseId: string;
  status: string;
}

/** 批次最小形状（进度派生用）。 */
export interface SolidifyBatchRef {
  total: number;
  passed: number;
  failed: number;
  running: number;
  cases: SolidifyCaseRef[];
}

/** 该行状态是否在途（已固化完成的终态不算）。 */
export function isSolidifyRunning(status: string): boolean {
  return (SOLIDIFY_RUNNING_STATUSES as readonly string[]).includes(status);
}

/**
 * 在途批次里所有正在跑的用例 id 集合（行内「固化中」徽标用）。
 * 只认在途行——同批次里已 passed / failed 的用例不标。
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
 * 批次完成百分比（已出终态的行 / 总行）。在途行还没出结果，不计入分子。
 * total 为 0 时返回 0。
 */
export function batchProgressPercent(b: SolidifyBatchRef): number {
  if (b.total <= 0) return 0;
  const done = b.passed + b.failed;
  return Math.round((done / b.total) * 100);
}
