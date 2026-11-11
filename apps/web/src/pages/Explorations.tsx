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
  const [persona, setPersona] = useState('qa');
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

  const create = useMutation({
    mutationFn: () =>
      api.explorations.create({
        versionId: versionId!,
        charter: charter.trim(),
        persona,
        allowDestructive,
        allowFaultInjection,
        budgetTurns,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(startUrl.trim() ? { startUrl: startUrl.trim() } : {}),
        ...(windowMode === 'custom' && windowCustomReady ? { windowWidth, windowHeight } : {}),
      }),
    onSuccess: (s) => {
      setCharter('');
      setTitle('');
      setStartUrl('');
      setPersona('qa');
      setAllowDestructive(false);
      setAllowFaultInjection(false);
      setBudgetTurns(24);
      setWindowMode('default');
      setWindowWidth(undefined);
      setWindowHeight(undefined);
      setShowCreate(false);
      toast(t('explorations:createdToast'), 'success');
      qc.invalidateQueries({ queryKey: ['explorations'] });
      navigate(`/p/${projectId}/v/${versionId}/explorations/${s.id}`);
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // ── 人格矩阵（C3）：同一章程起 N 个人格会话并行跑，建组后跳矩阵视图看各会话进度 ──
  const [showMatrix, setShowMatrix] = useState(false);
  const [matrixPersonas, setMatrixPersonas] = useState<string[]>(['qa']);
  const [matrixLabel, setMatrixLabel] = useState('');
  const togglePersona = (key: string) =>
    setMatrixPersonas((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const createMatrix = useMutation({
    mutationFn: () =>
      api.explorations.createMatrix({
        versionId: versionId!,
        charter: charter.trim(),
        personas: matrixPersonas,
        allowDestructive,
        allowFaultInjection,
        ...(startUrl.trim() ? { startUrl: startUrl.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(matrixLabel.trim() ? { label: matrixLabel.trim() } : {}),
      }),
    onSuccess: (m) => {
      setCharter('');
      setTitle('');
      setStartUrl('');
      setMatrixPersonas(['qa']);
      setMatrixLabel('');
      setAllowDestructive(false);
      setAllowFaultInjection(false);
      setShowMatrix(false);
      toast(t('explorations:matrixCreatedToast'), 'success');
      qc.invalidateQueries({ queryKey: ['explorations'] });
      navigate(`/p/${projectId}/v/${versionId}/explorations/matrix/${m.matrixId}`);
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const openDetail = (id: string) => navigate(`/p/${projectId}/v/${versionId}/explorations/${id}`);

  return (
    <PageShell>
      <PageShellHeader>
        <PageShellTitle>{t('explorations:title')}</PageShellTitle>
        <PageShellActions>
          <Button variant="ghost" onClick={() => setShowMatrix(true)}>
            <Icon name="grid" size={14} />
            {t('explorations:newMatrix')}
          </Button>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>
                {t('explorations:persona')}
              </label>
              <select className="input-base" value={persona} onChange={(e) => setPersona(e.target.value)}>
                {EXPLORATION_PERSONAS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {personaLabel(p.key, i18n.language)}
                  </option>
                ))}
              </select>
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
            <Button disabled={charter.trim().length < 10 || !windowCustomReady || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? t('common:loading') : t('explorations:newSession')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 人格矩阵（C3）：同一章程复用单建弹窗的章程/标题/起始 URL/授权位，
          差异只在「选多个 persona 各起一个会话」。矩阵精简掉窗口/预算自定义（用默认值）。 */}
      <Dialog open={showMatrix} onOpenChange={setShowMatrix}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('explorations:newMatrix')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('explorations:matrixHint')}
            </div>
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
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>
                {t('explorations:matrixPersonas')}
              </label>
              <div className="flex flex-wrap gap-2">
                {EXPLORATION_PERSONAS.map((p) => {
                  const selected = matrixPersonas.includes(p.key);
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
            <Input
              label={t('explorations:matrixLabel')}
              placeholder={t('explorations:matrixLabelPlaceholder')}
              value={matrixLabel}
              onChange={(e) => setMatrixLabel(e.target.value)}
            />
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <Toggle checked={allowDestructive} onChange={setAllowDestructive} label={t('explorations:allowDestructive')} />
              </div>
              <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{t('explorations:allowDestructiveHint')}</span>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <Toggle
                  checked={allowFaultInjection}
                  onChange={setAllowFaultInjection}
                  label={t('explorations:allowFaultInjection')}
                />
              </div>
              <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{t('explorations:allowFaultInjectionHint')}</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowMatrix(false)}>{t('common:cancel')}</Button>
            <Button
              disabled={charter.trim().length < 10 || matrixPersonas.length === 0 || createMatrix.isPending}
              onClick={() => createMatrix.mutate()}
            >
              {createMatrix.isPending
                ? t('common:loading')
                : `${t('explorations:matrixCreate')}（${matrixPersonas.length}）`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
