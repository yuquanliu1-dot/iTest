/**
 * verify_case 跨轮浏览器保活注册表：同 thread+case 连续 verify_case 轮次复用同一
 * browser/context/page，已确认前缀零重放零 restore（浏览器停在上一轮终态页直接续跑新步）。
 *
 * 生命周期与 verifyConfirmCache/verifyTraceCache 同模式：进程内 Map + 粘性路由（nginx ip_hash）
 * 保证同线程 verify 轮次命中同副本；副本重启/容器重建硬杀浏览器，下轮 acquire 探测
 * isConnected 失败自动降级现有 fresh+restore 路径，仅损失性能不损失正确性。
 * 同线程全局串行（session.ts Redis itest:thread-run 锁）保证同一 key 不会并发两轮——
 * 注册表只存「轮与轮之间」的空闲浏览器，在途轮的浏览器不进注册表，淘汰不会误伤。
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';

/** 空闲保活时长：实测→下一步输入的讨论间隔通常在分钟级，20min 覆盖正常讨论节奏。 */
const SESSION_TTL_MS = 20 * 60 * 1000;
/** 单副本同时保活的 chromium 上限（实例 ~300MB；超限淘汰最旧）。 */
const MAX_SESSIONS = 2;
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface BrowserSessionRefs {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

interface BrowserSessionRecord extends BrowserSessionRefs {
  metaHash: string;
  /** 浏览器当前页面状态已生效的步骤哈希前缀（curStepsHash.slice(0, appliedCount)）。 */
  appliedHashes: string[];
  lastUsedAt: number;
}

const sessions = new Map<string, BrowserSessionRecord>();

/** 命中探测：过期/浏览器断连/页面已关/env 失配/前缀步被编辑，任一即销毁降级返回 null。 */
export function acquire(
  key: string,
  metaHash: string,
  curStepsHash: string[],
): (BrowserSessionRefs & { appliedCount: number }) | null {
  const rec = sessions.get(key);
  if (!rec) return null;
  const stale =
    Date.now() - rec.lastUsedAt > SESSION_TTL_MS ||
    rec.metaHash !== metaHash ||
    !isPrefix(rec.appliedHashes, curStepsHash) ||
    !rec.browser.isConnected() ||
    rec.page.isClosed();
  if (stale) {
    destroy(key, rec);
    return null;
  }
  rec.lastUsedAt = Date.now();
  return { browser: rec.browser, context: rec.context, page: rec.page, appliedCount: rec.appliedHashes.length };
}

function isPrefix(prefix: string[], full: string[]): boolean {
  return prefix.length <= full.length && prefix.every((h, i) => h === full[i]);
}

/** 轮末上册（复用轮与新建轮统一入口）：upsert + touch；超限淘汰最旧（不含本次 key）。 */
export function commit(key: string, refs: BrowserSessionRefs, metaHash: string, appliedHashes: string[]): void {
  if (!sessions.has(key) && sessions.size >= MAX_SESSIONS) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of sessions) {
      if (v.lastUsedAt < oldestAt) {
        oldestAt = v.lastUsedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) destroy(oldestKey, sessions.get(oldestKey));
  }
  sessions.set(key, { ...refs, metaHash, appliedHashes, lastUsedAt: Date.now() });
  ensureSweep();
}

/** 下册并关浏览器（close 失败吞错——进程即将舍弃该实例）；幂等。 */
export function invalidate(key: string): void {
  const rec = sessions.get(key);
  if (!rec) return;
  destroy(key, rec);
}

function destroy(key: string, rec: BrowserSessionRecord | undefined): void {
  sessions.delete(key);
  if (rec) void rec.browser.close().catch(() => undefined);
}

let sweepTimer: NodeJS.Timeout | null = null;
/** 周期清扫过期会话（懒检查的兜底；空闲进程也回收 chromium）。 */
function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/** 清扫过期记录（导出供测试手动触发）。 */
export function sweepOnce(): void {
  const now = Date.now();
  for (const [k, rec] of sessions) {
    if (now - rec.lastUsedAt > SESSION_TTL_MS) destroy(k, rec);
  }
}

/** 只读窥视（测试用）。 */
export function peekSession(key: string): BrowserSessionRecord | null {
  return sessions.get(key) ?? null;
}

/** 清空全部会话（测试隔离用；生产不应调用）。 */
export function resetForTest(): void {
  for (const [k, rec] of sessions) destroy(k, rec);
}
