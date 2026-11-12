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
  /** Case-level expectedOutcome (natural language); when empty/null/whitespace-only, skip judgment and return undefined directly. */
  expectedOutcome?: string | null;
  /** Case title, as a fallback semantic anchor. */
  caseTitle: string;
  /** Case url (optional), gives the LLM some context. */
  caseUrl?: string | null;
  /** Final page screenshot (PNG/JPEG base64). */
  screenshot: { base64: string; mime: 'image/png' | 'image/jpeg' };
  /** Optional full-page screenshot: an extra capture when the page exceeds the viewport, covering regions that need scrolling to see.
   *  When omitted, judgment is based on the viewport image only (same behavior as before this field was introduced). */
  fullScreenshot?: { base64: string; mime: 'image/png' | 'image/jpeg' } | null;
  /** Process evidence: page screenshot during execution (when the last step completes). Transient prompts (toasts) have already
   *  disappeared from the final-state screenshot; they can only appear in this image. Omitted by default (behavior unchanged from before introduction). */
  processScreenshot?: { base64: string; mime: 'image/png' | 'image/jpeg' } | null;
  /** Process evidence: page text snapshots of the last few steps (old→new). Same motivation as processScreenshot — DOM text
   *  is captured mechanically and less prone to misreading than screenshots. Omitted by default. */
  processPageTexts?: string[];
  /** Process evidence: step execution records (per-step warning/error, including on-the-spot AI descriptions of page phenomena). Transient
   *  prompts may appear while a step is executing and vanish before the step ends — only the executor at that moment saw them and recorded them;
   *  neither the end-of-step snapshot nor the final screenshot can catch them. Omitted by default. */
  processStepNotes?: string[];
  /** LLM injection; resolves LLMClient on demand when omitted. */
  llmClient?: LLMClient;
  /** UI language: falls back to zh-CN when omitted (deterministic fallback when the execution path has no user context). */
  lang?: AiLang;
}

/** Uses a vision LLM to judge whether the case's final screenshot matches expectedOutcome.
 *  - LLM call failure/parse failure/timeout → returns undefined; the caller does not treat it as a failure (best-effort).
 *  - Normal LLM return → {passed, reason}. */
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
  // Multi-image form: viewport image (image 1, what the user actually saw at the end of execution) + full-page image (image 2, covering below the viewport) +
  // process image (image 3, taken when the last step completed — transient prompts can only appear here). With any extra image, go through messages
  // instead of the image field — the latter supports only a single image; all three clients already map image blocks one by one from messages
  // (llm-openai/anthropic/google), so no provider-layer change is needed.
  const userMessage = [
    `用例标题: ${opts.caseTitle}`,
    opts.caseUrl ? `用例入口 URL: ${opts.caseUrl}` : '',
    `用例预期: ${expected}`,
    opts.fullScreenshot || opts.processScreenshot
      ? '以下为执行结束后的页面截图（图 1 视口 / 图 2 整页）：'
      : '以下为执行结束后的页面截图：',
  ].filter(Boolean).join('\n');
  const hasFull = !!opts.fullScreenshot;
  const hasProcessImage = !!opts.processScreenshot;
  const processTexts = opts.processPageTexts?.length ? opts.processPageTexts : null;
  const processNotes = opts.processStepNotes?.length ? opts.processStepNotes : null;
  const extraImages = hasFull || hasProcessImage || !!processTexts || !!processNotes;
  const messages: LLMMessage[] | undefined = extraImages
    ? [
        {
          role: 'user',
          content: [
            { type: 'image', base64: opts.screenshot.base64, mime: opts.screenshot.mime },
            { type: 'text', text: '图 1：执行结束时用户实际看到的视口范围。' },
            ...(hasFull
              ? [
                  { type: 'image' as const, base64: opts.fullScreenshot!.base64, mime: opts.fullScreenshot!.mime },
                  { type: 'text' as const, text: '图 2：同一时刻的整页截图（含视口以下需滚动才能看到的区域）。' },
                ]
              : []),
            ...(hasProcessImage
              ? [
                  { type: 'image' as const, base64: opts.processScreenshot!.base64, mime: opts.processScreenshot!.mime },
                  { type: 'text' as const, text: '图 3：执行过程中（最后一步刚完成时）的页面截图——短时提示只可能出现在这里。' },
                ]
              : []),
            ...(processTexts
              ? [{
                  type: 'text' as const,
                  text: `执行过程页面文本（每步一次捕获的页面文字快照，老→新，共 ${processTexts.length} 份）：\n${processTexts
                    .map((t, i) => `[快照 ${i + 1}]\n${t}`)
                    .join('\n---\n')}`,
                }]
              : []),
            ...(processNotes
              ? [{
                  type: 'text' as const,
                  text: `步骤执行记录（executor 对每步的备注与错误，含临场 AI 对页面现象的描述，老→新）：\n${processNotes.join('\n')}`,
                }]
              : []),
            { type: 'text', text: userMessage },
          ],
        },
      ]
    : undefined;
  let r;
  try {
    r = await completeJson(client, {
      systemPrompt: CASE_OUTCOME_VISION_PROMPT,
      userMessage,
      lang: aiLangFrom(opts.lang ?? null),
      ...(messages
        ? { messages }
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
