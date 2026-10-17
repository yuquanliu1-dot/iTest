import i18n, { applyHtmlLang, readStoredLang, type Lang } from '../i18n';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';

const DAYJS_LOCALES: Record<Lang, string> = { 'zh-CN': 'zh-cn', 'en-US': 'en' };

/** 应用指定语言到 i18n + html lang + dayjs;不持久化(持久化归后端 languagePreference)。 */
export function applyLang(lang: Lang): void {
  void i18n.changeLanguage(lang);
  applyHtmlLang(lang);
  dayjs.locale(DAYJS_LOCALES[lang]);
}

/** 从用户语言偏好解析成 Lang;缺失/未知回落默认。 */
export function langFromPref(pref: string | null | undefined): Lang {
  if (pref === 'en-US') return 'en-US';
  if (pref === 'zh-CN') return 'zh-CN';
  return readStoredLang();
}