import { resolveLlmClient } from './llmSettings.js';
import type { LLMClient } from './llm-client.js';
import { completeJson } from './llm-client.js';
import { CASE_OUTCOME_VISION_PROMPT } from './prompts/case-outcome-vision.js';
import { newAiUsage, type AiUsageStat } from '../execute/aiUsage.js';
import { logger } from '../logger.js';

export interface VisionAssertOk { passed: true; reason: string; aiUsage?: AiUsageStat }
export interface VisionAssertFail { passed: false; reason: string; aiUsage?: AiUsageStat }
export type VisionAssertResult = VisionAssertOk | VisionAssertFail;

export interface JudgeCaseOutcomeOpts {
  /** 用例级 expectedOutcome（自然语言），为空/null/纯空白时跳过判定直接返回 undefined。 */
  expectedOutcome?: string | null;
  /** 用例标题，作为兜底语义锚。 */
  caseTitle: string;
  /** 用例 url（可选），给 LLM 一点上下文。 */
  caseUrl?: string | null;
  /** 最终页面截图（PNG/JPEG base64）。 */
  screenshot: { base64: string; mime: 'image/png' | 'image/jpeg' };
  /** LLM 注入；缺省时按需 resolveLlmClient。 */
  llmClient?: LLMClient;
}

/** 用 vision LLM 判定用例最终截图是否符合 expectedOutcome。
 *  - LLM 调用失败/解析失败/timeout → 返回 undefined，调用方不视作失败（best-effort）。
 *  - LLM 正常返回 → {passed, reason}。 */
export async function judgeCaseOutcome(opts: JudgeCaseOutcomeOpts): Promise<VisionAssertResult | undefined> {
  const expected = (opts.expectedOutcome ?? '').trim();
  if (!expected) return undefined;
  let client: LLMClient | undefined = opts.llmClient;
  if (!client) {
    try {
      client = (await resolveLlmClient()).client;
    } catch (e) {
      logger.warn({ err: e }, 'llm unresolved; skip case-outcome vision assert');
      return undefined;
    }
  }
  const userMessage = [
    `用例标题: ${opts.caseTitle}`,
    opts.caseUrl ? `用例入口 URL: ${opts.caseUrl}` : '',
    `用例预期: ${expected}`,
    '以下为执行结束后的页面截图：',
  ].filter(Boolean).join('\n');
  let r;
  try {
    r = await completeJson(client, {
      systemPrompt: CASE_OUTCOME_VISION_PROMPT,
      userMessage,
      image: opts.screenshot,
    });
  } catch (e) {
    logger.warn({ err: e, caseTitle: opts.caseTitle }, 'case-outcome vision assert failed; treat as skipped');
    return undefined;
  }
  const usage = newAiUsage();
  usage.add(r);
  const n = normalize(r.value);
  return n ? { ...n, aiUsage: usage.stat } : undefined;
}

function normalize(raw: Record<string, unknown>): VisionAssertResult | undefined {
  const passed = raw.passed;
  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : '';
  if (passed === true) return { passed: true, reason: reason || 'vision: passed' };
  if (passed === false) return { passed: false, reason: reason || 'vision: failed' };
  return undefined;
}
