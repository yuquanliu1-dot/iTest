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

export type Lang = 'zh-CN' | 'en-US';

export const LANG_STORAGE_KEY = 'itest-lang';

const resources = {
  'zh-CN': { common: zhCommon, auth: zhAuth, settings: zhSettings, projects: zhProjects, members: zhMembers, cases: zhCases, groups: zhGroups, plans: zhPlans, reports: zhReports, overview: zhOverview, assistant: zhAssistant, environments: zhEnvironments, datasets: zhDatasets, device: zhDevice, mobile: zhMobile, errors: zhErrors },
  'en-US': { common: enCommon, auth: enAuth, settings: enSettings, projects: enProjects, members: enMembers, cases: enCases, groups: enGroups, plans: enPlans, reports: enReports, overview: enOverview, assistant: enAssistant, environments: enEnvironments, datasets: enDatasets, device: enDevice, mobile: enMobile, errors: enErrors },
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

/** API 错误 → 本地化文案。命中错误码目录用目录；未知 code 回落原始 message。 */
export function localizeApiError(err: { code?: string; message?: string } | null | undefined): string {
  // bad_request 被后端复用：datasets.service.ts 用它回传「第 3 行列 x 回传了敏感占位符…请刷新后重试」等具体可执行文案，
  // 目录里只有通用「请求参数错误，请检查输入」会误导用户去查输入而非刷新。有 message 时优先透传。
  if (err?.code === 'bad_request' && err.message) {
    return err.message;
  }
  if (err?.code && i18n.exists(`errors:${err.code}`)) {
    return i18n.t(`errors:${err.code}`);
  }
  return err?.message ?? '';
}

export default i18n;