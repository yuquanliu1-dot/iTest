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

/** 步骤类型中文名（仅展示用，存储值仍为英文 kind）。 */
export const STEP_KIND_LABELS: Record<string, string> = {
  click: '点击',
  hover: '悬停',
  fill: '输入',
  select: '下拉选择',
  check: '勾选',
  waitFor: '等待元素',
  assertVisible: '断言可见',
  assertText: '断言文本',
  assertJson: '断言JSON',
  navigate: '打开页面',
  upload: '上传文件',
  extract: '提取变量',
  aiTask: '智能步骤',
  switchTab: '切换标签页',
  screenshot: '截图',
  queryDb: '数据库查询',
  observeLog: '日志观察',
  httpRequest: 'HTTP 请求',
};

export function stepKindLabel(kind: string): string {
  return STEP_KIND_LABELS[kind] ?? kind;
}

/** 用例状态中文名（仅展示用，存储值仍为英文）。 */
export const CASE_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  review: '评审中',
  ready: '就绪',
  deprecated: '废弃',
};

export function caseStatusLabel(status: string): string {
  return CASE_STATUS_LABELS[status] ?? status;
}
