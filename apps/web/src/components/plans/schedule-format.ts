/**
 * cron 表达式格式化与人机可读描述。
 * 参考 iDO Automation 的 schedule-format.ts：5 字段 cron ↔ preset（每小时 / 每天 / 工作日 / 每周 / 每月 / 自定义）。
 */
import { parseExpression } from 'cron-parser';
import type { TFunction } from 'i18next';

export type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

export const PRESET_VALUES: SchedulePreset[] = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'];

/** preset 展示名 = i18n key（由调用方组件 t() 渲染）。 */
export const PRESET_LABELS: Record<SchedulePreset, string> = {
  hourly: 'plans:preset.hourly',
  daily: 'plans:preset.daily',
  weekdays: 'plans:preset.weekdays',
  weekly: 'plans:preset.weekly',
  monthly: 'plans:preset.monthly',
  custom: 'plans:preset.custom',
};

/** 星期选项（value = cron DOW；label = i18n key，由调用方组件 t() 渲染）。 */
export const WEEKLY_DAY_VALUES: Array<{ value: string; label: string }> = [
  { value: '1', label: 'plans:weekday.1' },
  { value: '2', label: 'plans:weekday.2' },
  { value: '3', label: 'plans:weekday.3' },
  { value: '4', label: 'plans:weekday.4' },
  { value: '5', label: 'plans:weekday.5' },
  { value: '6', label: 'plans:weekday.6' },
  { value: '0', label: 'plans:weekday.0' },
];

const WEEKDAY_INDEX_BY_NUM = ['plans:weekday.0', 'plans:weekday.1', 'plans:weekday.2', 'plans:weekday.3', 'plans:weekday.4', 'plans:weekday.5', 'plans:weekday.6'];

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

/** 把 cron 转成当前语言的人机可读描述；无法解析时返回 null。 */
export function formatSchedule(cron: string, t: TFunction): string | null {
  const preset = detectPreset(cron);
  if (preset === 'custom') return null;
  const m = cron.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
  if (!m) return null;
  const minNum = parseInt(m[1] ?? '0', 10);
  const hourNum = parseInt(m[2] ?? '0', 10);
  const time = `${String(hourNum).padStart(2, '0')}:${String(minNum).padStart(2, '0')}`;

  switch (preset) {
    case 'hourly':
      return minNum === 0
        ? t('plans:formatSchedule.hourlyOnTheHour')
        : t('plans:formatSchedule.hourlyAtMinute', { minute: minNum });
    case 'daily':
      return t('plans:formatSchedule.daily', { time });
    case 'weekdays':
      return t('plans:formatSchedule.weekdays', { time });
    case 'weekly': {
      const dayNum = parseInt(m[5] ?? '0', 10);
      const rawDay = m[5] ?? '?';
      const dayKey = Number.isNaN(dayNum) ? null : (WEEKDAY_INDEX_BY_NUM[dayNum % 7] ?? null);
      return t('plans:formatSchedule.weeklyPerDay', { day: dayKey ? t(dayKey) : rawDay, time });
    }
    case 'monthly':
      return t('plans:formatSchedule.monthly', { day: m[3] ?? '1', time });
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
