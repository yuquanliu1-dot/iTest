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
import zhProductLines from './locales/zh-CN/productLines.json';
import enProductLines from './locales/en-US/productLines.json';
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
import zhOverview from './locales/zh-CN/overview.json';
import enOverview from './locales/en-US/overview.json';
import zhAssistant from './locales/zh-CN/assistant.json';
import enAssistant from './locales/en-US/assistant.json';
import zhEnvironments from './locales/zh-CN/environments.json';
import enEnvironments from './locales/en-US/environments.json';
import zhDatasets from './locales/zh-CN/datasets.json';
import enDatasets from './locales/en-US/datasets.json';
import zhDevice from './locales/zh-CN/device.json';
import enDevice from './locales/en-US/device.json';
import zhMobile from './locales/zh-CN/mobile.json';
import enMobile from './locales/en-US/mobile.json';
import zhErrors from './locales/zh-CN/errors.json';
import enErrors from './locales/en-US/errors.json';
import zhLanding from './locales/zh-CN/landing.json';
import enLanding from './locales/en-US/landing.json';
import zhExplorations from './locales/zh-CN/explorations.json';
import enExplorations from './locales/en-US/explorations.json';

export type Lang = 'zh-CN' | 'en-US';

export const LANG_STORAGE_KEY = 'itest-lang';

const resources = {
  'zh-CN': { common: zhCommon, auth: zhAuth, settings: zhSettings, projects: zhProjects, productLines: zhProductLines, members: zhMembers, cases: zhCases, groups: zhGroups, plans: zhPlans, reports: zhReports, overview: zhOverview, assistant: zhAssistant, environments: zhEnvironments, datasets: zhDatasets, device: zhDevice, mobile: zhMobile, errors: zhErrors, landing: zhLanding, explorations: zhExplorations },
  'en-US': { common: enCommon, auth: enAuth, settings: enSettings, projects: enProjects, productLines: enProductLines, members: enMembers, cases: enCases, groups: enGroups, plans: enPlans, reports: enReports, overview: enOverview, assistant: enAssistant, environments: enEnvironments, datasets: enDatasets, device: enDevice, mobile: enMobile, errors: enErrors, landing: enLanding, explorations: enExplorations },
};

void i18n.use(initReactI18next).init({
  resources,
  lng: readStoredLang(),
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
});

/** When logged out / first visit, read from localStorage first (overwritten by auth user after login). */
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

/** API error → localized text. Errors in the error-code catalog use the catalog; unknown codes fall back to the raw message. */
export function localizeApiError(err: { code?: string; message?: string } | null | undefined): string {
  // bad_request is reused by the backend: datasets.service.ts uses it to return concrete actionable text like "row 3 column x sent back a sensitive placeholder… please refresh and retry",
  // and the catalog only has the generic "invalid request parameters, please check your input", which would mislead users into checking input instead of refreshing. Pass through message first when present.
  if (err?.code === 'bad_request' && err.message) {
    return err.message;
  }
  if (err?.code && i18n.exists(`errors:${err.code}`)) {
    return i18n.t(`errors:${err.code}`);
  }
  return err?.message ?? '';
}

export default i18n;