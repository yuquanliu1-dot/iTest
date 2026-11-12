import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EXPLORATION_PERSONAS } from '@itest/shared';
import { localizeApiError } from '../i18n';
import { api, type ExplorationSession } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import EmptyState from '../components/ui/EmptyState';
import StatusPill from '../components/ui/StatusPill';
import Toggle from '../components/ui/Toggle';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/Modal';
import Segmented from '../components/ui/Segmented';
import { fullDateTime } from '../lib/format';
import { creatorName } from '../lib/creatorName';
import {
  PageShell,
  PageShellActions,
  PageShellContent,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
} from '../components/layout/PageShell';

/** 人格下拉的文案：单一真源在 @itest/shared（labelZh/labelEn），此处按当前语言取一侧。 */
function personaLabel(key: string, lang: string): string {
  const p = EXPLORATION_PERSONAS.find((x) => x.key === key);
  if (!p) return key;
  return lang.startsWith('en') ? p.labelEn : p.labelZh;
}

export default function Explorations() {
  const { projectId, versionId } = useParams<{ projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['explorations', projectId, versionId],
    queryFn: () => api.explorations.list({ versionId }),
    enabled: !!versionId,
  });
  const sessions = data?.items ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [charter, setCharter] = useState('');
  // 人格多选：选 1 个=单会话；选 ≥2 个=人格矩阵（同一章程并行起多路，建组跳矩阵视图）。
  // 单入口不拆两个弹窗——同能力不做双入口。
  // 不收会话标题/矩阵名：api 侧有默认（title=章程前 80 字、label=N 人格矩阵），少填两项少一道坎。
  const [personas, setPersonas] = useState<string[]>(['qa']);
  const [startUrl, setStartUrl] = useState('');
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [allowFaultInjection, setAllowFaultInjection] = useState(false);
  // 轮次预算：默认 24（后端同默认，范围 4~60）；清空=不传=后端默认。
  const [budgetTurns, setBudgetTurns] = useState<number | undefined>(24);
  // 测试窗口两态：默认 1280×800 / 自定义宽高（对齐用例详情的窗口策略；探索 headless 无「当前窗口」态）。
  const [windowMode, setWindowMode] = useState<'default' | 'custom'>('default');
  const [windowWidth, setWindowWidth] = useState<number | undefined>();
  const [windowHeight, setWindowHeight] = useState<number | undefined>();
  const windowCustomReady = windowMode !== 'custom' || ((windowWidth ?? 0) > 0 && (windowHeight ?? 0) > 0);

  const togglePersona = (key: string) =>
    setPersonas((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  // 单入口提交：选 1 个人格=单会话（进详情页）；≥2=矩阵建组（进矩阵视图）。
  // 窗口/预算对矩阵同样生效（后端矩阵接口逐字段透传给每个会话）。
  const create = useMutation({
    mutationFn: async () => {
      const shared = {
        versionId: versionId!,
        charter: charter.trim(),
        allowDestructive,
        allowFaultInjection,
        budgetTurns,
        ...(startUrl.trim() ? { startUrl: startUrl.trim() } : {}),
        ...(windowMode === 'custom' && windowCustomReady ? { windowWidth, windowHeight } : {}),
      };
      if (personas.length === 1) {
        const s = await api.explorations.create({ ...shared, persona: personas[0] });
        return { single: true, id: s.id };
      }
      const m = await api.explorations.createMatrix({
        ...shared,
        personas,
      });
      return { single: false, id: m.matrixId };
    },
    onSuccess: (r) => {
      setCharter('');
      setStartUrl('');
      setPersonas(['qa']);
      setAllowDestructive(false);
      setAllowFaultInjection(false);
      setBudgetTurns(24);
      setWindowMode('default');
      setWindowWidth(undefined);
      setWindowHeight(undefined);
      setShowCreate(false);
      toast(t(r.single ? 'explorations:createdToast' : 'explorations:matrixCreatedToast'), 'success');
      qc.invalidateQueries({ queryKey: ['explorations'] });
      navigate(
        r.single
          ? `/p/${projectId}/v/${versionId}/explorations/${r.id}`
          : `/p/${projectId}/v/${versionId}/explorations/matrix/${r.id}`,
      );
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const openDetail = (id: string) => navigate(`/p/${projectId}/v/${versionId}/explorations/${id}`);

  // ── 卡片行内操作：取消 / 重跑 / 删除（语义与可见条件同详情页） ──────────
  // 不进详情页就能处置会话：取消=跑得快停；重跑=同章程开新会话；删除=不可逆，走确认弹窗。
  const listKey = ['explorations', projectId, versionId] as const;
  const cancelOne = useMutation({
    mutationFn: (id: string) => api.explorations.cancel(id),
    onSuccess: () => {
      toast(t('explorations:cancelRequested'), 'success');
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const rerunOne = useMutation({
    mutationFn: (s: ExplorationSession) =>
      api.explorations.create({
        versionId: versionId!,
        charter: s.charter,
        persona: s.persona,
        allowDestructive: s.allowDestructive,
        allowFaultInjection: s.allowFaultInjection,
        ...(s.startUrl ? { startUrl: s.startUrl } : {}),
        ...(s.windowWidth && s.windowHeight
          ? { windowWidth: s.windowWidth, windowHeight: s.windowHeight }
          : {}),
      }),
    onSuccess: () => {
      toast(t('explorations:rerunCreated'), 'success');
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // 删除不可逆（连带缺陷候选与证据截图）→ 卡片上先确认，不做一键即删。
  const [deleteTarget, setDeleteTarget] = useState<ExplorationSession | null>(null);
  const removeOne = useMutation({
    mutationFn: (id: string) => api.explorations.remove(id),
    onSuccess: () => {
      toast(t('explorations:deletedToast'), 'success');
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  return (
    <PageShell>
      <PageShellHeader>
        <PageShellTitle>{t('explorations:title')}</PageShellTitle>
        <PageShellActions>
          <Button onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={14} />
            {t('explorations:newSession')}
          </Button>
        </PageShellActions>
        <PageShellDescription>{t('explorations:pageHint')}</PageShellDescription>
      </PageShellHeader>

      <PageShellContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>{t('cases:loading')}</span>
          </div>
        ) : isError ? (
          <div className="flex items-center justify-center py-12 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('common:loadFailed')}：{error?.message ?? t('common:unknownError')}
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon="search"
            title={t('explorations:noSessions')}
            description={t('explorations:noSessionsHint')}
            action={
              <Button size="sm" onClick={() => setShowCreate(true)}>
                + {t('explorations:newSession')}
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {sessions.map((s) => {
              const live = s.status === 'running' || s.status === 'pending';
              return (
                <div
                  key={s.id}
                  onClick={() => openDetail(s.id)}
                  className="bg-card border rounded-[var(--radius-md)] p-4 cursor-pointer hover-card"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[14px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>
                          {s.title || t('explorations:emptySession')}
                        </span>
                        <StatusPill status={s.status} pulse={s.status === 'running'}>
                          {t(`cases:status.${s.status}`)}
                        </StatusPill>
                        {s.matrixId && (
                          <span
                            className="px-1.5 py-0.5 rounded text-[10px]"
                            style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
                            title={s.matrixLabel ?? s.matrixId}
                          >
                            {s.matrixLabel || t('explorations:newMatrix')}
                            {s.matrixRole ? ` · ${personaLabel(s.matrixRole, i18n.language)}` : ''}
                          </span>
                        )}
                        {/* 缺陷候选数：列表页一眼看出这轮探出了几个疑点——
                            有候选时用警示色显性标出（数字放大加粗），0 个弱化成灰底，
                            不与真有疑点的卡片抢眼。 */}
                        <span
                          className="flex items-center gap-1 rounded-full px-2 py-0.5"
                          style={
                            (s.findingsCount ?? 0) > 0
                              ? {
                                  background: 'var(--warning-soft)',
                                  color: 'var(--warning)',
                                  boxShadow: 'inset 0 0 0 1px var(--warning-soft-border)',
                                }
                              : { background: 'var(--muted)', color: 'var(--muted-foreground)' }
                          }
                          title={t('explorations:findings')}
                        >
                          <Icon name="beaker" size={11} />
                          <span className="text-[11px]">{t('explorations:findings')}</span>
                          <span className="text-[13px] font-semibold tabular-nums leading-none">
                            {s.findingsCount ?? 0}
                          </span>
                        </span>
                      </div>
                      <div className="text-[12px] mt-1.5 line-clamp-2" style={{ color: 'var(--muted-foreground)' }}>
                        {s.charter}
                      </div>
                      <div className="text-[11px] mt-2 flex items-center gap-2 flex-wrap" style={{ color: 'var(--muted-foreground)' }}>
                        <span>{t('explorations:personaLabel')}：{personaLabel(s.persona, i18n.language)}</span>
                        <span>·</span>
                        <span>{fullDateTime(s.createdAt)}</span>
                        <span>·</span>
                        <span>{t('explorations:createdBy')}：{creatorName(s.createdBy)}</span>
                      </div>
                    </div>
                    {/* 行内操作：进详情页之外的快捷处置。按钮区 stopPropagation，点击不触发开详情。 */}
                    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      {live ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => cancelOne.mutate(s.id)}
                          disabled={cancelOne.isPending || s.cancelRequested}
                          title={s.cancelRequested ? t('explorations:cancelRequested') : t('explorations:cancel')}
                          aria-label={t('explorations:cancel')}
                        >
                          <Icon name="pause" size={12} />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => rerunOne.mutate(s)}
                          disabled={rerunOne.isPending}
                          title={t('explorations:rerun')}
                          aria-label={t('explorations:rerun')}
                        >
                          <Icon name="renew" size={12} />
                        </Button>
                      )}
                      {/* 运行中的会话禁删（执行器还在往里写）；已请求取消的放行。 */}
                      {(!live || s.cancelRequested) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(s)}
                          style={{ color: 'var(--destructive)' }}
                          title={t('explorations:deleteSession')}
                          aria-label={t('explorations:deleteSession')}
                        >
                          <Icon name="trash" size={12} />
                        </Button>
                      )}
                      <Icon name="chevronRight" size={14} className="shrink-0 mt-1" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PageShellContent>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        {/* 两列栅格 + 收敛后的提示文案：常见视口（含 1280×720）下一屏装下，不用滚动 */}
        <DialogContent className="sm:max-w-2xl p-3 gap-3">
          <DialogHeader>
            <DialogTitle>{t('explorations:newSession')}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-1 py-1">
            <div className="col-span-2 flex flex-col gap-1">
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>
                {t('explorations:charter')}
              </label>
              <textarea
                className="input-base"
                rows={3}
                value={charter}
                placeholder={t('explorations:charterPlaceholder')}
                onChange={(e) => setCharter(e.target.value)}
              />
              <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                {t('explorations:charterHint')}
              </span>
            </div>
            {/* 人格多选（单入口）：1 个=单会话；≥2 个=矩阵并行——提交行为随选择数分叉 */}
            <div className="col-span-2 flex flex-col gap-1">
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>
                {t('explorations:matrixPersonas')}
              </label>
              <div className="flex flex-wrap gap-2">
                {EXPLORATION_PERSONAS.map((p) => {
                  const selected = personas.includes(p.key);
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => togglePersona(p.key)}
                      className="px-2.5 py-1 rounded-full text-[12px] border transition-colors"
                      style={{
                        borderColor: selected ? 'var(--primary)' : 'var(--border)',
                        background: selected ? 'var(--primary-soft, var(--muted))' : 'transparent',
                        color: selected ? 'var(--primary)' : 'var(--muted-foreground)',
                      }}
                    >
                      {personaLabel(p.key, i18n.language)}
                    </button>
                  );
                })}
              </div>
              <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                {t('explorations:matrixPersonasHint')}
              </span>
            </div>
            <Input
              label={t('explorations:startUrl')}
              placeholder={t('explorations:startUrlPlaceholder')}
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
            />
            {/* 轮次预算：软预算，超界优雅收尾（已发现的 findings 全保留） */}
            <div className="flex flex-col gap-1">
              <Input
                label={t('explorations:budgetTurns')}
                type="number"
                min={4}
                max={60}
                value={budgetTurns ?? ''}
                onChange={(e) => setBudgetTurns(e.target.value === '' ? undefined : Number(e.target.value))}
              />
              <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                {t('explorations:budgetTurnsHint')}
              </span>
            </div>
            {/* 测试窗口：默认 1280×800 / 自定义宽高（同用例详情的窗口策略，两态版） */}
            <div className="col-span-2 flex items-end gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:windowStrategy')}</span>
                <Segmented
                  value={windowMode}
                  onChange={setWindowMode}
                  options={[
                    { label: t('explorations:windowDefault'), value: 'default' },
                    { label: t('cases:windowCustom'), value: 'custom' },
                  ]}
                />
              </div>
              {windowMode === 'custom' && (
                <>
                  <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                    {t('cases:width')}
                    <Input
                      size="sm"
                      type="number"
                      value={windowWidth ?? ''}
                      onChange={(e) => setWindowWidth(e.target.value === '' ? undefined : Number(e.target.value))}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                    {t('cases:height')}
                    <Input
                      size="sm"
                      type="number"
                      value={windowHeight ?? ''}
                      onChange={(e) => setWindowHeight(e.target.value === '' ? undefined : Number(e.target.value))}
                    />
                  </label>
                </>
              )}
            </div>
            {/* 两个授权开关并排：默认拒。章程说辞不算授权（机械闸只认这两个开关）。 */}
            <div className="col-span-2 grid grid-cols-2 gap-x-3 gap-y-1">
              <div className="flex flex-col gap-1">
                <Toggle
                  checked={allowDestructive}
                  onChange={setAllowDestructive}
                  label={t('explorations:allowDestructive')}
                />
                <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                  {t('explorations:allowDestructiveHint')}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <Toggle
                  checked={allowFaultInjection}
                  onChange={setAllowFaultInjection}
                  label={t('explorations:allowFaultInjection')}
                />
                <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                  {t('explorations:allowFaultInjectionHint')}
                </span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>{t('common:cancel')}</Button>
            <Button
              disabled={charter.trim().length < 10 || personas.length === 0 || !windowCustomReady || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending
                ? t('common:loading')
                : personas.length >= 2
                  ? `${t('explorations:matrixCreate')}（${personas.length}）`
                  : t('explorations:newSession')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除会话确认：不可逆（连带缺陷候选与证据截图） */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('explorations:deleteSession')}</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-2 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('explorations:deleteConfirm')}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>{t('common:cancel')}</Button>
            <Button
              variant="danger"
              disabled={removeOne.isPending}
              onClick={() => deleteTarget && removeOne.mutate(deleteTarget.id)}
            >
              {removeOne.isPending ? t('common:loading') : t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
