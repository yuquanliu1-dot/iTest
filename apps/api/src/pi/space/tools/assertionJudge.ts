/**
 * 步骤级 assertion 文本体检：判定「这是真实 UI 文案」还是「描述性短语」。
 *
 * 动机：AI 常写出「登录表单正常展示」「账号已触发锁定」「登录请求已发出」这类描述性短语。
 * 它们会被规整成 `target:'page' match:'contains'` 的整页子串断言，回放时拿
 * `document.body.innerText` 必然命中不到 → 整步 fail。历史上用 28 词黑名单
 * （DESCRIPTIVE_PHRASES）过滤，但硬编码措辞列表和曾经的 CAPTCHA_FAIL_RE 是同一类反模式：
 * 每遇一种新写法就得加词，永远追不完，还误伤真实文案（含「提示」「需」等字的按钮/toast 会被丢弃）。
 *
 * 改为交给 LLM 判：它理解自然语言语义，能区分「保存」（真实按钮文案）与
 * 「保存成功」（描述性断言）。只在 verify_case 的真实页面上跑一次，判定依据是
 * 页面实际存在的文案，不是猜。
 *
 * 关键设计：best-effort + 不静默丢弃。判定为描述性时返回 null 让调用方降级，
 * 但任何异常（LLM 未配置 / 网络失败 / 非法 JSON）都返回 null 之外的「保留」结论——
 * 宁可留一条可能失败的断言，也不静默吃掉用户的断言。
 */
import type { LLMClient } from '../../../agent/llm-client.js';
import { tryParseJson } from '../../../agent/llm-client.js';
import { aiLangFrom, type AiLang } from '../../../agent/langDirective.js';

export interface AssertionJudgeResult {
  /** true = 真实 UI 文案，可作断言；false = 描述性短语，应丢弃。 */
  real: boolean;
  /** 一句话理由，供 verify 回传给用户/LLM 参考。 */
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

/** 页面可见文本（截断防爆），与断言文本一起交给 LLM 作判断依据。 */
function buildUserMessage(assertion: string, pageText: string): string {
  const page = pageText.slice(0, 3000);
  return [
    `断言文本：${assertion}`,
    page ? `当前页面可见文本（节选）：\n${page}` : '（未取到页面文本，仅按语义判断）',
  ].join('\n');
}

/**
 * 判定一条断言是否为真实 UI 文案。best-effort：任何异常都返回 real=true（保留）。
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
    // LLM 未配置 / 网络失败 → 保留断言（宁可回放失败，也不静默丢用户的断言）
    return { real: true, reason: '判定不可用，保留断言' };
  }
}