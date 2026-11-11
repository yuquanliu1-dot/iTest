import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EXPLORATION_PERSONAS } from '@itest/shared';
import { localizeApiError } from '../i18n';
import { api } from '../api/client';
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
  const [title, setTitle] = useState('');
  // 人格多选：选 1 个=单会话；选 ≥2 个=人格矩阵（同一章程并行起多路，建组跳矩阵视图）。
  // 单入口不拆两个弹窗——同能力不做双入口。
  const [personas, setPersonas] = useState<string[]>(['qa']);
  const [matrixLabel, setMatrixLabel] = useState('');
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
        ...(title.trim() ? { title: title.trim() } : {}),
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
        ...(matrixLabel.trim() ? { label: matrixLabel.trim() } : {}),
      });
      return { single: false, id: m.matrixId };
    },
    onSuccess: (r) => {
      setCharter('');
      setTitle('');
      setStartUrl('');
      setPersonas(['qa']);
      setMatrixLabel('');
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
            {sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => openDetail(s.id)}
                className="bg-card border rounded-[var(--radius-md)] p-4 cursor-pointer hover-card"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
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
                  <Icon name="chevronRight" size={14} className="shrink-0 mt-1" />
                </div>
              </div>
            ))}
          </div>
        )}
      </PageShellContent>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('explorations:newSession')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>
                {t('explorations:charter')}
              </label>
              <textarea
                className="input-base"
                rows={5}
                value={charter}
                placeholder={t('explorations:charterPlaceholder')}
                onChange={(e) => setCharter(e.target.value)}
              />
              <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                {t('explorations:charterHint')}
              </span>
            </div>
            {/* 人格多选（单入口）：1 个=单会话；≥2 个=矩阵并行——提交行为随选择数分叉 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
            <Input
              label={t('explorations:sessionName')}
              placeholder={t('explorations:sessionNamePlaceholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            {/* 矩阵名只在多视角（≥2 个人格）时出现 */}
            {personas.length >= 2 && (
              <Input
                label={t('explorations:matrixLabel')}
                placeholder={t('explorations:matrixLabelPlaceholder')}
                value={matrixLabel}
                onChange={(e) => setMatrixLabel(e.target.value)}
              />
            )}
            {/* 测试窗口：默认 1280×800 / 自定义宽高（同用例详情的窗口策略，两态版） */}
            <div className="flex flex-col gap-2">
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:windowStrategy')}</span>
              <Segmented
                value={windowMode}
                onChange={setWindowMode}
                options={[
                  { label: t('explorations:windowDefault'), value: 'default' },
                  { label: t('cases:windowCustom'), value: 'custom' },
                ]}
              />
              {windowMode === 'custom' && (
                <div className="flex gap-3">
                  <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                    {t('cases:width')}
                    <Input
                      type="number"
                      value={windowWidth ?? ''}
                      onChange={(e) => setWindowWidth(e.target.value === '' ? undefined : Number(e.target.value))}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                    {t('cases:height')}
                    <Input
                      type="number"
                      value={windowHeight ?? ''}
                      onChange={(e) => setWindowHeight(e.target.value === '' ? undefined : Number(e.target.value))}
                    />
                  </label>
                </div>
              )}
            </div>
            {/* 轮次预算：软预算，超界优雅收尾（已发现的 findings 全保留） */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
            {/* 破坏性操作授权：默认拒。勾了才允许探索点删除/支付/发送这类不可逆入口——
                章程说辞不算授权（机械闸只认这个开关）。 */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <Toggle
                  checked={allowDestructive}
                  onChange={setAllowDestructive}
                  label={t('explorations:allowDestructive')}
                />
              </div>
              <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                {t('explorations:allowDestructiveHint')}
              </span>
            </div>
            {/* 故障注入授权：默认拒。勾了才允许探索注入断网/慢网/CPU 节流验证错误处理与降级——
                故障会打断被测系统自身轮询/心跳，章程说辞不算授权；会话结束自动复原。 */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <Toggle
                  checked={allowFaultInjection}
                  onChange={setAllowFaultInjection}
                  label={t('explorations:allowFaultInjection')}
                />
              </div>
              <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                {t('explorations:allowFaultInjectionHint')}
              </span>
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
    </PageShell>
  );
}
