/**
 * In-process login-state cache: verify_case / perform_login reuse a logged-in storageState by `${envId}:${user}`,
 * saving the repeated login+captcha cost of every call (~2 minutes per visual-LLM round trip).
 * Memory only: storageState carries session cookies — never persisted, never fed into LLM context/tool returns/logs, cleared on process restart.
 * Expiry is not explicitly invalidated — when the cached state lands on a login page, the AI-driven flow re-logs-in with credentials and writes back (self-healing; worst case it degrades back to no cache).
 */
import type { BrowserContext } from 'playwright-core';

export type LoginStorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

const TTL_MS = 30 * 60_000;
const cache = new Map<string, { storageState: LoginStorageState; savedAt: number }>();

export function loginStateKey(envId: string, user: string | undefined): string {
  return `${envId}:${user ?? ''}`;
}

export function getLoginState(key: string): LoginStorageState | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.savedAt > TTL_MS) return null;
  return hit.storageState;
}

export function saveLoginState(key: string, state: LoginStorageState): void {
  cache.set(key, { storageState: state, savedAt: Date.now() });
}
