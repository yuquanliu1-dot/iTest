import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';

/** 回放 AI 重做开关（全局设置，仅 Web 回放生效）。
 *  只有「机械步骤执行失败后 AI 按指令重做」是可选项；NL 视觉步骤（空 compiled + 有指令）
 *  的临场执行是正式执行语义，不受开关管（2026-10-24 起固化可选）。 */
export interface AiFallbackSettings {
  /** 机械步骤执行失败（任意失败原因）时用该步 instruction 让 AI 重做。 */
  locatorFailed: boolean;
}

/** settings KV key，与 apps/web/src/pages/Settings.tsx 的常量互为镜像。 */
export const AI_FALLBACK_KEYS = {
  locatorFailed: 'ai_fallback_locator_failed',
} as const;

/** 单次查询；缺失视为 false（开关默认关）。 */
export async function readAiFallbackSettings(): Promise<AiFallbackSettings> {
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, AI_FALLBACK_KEYS.locatorFailed));
  const map = new Map(rows.map((r) => [r.key, r.value as unknown]));
  return {
    locatorFailed: map.get(AI_FALLBACK_KEYS.locatorFailed) === true,
  };
}