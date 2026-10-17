import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhCommon from './locales/zh-CN/common.json';
import enCommon from './locales/en-US/common.json';

export type Lang = 'zh-CN' | 'en-US';

export const LANG_STORAGE_KEY = 'itest-lang';

const resources = {
  'zh-CN': { common: zhCommon },
  'en-US': { common: enCommon },
};

void i18n.use(initReactI18next).init({
  resources,
  lng: readStoredLang(),
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
});

/** 未登录 / 首次访问时先从 localStorage 读(登录后由 auth user 覆盖)。 */
export function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY);
    return v === 'en-US' ? 'en-US' : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

export function applyHtmlLang(lang: Lang): void {
  document.documentElement.lang = lang === 'en-US' ? 'en' : 'zh-CN';
}

export default i18n;