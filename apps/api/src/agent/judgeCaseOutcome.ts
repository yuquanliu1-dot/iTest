import { resolveLlmClient } from './llmSettings.js';
import type { LLMClient, LLMMessage } from './llm-client.js';
import { completeJson } from './llm-client.js';
import { CASE_OUTCOME_VISION_PROMPT } from './prompts/case-outcome-vision.js';
import { aiLangFrom, type AiLang } from './langDirective.js';
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
  /** 可选的整页截图：页面超出视口时补一张，覆盖需要滚动才能看到的区域。
   *  不传则只按视口图判定（与该字段引入前一致）。 */
  fullScreenshot?: { base64: string; mime: 'image/png' | 'image/jpeg' } | null;
  /** LLM 注入；缺省时按需 resolveLlmClient。 */
  llmClient?: LLMClient;
  /** 界面语言：缺省 zh-CN 回落（执行路径无用户上下文时确定性回落）。 */
  lang?: AiLang;
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
  // 双图形态：视口图（图 1，用户执行结束时实际看到的）+ 整页图（图 2，覆盖视口以下）。
  // 走 messages 而非 image 字段——后者只支持单图；三个 client 都已按 messages 的
  // image block 逐块映射（llm-openai/anthropic/google），无需改 provider 层。
  const userMessage = [
    `用例标题: ${opts.caseTitle}`,
    opts.caseUrl ? `用例入口 URL: ${opts.caseUrl}` : '',
    `用例预期: ${expected}`,
    opts.fullScreenshot ? '以下为执行结束后的页面截图（图 1 视口 / 图 2 整页）：' : '以下为执行结束后的页面截图：',
  ].filter(Boolean).join('\n');
  const twoImages: LLMMessage[] | undefined = opts.fullScreenshot
    ? [{
        role: 'user',
        content: [
          { type: 'image', base64: opts.screenshot.base64, mime: opts.screenshot.mime },
          { type: 'text', text: '图 1：执行结束时用户实际看到的视口范围。' },
          { type: 'image', base64: opts.fullScreenshot.base64, mime: opts.fullScreenshot.mime },
          { type: 'text', text: '图 2：同一时刻的整页截图（含视口以下需滚动才能看到的区域）。' },
          { type: 'text', text: userMessage },
        ],
      }]
    : undefined;
  let r;
  try {
    r = await completeJson(client, {
      systemPrompt: CASE_OUTCOME_VISION_PROMPT,
      userMessage,
      lang: aiLangFrom(opts.lang ?? null),
      ...(twoImages
        ? { messages: twoImages }
        : { image: opts.screenshot }),
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
