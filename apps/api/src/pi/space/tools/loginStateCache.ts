/**
 * 进程内登录态缓存：verify_case / perform_login 按 `${envId}:${user}` 复用已登录 storageState，
 * 省掉每次调用重复的登录+验证码成本（视觉 LLM 往返约 2 分钟/轮）。
 * 只存内存：storageState 含会话 cookie，不落库、不进 LLM 上下文/工具返回值/日志，进程重启即清空。
 * 过期不显式失效——缓存落到登录页时 AI 驱动流程会用凭据重新登录并回写（自愈，最坏退化回无缓存）。
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
