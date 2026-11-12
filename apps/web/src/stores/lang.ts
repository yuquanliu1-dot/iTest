import i18n, { applyHtmlLang, readStoredLang, type Lang } from '../i18n';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';

const DAYJS_LOCALES: Record<Lang, string> = { 'zh-CN': 'zh-cn', 'en-US': 'en' };

/** Applies the given language to i18n + html lang + dayjs; not persisted (persistence belongs to the backend languagePreference). */
export function applyLang(lang: Lang): void {
  void i18n.changeLanguage(lang);
  applyHtmlLang(lang);
  dayjs.locale(DAYJS_LOCALES[lang]);
}

/** Resolves the user's language preference into a Lang; missing/unknown falls back to the default. */
export function langFromPref(pref: string | null | undefined): Lang {
  if (pref === 'en-US') return 'en-US';
  if (pref === 'zh-CN') return 'zh-CN';
  return readStoredLang();
}