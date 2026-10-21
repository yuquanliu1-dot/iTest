/** 列表时间列：MM-DD HH:MM（完整时间放 title），与 iDO 表格同口径。 */
export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fullDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN');
}

/** 毫秒 → 人类可读时长（1.2s / 1m 23s / 1h 05m）。null/undefined → '—'。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/** 字节数 → 人类可读（1.2 KB / 3.4 MB）。与 iDO 文件大小同口径。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** 步骤类型展示名 = i18n key（仅展示用，存储值仍为英文 kind；由调用方组件 t() 渲染）。 */
export const STEP_KIND_LABELS: Record<string, string> = {
  click: 'cases:stepKind.click',
  hover: 'cases:stepKind.hover',
  fill: 'cases:stepKind.fill',
  select: 'cases:stepKind.select',
  check: 'cases:stepKind.check',
  waitFor: 'cases:stepKind.waitFor',
  assertVisible: 'cases:stepKind.assertVisible',
  assertText: 'cases:stepKind.assertText',
  assertJson: 'cases:stepKind.assertJson',
  navigate: 'cases:stepKind.navigate',
  upload: 'cases:stepKind.upload',
  extract: 'cases:stepKind.extract',
  aiTask: 'cases:stepKind.aiTask',
  switchTab: 'cases:stepKind.switchTab',
  screenshot: 'cases:stepKind.screenshot',
  queryDb: 'cases:stepKind.queryDb',
  observeLog: 'cases:stepKind.observeLog',
  httpRequest: 'cases:stepKind.httpRequest',
  sendSyslog: 'cases:stepKind.sendSyslog',
  sql: 'cases:stepKind.sql',
};

export function stepKindLabel(kind: string): string {
  return STEP_KIND_LABELS[kind] ?? kind;
}

/** 用例状态展示名 = i18n key（仅展示用，存储值仍为英文；由调用方组件 t() 渲染）。 */
export const CASE_STATUS_LABELS: Record<string, string> = {
  draft: 'cases:status.draft',
  review: 'cases:status.review',
  ready: 'cases:status.ready',
  deprecated: 'cases:status.deprecated',
};

export function caseStatusLabel(status: string): string {
  return CASE_STATUS_LABELS[status] ?? status;
}
