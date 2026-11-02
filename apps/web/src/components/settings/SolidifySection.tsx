import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localizeApiError } from '../../i18n';
import { api, type SolidifyBatch, type SolidifyProposal } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';

const BATCH_STATUS_KEY: Record<SolidifyBatch['status'], string> = {
  running: 'solidifyBatchRunning', done: 'solidifyBatchDone', failed: 'solidifyBatchFailed',
};
const PROPOSAL_STATUS_KEY: Record<SolidifyProposal['status'], string> = {
  pending: 'solidifyStatusPending', approved: 'solidifyStatusApproved', rejected: 'solidifyStatusRejected',
};
const KIND_KEY: Record<SolidifyProposal['kind'], string> = {
  prompt_amendment: 'solidifyKindPrompt', skill_revision: 'solidifyKindSkill', prompt_correction: 'solidifyKindCorrect',
};
const LESSON_ATTRIBUTION_KEY: Record<string, string> = {
  prompt: 'lessonAttributionPrompt', step_description: 'lessonAttributionStep',
  platform: 'lessonAttributionPlatform', sut: 'lessonAttributionSut',
};

/** inputSummary 是服务端 JSON.stringify 的 {memories,trajectories,lessons,signals,proposals,notes[]}；解析失败回 null（行内回退显示时间）。 */
function batchSummary(raw: string | null): { memories: number; trajectories: number; lessons: number; signals: number; proposals: number; notes: string[] } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { memories?: number; trajectories?: number; lessons?: number; signals?: number; proposals?: number; notes?: string[] };
    return {
      memories: v.memories ?? 0, trajectories: v.trajectories ?? 0,
      lessons: v.lessons ?? 0, signals: v.signals ?? 0,
      proposals: v.proposals ?? 0, notes: Array.isArray(v.notes) ? v.notes : [],
    };
  } catch { return null; }
}

/** 设置页「固化盘点」：发起盘点（409 防重入 toast）→ 轮询批次 → 提案列表 → 详情 diff + 退役勾选 → 批准/驳回。 */
export default function SolidifySection() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const batchesQ = useQuery({
    queryKey: ['solidify-batches'],
    queryFn: () => api.assistant.solidify.batches(),
    // running 存在时 3s 轮询；终态停表（refetchInterval 函数式，v5 语义）
    refetchInterval: (query) => ((query.state.data ?? []).some((b) => b.status === 'running') ? 3000 : false),
  });
  const hasRunning = (batchesQ.data ?? []).some((b) => b.status === 'running');

  const proposalsQ = useQuery({
    queryKey: ['solidify-proposals'],
    queryFn: () => api.assistant.solidify.proposals(),
    refetchInterval: hasRunning ? 5000 : false, // 批次 running 期间顺带刷新提案；done 后由 invalidate 收口
  });
  // 当前值来源（叠加预览/skill 对照左栏）：复用 prompt 模块列表
  const modulesQ = useQuery({
    queryKey: ['prompt-modules'],
    queryFn: () => api.assistant.promptModules.list(),
    staleTime: 60_000,
  });
  // R3.5 失败教训：三个状态并行拉，active 渲染列表，resolved/retired 折叠成计数
  const lessonsQ = useQuery({
    queryKey: ['failure-lessons'],
    queryFn: async () => {
      const [active, resolved, retired] = await Promise.all([
        api.assistant.failureLessons.list('active'),
        api.assistant.failureLessons.list('resolved'),
        api.assistant.failureLessons.list('retired'),
      ]);
      return { active, resolved, retired };
    },
  });
  const retireLesson = useMutation({
    mutationFn: (id: string) => api.assistant.failureLessons.retire(id),
    onSuccess: () => {
      toast(t('settings:solidifyReviewed'), 'success');
      qc.invalidateQueries({ queryKey: ['failure-lessons'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const [openId, setOpenId] = useState<string | null>(null);
  const [retireIds, setRetireIds] = useState<string[]>([]);
  const detailQ = useQuery({
    queryKey: ['solidify-proposal', openId],
    queryFn: () => api.assistant.solidify.proposal(openId!),
    enabled: !!openId,
  });
  const detail = detailQ.data ?? null;

  const scan = useMutation({
    mutationFn: () => api.assistant.solidify.scan(),
    onSuccess: () => {
      toast(t('settings:solidifyScanning'), 'success');
      qc.invalidateQueries({ queryKey: ['solidify-batches'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });
  const review = useMutation({
    mutationFn: (args: { id: string; approve: boolean }) =>
      args.approve
        ? api.assistant.solidify.approve(args.id, retireIds)
        : api.assistant.solidify.reject(args.id),
    onSuccess: (_r, args) => {
      toast(t('settings:solidifyReviewed'), 'success');
      setOpenId(null);
      qc.invalidateQueries({ queryKey: ['solidify-proposals'] });
      qc.invalidateQueries({ queryKey: ['prompt-modules'] }); // 应用会写版本行/改 skill
      if (args.approve) {
        // 退役发生在批准：记忆/轨迹列表里被勾选来源随之消失（active 口径）
        qc.invalidateQueries({ queryKey: ['assistant-memories'] });
        qc.invalidateQueries({ queryKey: ['assistant-trajectories'] });
        // correction 应用 → sources 内 lesson 自动 resolved → 教训块收口
        qc.invalidateQueries({ queryKey: ['failure-lessons'] });
      }
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const openProposal = (p: SolidifyProposal) => {
    setRetireIds(p.sources.filter((s) => s.retireRecommended).map((s) => s.id)); // 预填建议值，人工可改
    setOpenId(p.id);
  };

  const proposals = useMemo(
    () => [...(proposalsQ.data ?? [])].sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0)),
    [proposalsQ.data],
  );
  const currentText = useMemo(() => {
    if (!detail) return '';
    const key = detail.kind === 'skill_revision' ? `skill.${detail.target}` : detail.target;
    return modulesQ.data?.find((m) => m.key === key)?.text ?? '';
  }, [detail, modulesQ.data]);

  return (
    <div className="bg-card border rounded-[var(--radius-sm)]">
      <div className="flex items-center gap-2 px-4 py-3 hairline-bottom" style={{ borderColor: 'var(--border)' }}>
        <Icon name="sparkles" size={14} style={{ color: 'var(--primary)' }} />
        <h3 className="text-[14px] font-semibold m-0 flex-1" style={{ color: 'var(--foreground)' }}>
          {t('settings:solidifyTitle')}
        </h3>
        <Button variant="primary" disabled={scan.isPending || hasRunning} onClick={() => scan.mutate()}>
          {hasRunning ? t('settings:solidifyScanning') : t('settings:solidifyScan')}
        </Button>
      </div>
      <div className="px-4 pt-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
        {t('settings:solidifyIntro')}
      </div>
      <div className="p-2 flex flex-col gap-3">
        {/* R3.5 失败教训：active 列表（≤10）+ 折叠计数；retire=人工驳回（误报/不修） */}
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium px-2" style={{ color: 'var(--muted-foreground)' }}>
            {t('settings:lessonBlockTitle')}
            {lessonsQ.data && (lessonsQ.data.resolved.length > 0 || lessonsQ.data.retired.length > 0) && (
              <span className="ml-2 font-normal">
                {t('settings:lessonSettledCounts', { resolved: lessonsQ.data.resolved.length, retired: lessonsQ.data.retired.length })}
              </span>
            )}
          </div>
          {(lessonsQ.data?.active ?? []).length === 0 ? (
            <div className="px-2 py-1 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>{t('settings:lessonEmpty')}</div>
          ) : (lessonsQ.data?.active ?? []).slice(0, 10).map((l) => (
            <div key={l.id} className="flex items-center gap-2 px-2 py-1">
              <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                {t(`settings:${LESSON_ATTRIBUTION_KEY[l.attribution] ?? 'lessonAttributionPrompt'}`)}
              </span>
              <span className="text-[12px] truncate flex-1" style={{ color: 'var(--foreground)' }} title={l.lesson}>{l.title}</span>
              <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                {t('settings:lessonSignalCount', { count: l.signals?.length ?? 0 })}
              </span>
              <button type="button" className="text-[11px] shrink-0" style={{ color: 'var(--muted-foreground)' }}
                disabled={retireLesson.isPending} onClick={() => retireLesson.mutate(l.id)}>
                {t('settings:lessonIgnore')}
              </button>
            </div>
          ))}
        </div>
        {/* 批次历史：最新在前；running 转终态由轮询+invalidate 收口 */}
        <div className="flex flex-col gap-1">
          {(batchesQ.data ?? []).length === 0 ? (
            <div className="px-2 py-1 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('settings:solidifyBatchEmpty')}
            </div>
          ) : (batchesQ.data ?? []).slice(0, 5).map((b) => {
            const s = batchSummary(b.inputSummary);
            const text = b.error
              ?? (s
                ? `${t('settings:solidifyBatchSummary', { memories: s.memories, trajectories: s.trajectories, lessons: s.lessons, signals: s.signals, proposals: s.proposals })}${s.notes[0] ? ` · ${s.notes[0]}` : ''}`
                : null)
              ?? new Date(b.createdAt).toLocaleString();
            return (
              <div key={b.id} className="flex items-center gap-2 px-2 py-1" title={b.error ?? s?.notes.join('\n')}>
                <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                  {t(`settings:${BATCH_STATUS_KEY[b.status]}`)}
                </span>
                <span className="text-[11px] truncate flex-1" style={{ color: 'var(--muted-foreground)' }}>
                  {text}
                </span>
              </div>
            );
          })}
        </div>
        {/* 提案列表 */}
        {proposalsQ.isLoading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
            {t('common:loading')}
          </div>
        ) : proposals.length === 0 ? (
          <EmptyState icon="sparkles" title={t('settings:solidifyProposalNone')} compact />
        ) : proposals.map((p) => (
          <button
            key={p.id}
            type="button"
            className="flex items-center gap-2 px-2 py-2 rounded text-left w-full"
            style={{ background: 'transparent' }}
            onClick={() => openProposal(p)}
          >
            <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
              {t(`settings:${KIND_KEY[p.kind]}`)}
            </span>
            <span className="text-[12px] font-medium truncate flex-1" style={{ color: 'var(--foreground)' }}>{p.title}</span>
            <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
              {t(`settings:${PROPOSAL_STATUS_KEY[p.status]}`)}
            </span>
          </button>
        ))}
      </div>

      {/* 提案详情：diff 双栏 + 来源退役勾选 + 批准/驳回 */}
      <Dialog open={!!openId} onOpenChange={(open) => { if (!open) setOpenId(null); }}>
        {/* 隐式 grid 列 auto 取 items 的 min-content（truncate 来源行=全文宽）会把列撑到超框 →
            显式 minmax(0,1fr) 钳到可用宽。加宽 sm:max-w-3xl 改善双栏 diff 可读性（须 sm: 变体，基础样式带 sm:max-w-lg 会盖掉裸 max-w）。 */}
        <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{detail?.title ?? ''}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="px-5 py-3 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                <span className="text-[10px] px-1.5 py-[1px] rounded" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                  {t(`settings:${KIND_KEY[detail.kind]}`)}
                </span>
                <span>{t('settings:solidifyTarget')}：<code className="font-mono">{detail.target}</code></span>
                <span>{t('settings:solidifyModel')}：{detail.distillModel}</span>
                {detail.appliedAt && <span>{t('settings:solidifyAppliedAt')}：{new Date(detail.appliedAt).toLocaleString()}</span>}
              </div>
              {detail.applyError && (
                <div className="text-[12px] px-2 py-1 rounded" style={{ background: 'var(--destructive-soft)', color: 'var(--destructive)' }}>
                  {t('settings:solidifyApplyError')}：{detail.applyError}
                </div>
              )}
              <div className="flex flex-col gap-1">
                <div className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>{t('settings:solidifyRationale')}</div>
                <div className="text-[12px] whitespace-pre-wrap" style={{ color: 'var(--foreground)' }}>{detail.rationale}</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                    {t(`settings:${detail.kind === 'prompt_amendment' ? 'solidifyIncrement' : 'solidifyCurrent'}`)}
                  </div>
                  <pre className="m-0 p-2 rounded text-[11px] font-mono whitespace-pre-wrap max-h-56 overflow-y-auto"
                    style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                    {detail.kind === 'prompt_amendment' ? detail.body : (currentText || '—')}
                  </pre>
                </div>
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                    {t(`settings:${detail.kind === 'prompt_amendment' ? 'solidifyAppendPreview' : 'solidifyProposed'}`)}
                  </div>
                  <pre className="m-0 p-2 rounded text-[11px] font-mono whitespace-pre-wrap max-h-56 overflow-y-auto"
                    style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                    {detail.kind === 'prompt_amendment' ? `${currentText}\n\n${detail.body}` : detail.body}
                  </pre>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>{t('settings:solidifySources')}</div>
                {detail.sources.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'var(--muted)', cursor: s.type === 'lesson' ? 'default' : 'pointer' }}>
                    {s.type !== 'lesson' && (
                      <input
                        type="checkbox"
                        checked={retireIds.includes(s.id)}
                        onChange={(e) => setRetireIds((prev) =>
                          e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id))}
                      />
                    )}
                    <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--card)', color: 'var(--muted-foreground)' }}>
                      {s.type === 'memory' ? 'memory' : s.type === 'trajectory' ? 'trajectory' : t('settings:solidifySourceLesson')}
                    </span>
                    {s.type === 'lesson' && s.attribution && (
                      <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                        {t(`settings:${LESSON_ATTRIBUTION_KEY[s.attribution] ?? 'lessonAttributionPrompt'}`)}
                      </span>
                    )}
                    {s.type === 'lesson' && s.signalCount != null && (
                      <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                        {t('settings:lessonSignalCount', { count: s.signalCount })}
                      </span>
                    )}
                    <span className="text-[11px] truncate flex-1" style={{ color: 'var(--foreground)' }}>{s.title}</span>
                    {s.type === 'lesson'
                      ? <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{t('settings:lessonAutoResolve')}</span>
                      : <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{s.lineName}</span>}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setOpenId(null)}>{t('common:close')}</Button>
            <Button variant="ghost" disabled={review.isPending} onClick={() => openId && review.mutate({ id: openId, approve: false })}>
              {t('settings:solidifyReject')}
            </Button>
            <Button
              variant="primary"
              disabled={review.isPending || detail?.status !== 'pending'}
              onClick={() => openId && review.mutate({ id: openId, approve: true })}
            >
              {t('settings:solidifyApprove')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
