/**
 * Step-level assertion text triage: decide whether this is real UI copy or a descriptive phrase.
 *
 * Motivation: the AI often writes descriptive phrases like 「登录表单正常展示」「账号已触发锁定」「登录请求已发出」.
 * They get normalized into whole-page substring assertions with `target:'page' match:'contains'`, and replaying against
 * `document.body.innerText` can never hit them → the whole step fails. Historically a 28-word blacklist
 * (DESCRIPTIVE_PHRASES) filtered them, but a hardcoded phrase list is the same antipattern as the old CAPTCHA_FAIL_RE:
 * every new phrasing needs another word, the chase never ends, and real copy gets caught in the crossfire
 * (buttons/toasts containing 「提示」「需」 etc. were being dropped).
 *
 * Switched to letting the LLM judge: it understands natural-language semantics and can tell 「保存」 (real button copy)
 * from 「保存成功」 (a descriptive assertion). It runs once on verify_case's real page; the judgment basis is the copy
 * actually present on the page, not guessing.
 *
 * Key design: best-effort + never silently drop. When judged descriptive, return null and let the caller degrade,
 * but on any exception (LLM unconfigured / network failure / invalid JSON) return a "keep" verdict instead of null —
 * better to keep one assertion that might fail than to silently swallow the user's assertion.
 */
import type { LLMClient } from '../../../agent/llm-client.js';
import { tryParseJson } from '../../../agent/llm-client.js';
import { aiLangFrom, type AiLang } from '../../../agent/langDirective.js';

export interface AssertionJudgeResult {
  /** true = real UI copy, usable as an assertion; false = descriptive phrase, should be dropped. */
  real: boolean;
  /** One-sentence reason, fed back to the user/LLM by verify for reference. */
  reason: string;
}

const ASSERTION_JUDGE_PROMPT = `你是测试断言审核员。给你一条测试步骤的断言文本（预期结果），判断它是「页面上真实存在的 UI 文案」还是「描述性短语（无法在页面上直接匹配到）」。

判定标准：
- 真实 UI 文案：按钮文字、Toast 提示、表单标签、页面标题、错误信息原文。如「登录」「保存」「用户名不能为空」「该用户已存在」「操作成功」。它必须是页面上会原样出现的字符串。
- 描述性短语：描述状态或意图而非页面文本。如「登录表单正常展示」「账号已触发锁定」「登录请求已发出」「应该跳转首页」「页面可见数据」。这类文本页面上根本不存在，回放时永远匹配不到。

注意：
- 短文案即使含「提示」「需」「成功」等字，只要看起来是页面上会原样显示的字符串，就判 real=true。
- 判不准时倾向 real=true（保留断言，交由回放实测），不要误杀。
- 只输出 JSON，不要 markdown 包裹：{"real":true|false,"reason":"≤30 字理由"}`;

/** Page-visible text (truncated to avoid blowing up), handed to the LLM together with the assertion text as the judgment basis. */
function buildUserMessage(assertion: string, pageText: string): string {
  const page = pageText.slice(0, 3000);
  return [
    `断言文本：${assertion}`,
    page ? `当前页面可见文本（节选）：\n${page}` : '（未取到页面文本，仅按语义判断）',
  ].join('\n');
}

/**
 * Judge whether an assertion is real UI copy. best-effort: any exception returns real=true (keep).
 */
export async function judgeAssertionText(
  assertion: string,
  pageText: string,
  client: LLMClient,
  lang?: AiLang,
): Promise<AssertionJudgeResult> {
  try {
    const r = await client.complete({
      systemPrompt: ASSERTION_JUDGE_PROMPT,
      userMessage: buildUserMessage(assertion, pageText),
      lang: aiLangFrom(lang ?? null),
    });
    const raw = r.kind === 'json' ? JSON.stringify(r.value) : r.value;
    const parsed = tryParseJson(raw);
    if (!parsed || typeof parsed.real !== 'boolean') {
      return { real: true, reason: '判定结果不可解析，保留断言' };
    }
    return {
      real: parsed.real,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 100) : '',
    };
  } catch {
    // LLM unconfigured / network failure → keep the assertion (better a replay failure than silently dropping the user's assertion)
    return { real: true, reason: '判定不可用，保留断言' };
  }
}