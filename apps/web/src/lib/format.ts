/** 列表时间列：MM-DD HH:MM（完整时间放 title），与 iDO 表格同口径。 */
export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fullDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN');
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
