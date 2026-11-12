/**
 * verify_case cross-round browser keep-alive registry: consecutive verify_case rounds on the same thread+case reuse the same
 * browser/context/page; the confirmed prefix gets zero replay and zero restore (the browser sits on the previous round's
 * final page and the new steps simply continue from there).
 *
 * Lifecycle follows the same pattern as verifyConfirmCache/verifyTraceCache: an in-process Map + sticky routing (nginx ip_hash)
 * keeps same-thread verify rounds on the same replica; a replica restart / container rebuild hard-kills the browser and the next
 * round's acquire probe fails on isConnected, automatically degrading to the existing fresh+restore path — a performance loss,
 * never a correctness loss. Same-thread global serialization (session.ts's Redis itest:thread-run lock) guarantees two rounds of
 * the same key never run concurrently — the registry only stores idle browsers "between rounds"; in-flight rounds' browsers never
 * enter it, so eviction can never hit the wrong target.
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';

/** Idle keep-alive duration: measured — the discussion gap before the next step input is usually minutes; 20min covers a normal discussion pace. */
const SESSION_TTL_MS = 20 * 60 * 1000;
/** Per-replica cap on simultaneously kept-alive chromium instances (~300MB each; the oldest is evicted beyond the cap). */
const MAX_SESSIONS = 2;
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface BrowserSessionRefs {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

interface BrowserSessionRecord extends BrowserSessionRefs {
  metaHash: string;
  /** Prefix of applied step hashes matching the browser's current page state (curStepsHash.slice(0, appliedCount)). */
  appliedHashes: string[];
  lastUsedAt: number;
}

const sessions = new Map<string, BrowserSessionRecord>();

/** Hit probe: expired / browser disconnected / page closed / env mismatch / prefix steps edited — any one destroys the session, degrades, and returns null. */
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

/** End-of-round registration (the unified entry for reused and newly created rounds): upsert + touch; beyond the cap, evict the oldest (excluding this round's key). */
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

/** Deregister and close the browser (close failures are swallowed — the process is about to discard the instance); idempotent. */
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
/** Periodically sweep expired sessions (the fallback for lazy checks; recycles chromium even for idle processes). */
function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/** Sweep expired records (exported so tests can trigger it manually). */
export function sweepOnce(): void {
  const now = Date.now();
  for (const [k, rec] of sessions) {
    if (now - rec.lastUsedAt > SESSION_TTL_MS) destroy(k, rec);
  }
}

/** Read-only peek (for tests). */
export function peekSession(key: string): BrowserSessionRecord | null {
  return sessions.get(key) ?? null;
}

/** Clear every session (for test isolation; production should never call this). */
export function resetForTest(): void {
  for (const [k, rec] of sessions) destroy(k, rec);
}
