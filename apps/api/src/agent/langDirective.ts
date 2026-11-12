/**
 * AI output language directive block. Locator/display separation:
 * - Display text (titles/descriptions/summaries/replies) follows the UI language;
 * - Locator-matching business text (Locator.value / assertText.equals / contextText) must be taken verbatim from actual page text; translation is forbidden.
 * Appended to the end of systemPrompt by each prompt assembly point.
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