/**
 * verify_case 实测轨迹缓存：full 模式 AI 相顺带收集的逐步动作轨迹，供 solidify_case
 * 在步骤内容未变时零执行完成固化（1 次 AI 执行 + 1 次机械执行的提速关键）。
 *
 * 中性模块：不 import verifyCase/solidifyCase（两者已有 solidify→verify 单向依赖，反向会成环）。
 * 生命周期与 verifyConfirmCache 同模式：进程内 Map + 粘性路由（nginx ip_hash）保证同线程
 * verify→solidify 命中同副本；副本重启/重排丢失时 solidify 自动回退真实执行，仅损失性能。
 * 新鲜度 = 逐步哈希 + 元哈希逐元素相等（与 verify 前缀确认同一套哈希函数）+ TTL 30min。
 */
import { createHash } from 'node:crypto';
import type { AiAction } from '../../../execute/aiTask.js';
import type { EffectiveStep } from './case-ops-tools.js';

/** 逐步骤语义哈希：覆盖该步 AI 相的全部输入，其一变化即轨迹失效（与 verifyCase 前缀确认共用语义）。 */
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

/** 环境绑定哈希：URL/默认环境/版本任一变化＝换被测对象，轨迹全部失效。刻意排除 expectedOutcome/title。 */
export function hashVerifyMeta(m: { url: string | null; defaultEnvId: string | null; versionId: string | null }): string {
  return createHash('sha1').update(JSON.stringify([m.url, m.defaultEnvId, m.versionId])).digest('hex');
}

export interface VerifiedTraceEntry {
  stepsHash: string[];
  metaHash: string;
  /** stepId → 该步骤收集到的成功 AI 动作（按执行顺序；空数组 = 步骤通过但无可映射动作）。 */
  trace: Map<string, AiAction[]>;
  savedAt: number;
}

const TRACE_TTL_MS = 30 * 60 * 1000; // 与 loginStateCache 对齐：实测→固化的间隔通常在分钟级
const TRACE_MAX_ENTRIES = 64;

const verifyTraceCache = new Map<string, VerifiedTraceEntry>();

export function traceKey(threadId: string, caseId: string): string {
  return `${threadId}::${caseId}`;
}

export function saveVerifiedTrace(key: string, stepsHash: string[], metaHash: string, trace: Map<string, AiAction[]>): void {
  if (verifyTraceCache.size >= TRACE_MAX_ENTRIES) {
    // 淘汰最旧：线程数有限、正常流转会被覆盖写入，超限属长会话堆积的兜底
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

/** 取新鲜轨迹：哈希逐元素相等 + requiredStepIds 全部在册 + 未过 TTL；任一不满足删条目返 null。 */
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

/** 只读窥视（测试用）。 */
export function getVerifiedTrace(key: string): VerifiedTraceEntry | null {
  return verifyTraceCache.get(key) ?? null;
}
