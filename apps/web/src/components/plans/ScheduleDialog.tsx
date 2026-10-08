/**
 * 执行计划调度 modal（iDO AutomationEditorDialog 风格）。
 *
 * 模型：cron 表达式 + IANA 时区，按固定时刻重复触发。
 * UI：preset Select（每小时 / 每天 / 工作日 / 每周 / 每月 / 自定义）
 *     + 条件性的周/时间 Select + 「自定义」模式下展开 5 字段 cron 输入面板。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  detectPreset,
  extractTime,
  formatSchedule,
  nextRunAt,
  presetToCron,
  validateCron,
  PRESET_VALUES,
  PRESET_LABELS,
  WEEKLY_DAY_VALUES,
  type SchedulePreset,
} from './schedule-format';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/Modal';
import Button from '../ui/Button';
import FieldLabel from '../ui/FieldLabel';
import type { PlanSchedule, PlanScheduleCreateInput, PlanSchedulePatchInput } from '../../api/client';

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

const FIELD_KEYS = ['minute', 'hour', 'day', 'month', 'weekday'] as const;
const FIELD_LABELS: Record<typeof FIELD_KEYS[number], string> = {
  minute: '分钟',
  hour: '小时',
  day: '日',
  month: '月',
  weekday: '周',
};

interface ScheduleDialogProps {
  editing: PlanSchedule | null;
  onClose: () => void;
  onCreate: (input: PlanScheduleCreateInput) => Promise<void>;
  onPatch: (id: string, body: PlanSchedulePatchInput) => Promise<void>;
}

export default function ScheduleDialog({ editing, onClose, onCreate, onPatch }: ScheduleDialogProps) {
  const initial = editing?.cronExpr ?? '0 9 * * *';
  const [cronExpr, setCronExpr] = useState<string>(initial);
  const [timezone, setTimezone] = useState<string>(editing?.timezone ?? 'Asia/Shanghai');
  const [enabled, setEnabled] = useState<boolean>(editing?.enabled ?? true);
  const [preset, setPreset] = useState<SchedulePreset>(() => detectPreset(initial));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    setCronExpr(editing.cronExpr);
    setTimezone(editing.timezone);
    setEnabled(editing.enabled);
    setPreset(detectPreset(editing.cronExpr));
  }, [editing]);

  const time = useMemo(() => extractTime(cronExpr), [cronExpr]);
  const [hh, mm] = time.split(':');
  const hour = hh ?? '09';
  const minute = mm ?? '00';
  const cronError = useMemo(() => validateCron(cronExpr, timezone), [cronExpr, timezone]);
  const nextRun = useMemo(() => {
    if (cronError) return null;
    return nextRunAt(cronExpr, timezone);
  }, [cronExpr, timezone, cronError]);
  const label = useMemo(() => formatSchedule(cronExpr) ?? cronExpr.trim(), [cronExpr]);
  const trimmedCron = cronExpr.trim();
  const fieldValues = useMemo(() => {
    const parts = trimmedCron.split(/\s+/);
    return FIELD_KEYS.map((_, i) => parts[i] ?? '...');
  }, [trimmedCron]);
  const weeklyDayValue = useMemo(() => {
    const m = trimmedCron.match(/^\S+\s+\S+\s+\S+\s+\S+\s+(\S+)$/);
    return m?.[1] ?? '1';
  }, [trimmedCron]);

  const handlePresetChange = (next: SchedulePreset) => {
    setPreset(next);
    if (next === 'custom') return;
    setCronExpr(presetToCron(next, time));
  };
  const handleWeeklyDayChange = (dow: string) => {
    setCronExpr(presetToCron('weekly', time).replace(/\d+$/, dow));
  };
  const handleHourChange = (h: string) => {
    setCronExpr(presetToCron(preset === 'custom' ? 'daily' : preset, `${h}:${minute}`));
  };
  const handleMinuteChange = (m: string) => {
    const padded = m.padStart(2, '0');
    if (preset === 'hourly') setCronExpr(`${padded} * * * *`);
    else if (preset !== 'custom') setCronExpr(presetToCron(preset, `${hour}:${padded}`));
  };

  const submit = async (): Promise<void> => {
    setError(null);
    if (cronError) {
      setError(cronError);
      return;
    }
    if (!cronExpr.trim()) {
      setError('cron 表达式不能为空');
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        const patch: PlanSchedulePatchInput = { cronExpr: cronExpr.trim(), timezone, enabled };
        await onPatch(editing.id, patch);
      } else {
        const body: PlanScheduleCreateInput = { cronExpr: cronExpr.trim(), timezone, enabled };
        await onCreate(body);
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent style={{ maxWidth: 520 }}>
        <DialogHeader>
          <DialogTitle>{editing ? '编辑调度' : '新增调度'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-[13px] px-5 py-2">
          {/* 频率 Select */}
          <div className="flex items-center gap-2">
            <FieldLabel className="shrink-0 w-16">频率</FieldLabel>
            <select
              value={preset}
              onChange={(e) => handlePresetChange(e.target.value as SchedulePreset)}
              className="input-base input-sm flex-1"
            >
              {PRESET_VALUES.map((p) => (
                <option key={p} value={p}>{PRESET_LABELS[p]}</option>
              ))}
            </select>
          </div>

          {/* 每周模式：星期 Select */}
          {preset === 'weekly' && (
            <div className="flex items-center gap-2">
              <FieldLabel className="shrink-0 w-16">星期</FieldLabel>
              <select
                value={weeklyDayValue}
                onChange={(e) => handleWeeklyDayChange(e.target.value)}
                className="input-base input-sm flex-1"
              >
                {WEEKLY_DAY_VALUES.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* 时间 / 分钟 Select（hourly 仅显示分钟） */}
          {preset !== 'custom' && preset !== 'hourly' && (
            <div className="flex items-center gap-2">
              <FieldLabel className="shrink-0 w-16">时间</FieldLabel>
              <select
                value={hour}
                onChange={(e) => handleHourChange(e.target.value)}
                className="input-base input-sm flex-1"
                aria-label="小时"
              >
                {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
              <span className="text-[var(--muted-foreground)]">:</span>
              <select
                value={minute}
                onChange={(e) => handleMinuteChange(e.target.value)}
                className="input-base input-sm flex-1"
                aria-label="分钟"
              >
                {MINUTE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          )}
          {preset === 'hourly' && (
            <div className="flex items-center gap-2">
              <FieldLabel className="shrink-0 w-16">分钟</FieldLabel>
              <select
                value={minute}
                onChange={(e) => handleMinuteChange(e.target.value)}
                className="input-base input-sm flex-1"
                aria-label="分钟"
              >
                {MINUTE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          )}

          {/* 自定义 cron：5 字段卡 + 状态行 */}
          {preset === 'custom' && (
            <div className="flex flex-col gap-1">
              <FieldLabel>cron 表达式</FieldLabel>
              <input
                type="text"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="例如 0 9 * * 1-5"
                spellCheck={false}
                className="input-base input-sm font-mono"
                aria-invalid={!!cronError}
              />
              <div className="mt-1 grid grid-cols-5 gap-1.5">
                {FIELD_KEYS.map((key, i) => (
                  <div
                    key={key}
                    className="min-w-0 rounded-md border px-1.5 py-1 text-center"
                    style={{ borderColor: 'var(--border)', background: 'var(--muted)' }}
                  >
                    <div className="truncate text-[10px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                      {FIELD_LABELS[key]}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px]" style={{ color: 'var(--foreground)' }}>
                      {fieldValues[i]}
                    </div>
                  </div>
                ))}
              </div>
              <div
                className="mt-1 flex min-h-8 items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
                style={
                  cronError
                    ? { borderColor: 'var(--destructive)', background: 'var(--destructive-soft)', color: 'var(--destructive)' }
                    : { borderColor: 'var(--border)', background: 'var(--muted)', color: 'var(--muted-foreground)' }
                }
              >
                <span className="min-w-0 truncate">{cronError ? `非法：${cronError}` : label || '空'}</span>
              </div>
            </div>
          )}

          {/* 时区（默认 Asia/Shanghai；开放编辑以便将来多区域场景） */}
          <div className="flex items-center gap-2">
            <FieldLabel className="shrink-0 w-16">时区</FieldLabel>
            <input
              type="text"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="input-base input-sm flex-1"
              placeholder="IANA 时区名，如 Asia/Shanghai"
            />
          </div>

          {/* 下次执行预览 */}
          <div className="flex items-baseline justify-between gap-2 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            <span className="truncate">{label}</span>
            {nextRun && <span>下次执行：{formatLocal(nextRun, timezone)}</span>}
          </div>

          <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            立即启用（取消勾选则仅保存，不入队）
          </label>

          {error && (
            <div className="text-[12px]" style={{ color: 'var(--destructive)' }}>
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>取消</Button>
          <Button onClick={submit} disabled={submitting || !!cronError || !cronExpr.trim()}>
            {submitting ? '提交中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 把 Date 渲染成「YYYY-MM-DD HH:mm」并按 tz 校准。 */
function formatLocal(d: Date, tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return fmt.format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}
