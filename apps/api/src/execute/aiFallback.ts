import { or, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';

/** 回放 AI 降级开关（全局设置，仅 Web 回放生效）。 */
export interface AiFallbackSettings {
  /** compiled DSL 为空时用该步 instruction 调 AI 临场执行。 */
  compileMissing: boolean;
  /** 机械动作 locator 全部探测失败（LocatorAllFailed）时用该步 instruction 让 AI 重做。 */
  locatorFailed: boolean;
}

/** settings KV key，与 apps/web/src/pages/Settings.tsx 的常量互为镜像。 */
export const AI_FALLBACK_KEYS = {
  compileMissing: 'ai_fallback_compile_missing',
  locatorFailed: 'ai_fallback_locator_failed',
} as const;

/** 单次查询两个 key；任一缺失视为 false（开关默认关）。 */
export async function readAiFallbackSettings(): Promise<AiFallbackSettings> {
  const rows = await db
    .select()
    .from(settings)
    .where(
      or(eq(settings.key, AI_FALLBACK_KEYS.compileMissing), eq(settings.key, AI_FALLBACK_KEYS.locatorFailed)),
    );
  const map = new Map(rows.map((r) => [r.key, r.value as unknown]));
  return {
    compileMissing: map.get(AI_FALLBACK_KEYS.compileMissing) === true,
    locatorFailed: map.get(AI_FALLBACK_KEYS.locatorFailed) === true,
  };
}