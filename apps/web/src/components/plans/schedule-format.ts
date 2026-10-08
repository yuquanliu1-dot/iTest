/**
 * cron 表达式格式化与人机可读描述。
 * 参考 iDO Automation 的 schedule-format.ts：5 字段 cron ↔ preset（每小时 / 每天 / 工作日 / 每周 / 每月 / 自定义）。
 */
import { parseExpression } from 'cron-parser';

export type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

export const PRESET_VALUES: SchedulePreset[] = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'];

export const PRESET_LABELS: Record<SchedulePreset, string> = {
  hourly: '每小时',
  daily: '每天',
  weekdays: '工作日（周一至周五）',
  weekly: '每周',
  monthly: '每月',
  custom: '自定义（cron 表达式）',
};

export const WEEKLY_DAY_VALUES: Array<{ value: string; label: string }> = [
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
  { value: '0', label: '周日' },
];

const WEEKDAY_INDEX_BY_NUM = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 把 cron 表达式映射到 preset；无法识别则返回 'custom'。 */
export function detectPreset(cron: string): SchedulePreset {
  const m = cron.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
  if (!m) return 'custom';
  const [, , hour, dom, mon, dow] = m;
  if (hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'hourly';
  if (dom === '*' && mon === '*' && dow === '*') return 'daily';
  if (dom === '*' && mon === '*' && (dow === '1-5' || dow === 'MON-FRI')) return 'weekdays';
  if (dom === '*' && mon === '*' && dow !== '*' && dow !== '*-*') return 'weekly';
  if (dom !== '*' && dom !== '*-*' && mon === '*' && dow === '*') return 'monthly';
  return 'custom';
}

/** 把 cron 转成中文描述；无法解析时返回 null。 */
export function formatSchedule(cron: string): string | null {
  const preset = detectPreset(cron);
  if (preset === 'custom') return null;
  const m = cron.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
  if (!m) return null;
  const minNum = parseInt(m[1] ?? '0', 10);
  const hourNum = parseInt(m[2] ?? '0', 10);
  const time = `${String(hourNum).padStart(2, '0')}:${String(minNum).padStart(2, '0')}`;

  switch (preset) {
    case 'hourly':
      return minNum === 0 ? '每小时整点' : `每小时第 ${minNum} 分`;
    case 'daily':
      return `每天 ${time}`;
    case 'weekdays':
      return `工作日 ${time}`;
    case 'weekly': {
      const dayNum = parseInt(m[5] ?? '0', 10);
      const day = Number.isNaN(dayNum) ? (m[5] ?? '?') : (WEEKDAY_INDEX_BY_NUM[dayNum % 7] ?? (m[5] ?? '?'));
      return `每${day} ${time}`;
    }
    case 'monthly':
      return `每月 ${m[3] ?? '1'} 日 ${time}`;
    default:
      return null;
  }
}

/** preset → 默认 cron（time 为 HH:MM）。 */
export function presetToCron(preset: Exclude<SchedulePreset, 'custom'>, time: string): string {
  const [h, m] = (time || '09:00').split(':').map((s) => (s ?? '').padStart(2, '0'));
  const hour = h || '09';
  const min = m || '00';
  switch (preset) {
    case 'hourly': return `${min} * * * *`;
    case 'daily': return `${min} ${hour} * * *`;
    case 'weekdays': return `${min} ${hour} * * 1-5`;
    case 'weekly': return `${min} ${hour} * * 1`;
    case 'monthly': return `${min} ${hour} 1 * *`;
  }
}

/** 从 cron 抽出 HH:MM（hourly 时返回分钟所在基准点，hourly 模式下时间选择隐藏）。 */
export function extractTime(cron: string): string {
  const m = cron.trim().match(/^(\S+)\s+(\S+)\s/);
  if (!m) return '09:00';
  const minRaw = m[1] ?? '*';
  const hourRaw = m[2] ?? '*';
  const min = (minRaw === '*' ? '0' : minRaw).padStart(2, '0');
  const hour = (hourRaw === '*' ? '9' : hourRaw).padStart(2, '0');
  return `${hour}:${min}`;
}

/** 校验 cron；返回 null 表示合法，否则返回错误描述。 */
export function validateCron(cron: string, tz: string): string | null {
  try {
    parseExpression(cron, { tz });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** 计算下次运行时间；失败返回 null。 */
export function nextRunAt(cron: string, tz: string, from: Date = new Date()): Date | null {
  try {
    return parseExpression(cron, { tz, currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}
