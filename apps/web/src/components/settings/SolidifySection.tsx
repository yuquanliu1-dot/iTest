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
        {/* 批次历史：最新在前；running 转终态由轮询+invalidate 收口 */}
        <div className="flex flex-col gap-1">
          {(batchesQ.data ?? []).length === 0 ? (
            <div className="px-2 py-1 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('settings:solidifyBatchEmpty')}
            </div>
          ) : (batchesQ.data ?? []).slice(0, 5).map((b) => (
            <div key={b.id} className="flex items-center gap-2 px-2 py-1">
              <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                {t(`settings:${BATCH_STATUS_KEY[b.status]}`)}
              </span>
              <span className="text-[11px] truncate flex-1" style={{ color: 'var(--muted-foreground)' }}>
                {b.error ?? b.inputSummary ?? new Date(b.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
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
              {t(`settings:${p.kind === 'prompt_amendment' ? 'solidifyKindPrompt' : 'solidifyKindSkill'}`)}
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{detail?.title ?? ''}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="px-5 py-3 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                <span className="text-[10px] px-1.5 py-[1px] rounded" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                  {t(`settings:${detail.kind === 'prompt_amendment' ? 'solidifyKindPrompt' : 'solidifyKindSkill'}`)}
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
                  <label key={s.id} className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer" style={{ background: 'var(--muted)' }}>
                    <input
                      type="checkbox"
                      checked={retireIds.includes(s.id)}
                      onChange={(e) => setRetireIds((prev) =>
                        e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id))}
                    />
                    <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--card)', color: 'var(--muted-foreground)' }}>
                      {s.type === 'memory' ? 'memory' : 'trajectory'}
                    </span>
                    <span className="text-[11px] truncate flex-1" style={{ color: 'var(--foreground)' }}>{s.title}</span>
                    <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>{s.lineName}</span>
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
