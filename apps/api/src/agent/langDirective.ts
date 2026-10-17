/**
 * AI 输出语言指令块。定位/展示分离:
 * - 展示文案(标题/说明/摘要/回复)跟随界面语言;
 * - 定位用业务文案(Locator.value / assertText.equals / contextText)必须取页面实际文本,禁止翻译。
 * 会追加到 systemPrompt 末尾,由各 prompt 装配点调用。
 */
export type AiLang = 'zh-CN' | 'en-US';

export function langDirective(lang: AiLang): string {
  const uiName = lang === 'en-US' ? 'English' : 'Chinese (简体中文)';
  return [
    '',
    '--- output language rules ---',
    `UI language is ${lang} (${uiName}).`,
    `All user-visible text you produce (case titles, step names, requirement summaries, verdict reasons, assistant replies) MUST be written in ${uiName}.`,
    `All locator matching text you produce (Locator.value for text strategy, assertText.equals, IntentLocator.contextText) MUST be taken verbatim from the actual page snapshot you are given, in the page's own language. NEVER translate, paraphrase, or rewrite locator matching text.`,
    'If the page text is in another language than the UI language, locator text stays in the page language.',
  ].join('\n');
}

export function aiLangFrom(pref: string | null | undefined): AiLang {
  return pref === 'en-US' ? 'en-US' : 'zh-CN';
}