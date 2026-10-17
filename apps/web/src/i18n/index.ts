import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhCommon from './locales/zh-CN/common.json';
import enCommon from './locales/en-US/common.json';
import zhAuth from './locales/zh-CN/auth.json';
import enAuth from './locales/en-US/auth.json';
import zhSettings from './locales/zh-CN/settings.json';
import enSettings from './locales/en-US/settings.json';
import zhProjects from './locales/zh-CN/projects.json';
import enProjects from './locales/en-US/projects.json';
import zhMembers from './locales/zh-CN/members.json';
import enMembers from './locales/en-US/members.json';
import zhCases from './locales/zh-CN/cases.json';
import enCases from './locales/en-US/cases.json';
import zhGroups from './locales/zh-CN/groups.json';
import enGroups from './locales/en-US/groups.json';
import zhPlans from './locales/zh-CN/plans.json';
import enPlans from './locales/en-US/plans.json';
import zhReports from './locales/zh-CN/reports.json';
import enReports from './locales/en-US/reports.json';

export type Lang = 'zh-CN' | 'en-US';

export const LANG_STORAGE_KEY = 'itest-lang';

const resources = {
  'zh-CN': { common: zhCommon, auth: zhAuth, settings: zhSettings, projects: zhProjects, members: zhMembers, cases: zhCases, groups: zhGroups, plans: zhPlans, reports: zhReports },
  'en-US': { common: enCommon, auth: enAuth, settings: enSettings, projects: enProjects, members: enMembers, cases: enCases, groups: enGroups, plans: enPlans, reports: enReports },
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