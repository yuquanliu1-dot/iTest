/** List time column: MM-DD HH:MM (full time in title), same convention as iDO tables. */
export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fullDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN');
}

/** Clock time (HH:MM:SS) — used for step "start time"; full datetime in title.
 *  Same local-timezone convention as fullDateTime, no UTC offset conversion. Invalid dates fall back to '—'. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Milliseconds → human-readable duration (1.2s / 1m 23s / 1h 05m). null/undefined → '—'. */
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

/** Byte count → human-readable (1.2 KB / 3.4 MB). Same convention as iDO file sizes. */
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

/** Step kind display name = i18n key (display only; the stored value remains the English kind; rendered by the caller's t()). */
export const STEP_KIND_LABELS: Record<string, string> = {
  click: 'cases:stepKind.click',
  press: 'cases:stepKind.press',
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
  observeLog: 'cases:stepKind.observeLog',
  httpRequest: 'cases:stepKind.httpRequest',
  sendSyslog: 'cases:stepKind.sendSyslog',
  sql: 'cases:stepKind.sql',
  scroll: 'cases:stepKind.scroll',
};

export function stepKindLabel(kind: string): string {
  return STEP_KIND_LABELS[kind] ?? kind;
}

/** Case status display name = i18n key (display only; the stored value remains English; rendered by the caller's t()). */
export const CASE_STATUS_LABELS: Record<string, string> = {
  draft: 'cases:status.draft',
  review: 'cases:status.review',
  ready: 'cases:status.ready',
  deprecated: 'cases:status.deprecated',
};

export function caseStatusLabel(status: string): string {
  return CASE_STATUS_LABELS[status] ?? status;
}
