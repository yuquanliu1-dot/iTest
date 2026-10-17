/**
 * 计划详情页：调度列表卡 + 新增/启停/删除按钮。
 * iDO AutomationListItem 风格：avatar + cron 描述 + 下次执行时间 + 启停开关。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { api, type PlanSchedule, type PlanScheduleCreateInput, type PlanSchedulePatchInput } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import StatusPill from '../ui/StatusPill';
import ScheduleDialog from './ScheduleDialog';
import { formatSchedule } from './schedule-format';

dayjs.extend(relativeTime);

interface Props {
  planId: string;
}

export default function ScheduleListCard({ planId }: Props) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<PlanSchedule | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ['plan', planId, 'schedules'],
    queryFn: () => api.planSchedules.list(planId),
    refetchInterval: 30_000,
  });

  const create = useMutation({
    mutationFn: (body: PlanScheduleCreateInput) => api.planSchedules.create(planId, body),
    onSuccess: () => {
      toast(t('plans:scheduleAdded'), 'success');
      qc.invalidateQueries({ queryKey: ['plan', planId, 'schedules'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: PlanSchedulePatchInput }) =>
      api.planSchedules.patch(id, body),
    onSuccess: () => {
      toast(t('plans:scheduleUpdated'), 'success');
      qc.invalidateQueries({ queryKey: ['plan', planId, 'schedules'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.planSchedules.remove(id),
    onSuccess: () => {
      toast(t('plans:scheduleRemoved'), 'success');
      qc.invalidateQueries({ queryKey: ['plan', planId, 'schedules'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const schedules = list.data ?? [];

  return (
    <div className="bg-card border rounded-[var(--radius-md)] p-5">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-[14px] font-semibold m-0">{t('plans:schedule')}</h2>
        <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {schedules.length === 0 ? t('plans:noSchedule') : t('plans:scheduleCount', { count: schedules.length })}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
          {t('plans:addSchedule')}
        </Button>
      </div>

      {schedules.length === 0 ? (
        <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('plans:addScheduleHint')}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {schedules.map((s) => (
            <ScheduleRow
              key={s.id}
              schedule={s}
              onEdit={() => setEditing(s)}
              onDelete={() => remove.mutate(s.id)}
            />
          ))}
        </div>
      )}

      {(creating || editing) && (
        <ScheduleDialog
          editing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onCreate={async (input) => { await create.mutateAsync(input); }}
          onPatch={async (id, body) => { await patch.mutateAsync({ id, body }); }}
        />
      )}
    </div>
  );
}

function ScheduleRow({
  schedule,
  onEdit,
  onDelete,
}: {
  schedule: PlanSchedule;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const scheduleLabel = formatSchedule(schedule.cronExpr, t) ?? schedule.cronExpr;
  const nextRun = schedule.nextRunAt ? dayjs(schedule.nextRunAt) : null;
  return (
    <div className="flex items-center gap-3 px-3 py-2 border rounded-[var(--radius-sm)]" style={{ borderColor: 'var(--border)' }}>
      <div
        className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
        style={{ background: 'var(--primary-soft)' }}
      >
        <span className="text-[14px]" style={{ color: 'var(--primary)' }}>⌚</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-medium truncate" style={{ color: 'var(--foreground)' }}>
            {scheduleLabel}
          </span>
          <StatusPill tone={schedule.enabled ? 'success' : 'muted'}>
            {schedule.enabled ? t('plans:enabled') : t('plans:paused')}
          </StatusPill>
        </div>
        <div className="text-[11px] mt-0.5 leading-snug truncate" style={{ color: 'var(--muted-foreground)' }}>
          cron <code className="font-mono">{schedule.cronExpr}</code>（{schedule.timezone}）
          {nextRun ? t('plans:nextRunRow', { relative: nextRun.fromNow(), full: nextRun.format('YYYY-MM-DD HH:mm') }) : ''}
        </div>
      </div>
      <IconButton icon="pencil" title={t('cases:edit')} onClick={onEdit} />
      <IconButton icon="trash" title={t('common:delete')} tone="destructive" onClick={onDelete} />
    </div>
  );
}
