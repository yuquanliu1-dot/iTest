import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EXPLORATION_PERSONAS } from '@itest/shared';
import { localizeApiError } from '../i18n';
import { api, type ExplorationFinding } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import StatusPill from '../components/ui/StatusPill';
import PriorityBadge from '../components/ui/PriorityBadge';
import LiveViewCard from '../components/LiveViewCard';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/Modal';
import { fullDateTime } from '../lib/format';
import { creatorName } from '../lib/creatorName';

/** 人格文案：单一真源在 @itest/shared（labelZh/labelEn），此处按当前语言取一侧。 */
function personaLabel(key: string, lang: string): string {
  const p = EXPLORATION_PERSONAS.find((x) => x.key === key);
  if (!p) return key;
  return lang.startsWith('en') ? p.labelEn : p.labelZh;
}

/** 证据截图：/screenshots/<sessionId>/finding-<order>.png，由 express.static 提供。 */
function screenshotUrl(path: string | null): string | null {
  if (!path) return null;
  return path.startsWith('/') ? path : `/${path}`;
}

/** 过程文本钳长：evaluate 的 JSON 原样铺开是过程卡的主要噪声，超长截断 + 行内展开。 */
const STEP_TEXT_CLAMP = 140;

/** URL → path（解析不了原样返回）。 */
function pathOf(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}

/**
 * navigate 落点核对：outcome 恒为「已打开 <page.url()>」（工具层契约，browser.ts）。
 * target 的 path ≠ 实际 path = SPA 重定向/回退（导航受挫），是「为何空手而归」的关键事件。
 * target 为根路径时不判（登录跳转每次会话都有，徽标会疲劳）。
 */
function navLandedMismatch(step: { type: string; ok: boolean; target?: string; outcome?: string }): string | null {
  if (step.type !== 'navigate' || !step.ok || !step.target) return null;
  const m = step.outcome?.match(/^已打开\s+(\S+)/);
  if (!m) return null;
  const targetPath = pathOf(step.target);
  const landedPath = pathOf(m[1]!);
  if (targetPath === landedPath || targetPath === '/') return null;
  return landedPath;
}

/** 代码范围文件分组（机械按扩展名）：组头一行回答「改了哪几块、各多大」。 */
type FileGroupKey = 'sql' | 'java' | 'frontend' | 'other';
function fileGroupOf(path: string): FileGroupKey {
  const p = path.toLowerCase();
  if (p.endsWith('.sql')) return 'sql';
  if (p.endsWith('.java')) return 'java';
  if (/\.(?:vue|js|ts|jsx|tsx|css|scss|less|html)$/.test(p)) return 'frontend';
  return 'other';
}
const FILE_GROUP_ORDER: FileGroupKey[] = ['sql', 'java', 'frontend', 'other'];

/** 变更类型徽标色：A=新增 / D=删除 / M=修改。 */
function fileStatusColor(status: string): string {
  if (status === 'A') return 'var(--success)';
  if (status === 'D') return 'var(--destructive)';
  return 'var(--muted-foreground)';
}

export default function ExplorationDetail() {
  const { id, projectId, versionId } = useParams<{ id: string; projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const { data: session, isLoading, isError, error } = useQuery({
    queryKey: ['exploration', id],
    queryFn: () => api.explorations.get(id!),
    enabled: !!id,
    // pending 也要轮询：会话刚建时是排队态，不轮询的话页面永远停在 pending
    // （不会自己知道开始跑了，也就没有「会话过程」可看）。终态即停。
    refetchInterval: (q) =>
      q.state.data?.status === 'running' || q.state.data?.status === 'pending' ? 2000 : false,
  });

  const findings = session?.findings ?? [];
  const steps = session?.steps ?? [];
  const excluded = session?.excludedLedger ?? [];
  const codeScope = session?.codeScope ?? null;
  const coverage = session?.coverageLedger ?? null;
  const errorSignals = session?.errorSignals ?? [];
  const fileGroups = (() => {
    const files = session?.codeScope?.files ?? [];
    const by = new Map<FileGroupKey, typeof files>();
    for (const f of files) {
      const k = fileGroupOf(f.path);
      const arr = by.get(k) ?? [];
      arr.push(f);
      by.set(k, arr);
    }
    return FILE_GROUP_ORDER.filter((k) => by.has(k)).map((k) => ({ key: k, files: by.get(k)! }));
  })();

  // 画面在不在（有框可看）：LiveViewImg 挂载即上报 true、流断撤框/卸载（含切会话）上报 false
  // （录制只在服务端内存里 TTL 30min，过期后回看没框，会话过程回落整宽卡片）。
  // 切会话的归零由组件卸载 cleanup 负责，页面不自己归零（父级 effect 晚于子级跑，会吃掉上报）。
  const [hasLiveFrame, setHasLiveFrame] = useState(false);
  // 画面高度自适应：LiveViewImg 按列宽等比撑高（框内零留白零裁切）并把实际渲染高度回报上来，
  // 会话过程卡取同一高度 → 两窗顶部同起点、底部恒对齐；220 只是首帧加载前的兜底值。
  const [liveH, setLiveH] = useState(220);
  // 过程卡长文本展开（key = o<序号>/d<序号>）与代码范围分组折叠（key = 组名；缺省 = 文件数>8 收起）。
  const [expandedText, setExpandedText] = useState<Record<string, boolean>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  // 会话过程自动跟滚：运行中新步骤到达时贴底跟随；stepsStick 记录用户是否「盯着底部」——
  // 上翻即暂停，滚回底部恢复（见 stepsBody 上的 onScroll 与下方 effect）。
  const stepsListRef = useRef<HTMLOListElement | null>(null);
  const stepsStickRef = useRef(true);
  // 会话是否在跑（pending 也算）：自动滚动只服务「盯运行中会话」的场景，
  // 终态会话是历史记录，用户从顶往下读，不劫持滚动。早退分支之前算好（hook 不能放早退后）。
  const sessionLive = session?.status === 'running' || session?.status === 'pending';

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['exploration', id] });
    qc.invalidateQueries({ queryKey: ['explorations'] });
  };

  const cancel = useMutation({
    mutationFn: () => api.explorations.cancel(id!),
    onSuccess: () => {
      toast(t('explorations:cancelRequested'), 'success');
      invalidate();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.explorations.remove(id!),
    onSuccess: () => {
      toast(t('explorations:deletedToast'), 'success');
      qc.invalidateQueries({ queryKey: ['explorations'] });
      navigate(`/p/${projectId}/v/${versionId}/explorations`);
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const review = useMutation({
    mutationFn: (v: { findingId: string; decision: 'confirmed' | 'dismissed' }) =>
      api.explorations.review(id!, v.findingId, v.decision),
    onSuccess: invalidate,
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // 以此章程重跑：自动续跑要复原 LLM 历史/浏览器上下文/页面栈，不在本批范围——
  // 终态会话给一个同章程重开入口，比让用户照抄章程强。
  const rerun = useMutation({
    mutationFn: () =>
      api.explorations.create({
        versionId: versionId!,
        charter: session!.charter,
        persona: session!.persona,
        allowDestructive: session!.allowDestructive,
        allowFaultInjection: session!.allowFaultInjection,
        ...(session!.startUrl ? { startUrl: session!.startUrl } : {}),
        ...(session!.windowWidth && session!.windowHeight
          ? { windowWidth: session!.windowWidth, windowHeight: session!.windowHeight }
          : {}),
      }),
    onSuccess: (s) => {
      toast(t('explorations:rerunCreated'), 'success');
      qc.invalidateQueries({ queryKey: ['explorations'] });
      navigate(`/p/${projectId}/v/${versionId}/explorations/${s.id}`);
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // ── 升格为用例：先选目标分组 ──────────────────────────────────────────
  const [promoteTarget, setPromoteTarget] = useState<ExplorationFinding | null>(null);
  const [groupId, setGroupId] = useState('');
  const { data: groups } = useQuery({
    queryKey: ['groups', projectId, versionId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!promoteTarget && !!projectId && !!versionId,
  });
  const promote = useMutation({
    mutationFn: () =>
      api.explorations.promote(id!, promoteTarget!.id, { groupId }),
    onSuccess: () => {
      toast(t('explorations:promoteSuccess'), 'success');
      setPromoteTarget(null);
      setGroupId('');
      invalidate();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // 证据截图放大
  const [zoom, setZoom] = useState<string | null>(null);

  /** 过程文本一行：超 STEP_TEXT_CLAMP 钳长 + 行内展开/收起（长 JSON 不再原样铺开）。 */
  const clampedLine = (text: string, mono: boolean, color: string, key: string) => {
    const open = !!expandedText[key];
    const tooLong = text.length > STEP_TEXT_CLAMP;
    return (
      <div className={`${mono ? 'font-mono text-[11px] break-all' : 'text-[11px] break-words'} pl-[76px]`} style={{ color }}>
        {tooLong && !open ? `${text.slice(0, STEP_TEXT_CLAMP)}…` : text}
        {tooLong && (
          <button
            type="button"
            className="ml-1 underline underline-offset-2"
            style={{ color: 'var(--primary)' }}
            onClick={() => setExpandedText((m) => ({ ...m, [key]: !m[key] }))}
          >
            {t(open ? 'explorations:collapse' : 'explorations:expand')}
          </button>
        )}
      </div>
    );
  };

  // 会话过程：并排（右栏）与整宽两种摆法共用同一份标题/列表
  const stepsHeader = (
    <div className="flex items-baseline gap-2 shrink-0">
      <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
        {t('explorations:sessionSteps')}
      </div>
      <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{steps.length}</span>
    </div>
  );
  const stepsBody = (
    <ol
      ref={stepsListRef}
      onScroll={() => {
        const el = stepsListRef.current;
        if (!el) return;
        // 距底 <24px 视为「在底部」：自动滚动会持续把 stick 置回 true；用户上翻则置 false 暂停。
        stepsStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="flex flex-col gap-1 overflow-y-auto min-h-0 flex-1"
    >
      {steps.map((s, i) => {
        const navLanded = navLandedMismatch(s);
        return (
          <li key={i} className="flex flex-col gap-0.5">
            <div className="flex items-start gap-2 text-[12px]">
              <span className="font-mono shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span
                className="shrink-0 px-1 rounded text-[11px]"
                style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
              >
                {t(`explorations:actionTypes.${s.type}`, { defaultValue: s.type })}
              </span>
              {/* target 为 "-"（observe/页内脚本这类无定位目标的动作）时不渲染空占位 */}
              {s.target && s.target !== '-' ? (
                <span className="font-mono break-all flex-1" style={{ color: 'var(--foreground)' }}>
                  {s.target}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              <span className="shrink-0" style={{ color: s.ok ? 'var(--success)' : 'var(--destructive)' }}>
                {s.ok ? t('explorations:stepOk') : t('explorations:stepFail')}
              </span>
            </div>
            {/* navigate 落点核对：目标 path ≠ 实际 path（SPA 重定向/回退）→ 琥珀点名，不再灰字淹没 */}
            {navLanded ? (
              <div className="text-[11px] flex items-center gap-1 pl-[76px]" style={{ color: 'var(--warning)' }}>
                <Icon name="warning" size={11} className="shrink-0" />
                <span>{t('explorations:landedMismatch', { path: navLanded })}</span>
              </div>
            ) : (
              s.outcome && clampedLine(s.outcome, false, s.ok ? 'var(--muted-foreground)' : 'var(--destructive)', `o${i}`)
            )}
            {s.detail && clampedLine(s.detail, true, 'var(--muted-foreground)', `d${i}`)}
          </li>
        );
      })}
    </ol>
  );

  // 运行中新步骤到达 → 自动贴底跟随。hasLiveFrame 入 deps：并排↔整宽切换会重挂 <ol>
  // （scrollTop 归零），切换后要重新贴底。整宽模式 <ol> 不内滚（页面滚），置 scrollTop 是无害 no-op。
  useEffect(() => {
    if (!sessionLive) return;
    const el = stepsListRef.current;
    if (!el || !stepsStickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [steps.length, hasLiveFrame, sessionLive]);

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        {t('common:loadFailed')}：{error?.message ?? t('common:unknownError')}
      </div>
    );
  }

  if (isLoading || !session) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>{t('cases:loading')}</span>
      </div>
    );
  }

  const running = session.status === 'running' || session.status === 'pending';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${projectId}/v/${versionId}/explorations`)}>
          <Icon name="chevronLeft" size={12} />
          {t('explorations:backToList')}
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>
          {session.title || t('explorations:emptySession')}
        </h1>
        <StatusPill status={session.status} pulse={session.status === 'running'}>
          {t(`cases:status.${session.status}`)}
        </StatusPill>
        <div className="flex-1" />
        {running && (
          <Button variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending || session.cancelRequested}>
            <Icon name="pause" size={12} />
            {session.cancelRequested ? t('explorations:cancelRequested') : t('explorations:cancel')}
          </Button>
        )}
        {/* 重跑入口只给终态会话：running 的会话还在写 findings，重开等于并行两场。 */}
        {!running && (
          <Button variant="ghost" onClick={() => rerun.mutate()} disabled={rerun.isPending}>
            <Icon name="renew" size={12} />
            {t('explorations:rerun')}
          </Button>
        )}
        {(!running || session.cancelRequested) && (
          <>
            <Button
              variant="ghost"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              style={{ color: 'var(--destructive)' }}
              aria-label={t('explorations:deleteSession')}
              title={t('explorations:deleteSession')}
            >
              <Icon name="trash" size={12} />
            </Button>
          </>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
        {/* 章程与运行元信息：置顶——先看「这次在测什么」，再看画面与过程。 */}
        <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
            {t('explorations:charterTitle')}
          </div>
          <div className="text-[13px]" style={{ color: 'var(--foreground)' }}>{session.charter}</div>
          <div className="text-[11px] mt-1 flex items-center gap-3 flex-wrap" style={{ color: 'var(--muted-foreground)' }}>
            <span>{t('explorations:personaLabel')}：{personaLabel(session.persona, i18n.language)}</span>
            <span>{t('explorations:turnsUsed')}：{session.turnsUsed}</span>
            {session.startUrl && <span className="truncate max-w-[320px]">{session.startUrl}</span>}
            <span>{t('explorations:createdBy')}：{creatorName(session.createdBy)}</span>
            <span>{fullDateTime(session.createdAt)}</span>
            {session.finishedAt && <span>{t('explorations:finishedAt')}：{fullDateTime(session.finishedAt)}</span>}
            {session.usage?.calls != null && (
              <span>
                {t('explorations:usage')}：{session.usage.calls} {t('explorations:usageCalls')}
                {session.usage.promptTokens != null &&
                  ` · ${session.usage.promptTokens + (session.usage.completionTokens ?? 0)} ${t('explorations:usageTokens')}`}
              </span>
            )}
          </div>
        </div>

        {session.error && (
          <div
            className="shrink-0 text-[12px] px-3 py-2 rounded-[var(--radius-sm)]"
            style={{ background: 'var(--destructive-soft-strong)', color: 'var(--destructive)' }}
          >
            {session.error}
          </div>
        )}
        {session.summary && (
          <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {session.summary}
          </div>
        )}

        {/* 代码提交范围：charter 自然语言解析产物（runner 后台解析，轮询可见）。
            范围是焦点不是围栏——卡片只作定向参考；none（章程与提交历史无关）不渲染卡片。 */}
        {(session.codeScopeStatus === 'pending' || codeScope || session.codeScopeStatus === 'failed') && (
          <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
            <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
              {t('explorations:codeScopeTitle')}
            </div>
            {session.codeScopeStatus === 'pending' && !codeScope && (
              <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                {t('explorations:codeScopeStatus.pending')}…
              </div>
            )}
            {session.codeScopeStatus === 'failed' && !codeScope && (
              <div className="text-[12px]" style={{ color: 'var(--destructive)' }}>
                {t('explorations:codeScopeStatus.failed')}
              </div>
            )}
            {codeScope && (
              <>
                <div className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>
                  {codeScope.label}
                  <span className="ml-2 text-[11px] font-normal" style={{ color: 'var(--muted-foreground)' }}>
                    {codeScope.commits.length} {t('explorations:codeScopeCommits')} · {codeScope.files.length} {t('explorations:codeScopeFiles')}
                  </span>
                </div>
                {codeScope.commits.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    {codeScope.commits.slice(0, 10).map((c) => (
                      <div key={c.sha} className="text-[12px] font-mono truncate" title={c.subject}>
                        <span style={{ color: 'var(--muted-foreground)' }}>{c.sha.slice(0, 8)}</span>
                        <span className="mx-1" style={{ color: 'var(--muted-foreground)' }}>{c.date.slice(0, 10)}</span>
                        <span style={{ color: 'var(--foreground)' }}>{c.subject}</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* 文件按类型分组（SQL/Java/前端/其它）全量渲染：静默 slice 曾把 +372 的最大新增
                    吞在 20 条之外；组头回答「改了哪几块、各多大」，>8 条的组默认收起。 */}
                {fileGroups.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {fileGroups.map((g) => {
                      const add = g.files.reduce((n, f) => n + f.additions, 0);
                      const del = g.files.reduce((n, f) => n + f.deletions, 0);
                      const collapsed = collapsedGroups[g.key] ?? g.files.length > 8;
                      return (
                        <div key={g.key} className="flex flex-col gap-0.5">
                          <button
                            type="button"
                            className="flex items-center gap-1.5 text-left"
                            onClick={() => setCollapsedGroups((m) => ({ ...m, [g.key]: !collapsed }))}
                          >
                            <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={11} className="shrink-0" style={{ color: 'var(--muted-foreground)' }} />
                            <span className="text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>
                              {t(`explorations:codeScopeGroup.${g.key}`)}
                            </span>
                            <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                              {g.files.length} {t('explorations:codeScopeFiles')}
                              {add > 0 && <span style={{ color: 'var(--success)' }}> ·+{add}</span>}
                              {del > 0 && <span style={{ color: 'var(--destructive)' }}> ·-{del}</span>}
                            </span>
                          </button>
                          {!collapsed && (
                            <div className="flex flex-col gap-0.5 pl-4">
                              {g.files.map((f) => (
                                <div key={f.path} className="text-[12px] font-mono flex items-baseline gap-2 min-w-0">
                                  <span
                                    className="shrink-0 px-1 rounded text-[10px]"
                                    title={t(`explorations:codeScopeFileStatus.${f.status}`, { defaultValue: f.status })}
                                    style={{ color: fileStatusColor(f.status), background: 'var(--muted)' }}
                                  >
                                    {f.status}
                                  </span>
                                  <span className="truncate flex-1" style={{ color: 'var(--foreground)' }} title={f.path}>{f.path}</span>
                                  <span className="shrink-0" style={{ color: 'var(--success)' }}>+{f.additions}</span>
                                  <span className="shrink-0" style={{ color: 'var(--destructive)' }}>-{f.deletions}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {codeScope.hintUrls.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('explorations:codeScopeHintUrls')}</div>
                    <div className="flex flex-wrap gap-1">
                      {codeScope.hintUrls.map((u) => (
                        <span key={u} className="px-1.5 py-0.5 rounded text-[11px] font-mono" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>{u}</span>
                      ))}
                    </div>
                  </div>
                )}
                {codeScope.reason && (
                  <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                    {t('explorations:codeScopeReason')}：{codeScope.reason}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* 实时画面 + 会话过程 并排：两窗等宽（各占一半），底对齐不变。
            画面高度自适应：按列宽等比撑高（框内零留白零裁切），LiveViewImg 把实际高度回报到 liveH；
            会话过程卡定高 = 画面框高（liveH + 上下边框 2px）→ 两窗顶部同起点、底部恒对齐，
            步骤多时在窗口内滚动，不把整页撑长。
            画面框下方还有回放按钮行，属于「窗口外」的部分，不参与对齐。
            没有画面时（录制已过 TTL / 从未跑过 / 流断掉）不并排：右侧留白是死区，
            此时会话过程回到整宽卡片（与改版前一致）。 */}
        <div
          className="shrink-0 grid gap-4"
          style={{ gridTemplateColumns: steps.length > 0 && hasLiveFrame ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)' }}
        >
          <div className="min-w-0">
            <LiveViewCard
              liveUrl={api.explorations.liveUrl(session.id)}
              replayUrl={(speed) => api.explorations.replayUrl(session.id, speed)}
              replayMetaUrl={api.explorations.replayMetaUrl(session.id)}
              running={session.status === 'running'}
              onFrameHeightChange={setLiveH}
              onFrameVisibleChange={setHasLiveFrame}
            />
          </div>
          {steps.length > 0 &&
            (hasLiveFrame ? (
              <div
                className="min-w-0 flex flex-col gap-2 overflow-hidden bg-card border rounded-[var(--radius-md)] p-4"
                style={{ height: liveH + 2 }}
              >
                {stepsHeader}
                {stepsBody}
              </div>
            ) : (
              <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
                {stepsHeader}
                {stepsBody}
              </div>
            ))}
        </div>

        {/* 负面结果账本：模型申报的「已排除的假设 + 依据」。只存排除项、不存信念——
            黑板存信念会把观察冻成结论、自我印证。 */}
        {excluded.length > 0 && (
          <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                {t('explorations:excludedTitle')}
              </div>
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{excluded.length}</span>
            </div>
            <ul className="flex flex-col gap-1.5">
              {excluded.map((e, i) => (
                <li key={i} className="flex flex-col gap-0.5">
                  <div className="flex items-start gap-2 text-[12px]">
                    <Icon name="check" size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--success)' }} />
                    <span className="flex-1" style={{ color: 'var(--foreground)' }}>{e.claim}</span>
                  </div>
                  <div className="text-[11px] pl-6" style={{ color: 'var(--muted-foreground)' }}>
                    {t('explorations:excludedEvidence')}：{e.evidence}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 覆盖账本（C1）：平台机械维护的「去过哪些页面/动过哪些控件/子目标完成情况」——
            回答「探测覆盖度」，模型只回告子目标完成与否，路径与交互是动作留痕的客观聚合。 */}
        {coverage && (coverage.paths.length > 0 || coverage.interactions.length > 0 || coverage.goals.length > 0) && (
          <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                {t('explorations:coverageTitle')}
              </div>
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                {coverage.paths.length} {t('explorations:coveragePaths')}
              </span>
            </div>
            {coverage.paths.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {coverage.paths.slice(-20).map((p) => (
                  <span
                    key={p}
                    className="px-1.5 py-0.5 rounded text-[11px] font-mono truncate max-w-[360px]"
                    style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
                    title={p}
                  >
                    {p}
                  </span>
                ))}
              </div>
            )}
            {coverage.interactions.length > 0 && (
              <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                {t('explorations:coverageInteractions')}：
                {coverage.interactions.map((it) => `${it.kind}×${it.count}`).join('、')}
              </div>
            )}
            {coverage.goals.length > 0 && (
              <div className="flex flex-col gap-1">
                {coverage.goals.map((g) => (
                  <div key={g.id} className="flex items-start gap-2 text-[12px]">
                    <Icon
                      name={g.done ? 'check' : 'circleDot'}
                      size={12}
                      className="shrink-0 mt-0.5"
                      style={{ color: g.done ? 'var(--success)' : 'var(--muted-foreground)' }}
                    />
                    <span style={{ color: g.done ? 'var(--foreground)' : 'var(--muted-foreground)' }}>{g.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 错误信号（D3）：探索期间页面自己冒出的 console/pageerror/HTTP 4xx-5xx——
            缺陷的一手旁证，与 findings 相互印证。 */}
        {errorSignals.length > 0 && (
          <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                {t('explorations:errorSignalsTitle')}
              </div>
              <span className="text-[11px]" style={{ color: 'var(--destructive)' }}>{errorSignals.length}</span>
            </div>
            <ul className="flex flex-col gap-1">
              {errorSignals.slice(-30).reverse().map((sig, i) => (
                <li key={i} className="font-mono text-[11px] break-all" style={{ color: 'var(--muted-foreground)' }}>
                  <span
                    className="px-1 rounded mr-1"
                    style={{ background: 'var(--muted)', color: sig.kind === 'http' ? 'var(--destructive)' : 'var(--muted-foreground)' }}
                  >
                    {sig.kind}
                  </span>
                  {sig.text}
                  {sig.url && <span className="ml-1 opacity-70">({sig.url})</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 缺陷候选：每条一张全宽卡片 */}
        <div className="shrink-0 flex flex-col gap-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
            {t('explorations:findings')}（{findings.length}）
          </div>
          {findings.length === 0 ? (
            <div className="bg-card border rounded-[var(--radius-md)] overflow-hidden">
              <EmptyState icon="search" title={t('explorations:noFindings')} description={t('explorations:noFindingsHint')} />
            </div>
          ) : (
            findings.map((f) => {
              const img = screenshotUrl(f.screenshotPath);
              const steps = f.reproSteps ?? [];
              return (
                <div key={f.id} className="bg-card border rounded-[var(--radius-md)] p-4 flex flex-col gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <PriorityBadge priority={f.severity} />
                    <span className="text-[14px] font-semibold truncate" style={{ color: 'var(--foreground)' }} title={f.title}>
                      {f.title}
                    </span>
                    <StatusPill status={f.status === 'promoted' ? 'passed' : f.status === 'confirmed' ? 'passed' : f.status === 'dismissed' ? 'draft' : 'pending'}>
                      {t(`explorations:findingStatus.${f.status}`)}
                    </StatusPill>
                    {/* 多视角共同发现（S2）：≥2 个人格会话独立撞上同一缺陷（近义判定），比单人报更可信。 */}
                    {(f.crossSessionCount ?? 1) >= 2 && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[11px]"
                        style={{ background: 'var(--primary-soft, var(--muted))', color: 'var(--primary)' }}
                        title={t('explorations:multiViewHint')}
                      >
                        {t('explorations:multiViewTag', { count: f.crossSessionCount })}
                      </span>
                    )}
                    {/* 独立评审徽标（A3）：只标注不裁决（人工审阅才是权威）；悬停看评审理由。 */}
                    {f.judge && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[11px]"
                        title={f.judge.reason}
                        style={{
                          color:
                            f.judge.verdict === 'confirmed'
                              ? 'var(--success)'
                              : f.judge.verdict === 'dismissed'
                                ? 'var(--destructive)'
                                : 'var(--muted-foreground)',
                          background: 'var(--muted)',
                        }}
                      >
                        {t('explorations:judgeLabel')}：{t(`explorations:judgeVerdict.${f.judge.verdict}`)}
                        {` · ${Math.round(f.judge.confidence * 100)}%`}
                      </span>
                    )}
                  </div>
                  <div className="text-[13px] whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)' }}>
                    {f.description}
                  </div>

                  {steps.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                        {t('explorations:reproSteps')}
                      </div>
                      <ol className="text-[13px] list-decimal pl-5 flex flex-col gap-0.5" style={{ color: 'var(--foreground)' }}>
                        {steps.map((s, i) => (
                          <li key={i}>
                            {s.action}
                            {s.expected ? <span style={{ color: 'var(--muted-foreground)' }}> → {s.expected}</span> : null}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {f.pageUrl && (
                    <div className="text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }}>
                      {t('explorations:pageUrl')}：{f.pageUrl}
                    </div>
                  )}

                  {img ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setZoom(img)}
                        className="self-start"
                        title={t('explorations:zoomImage')}
                        style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', lineHeight: 0 }}
                      >
                        <img src={img} alt={f.title} style={{ maxHeight: 180, display: 'block' }} />
                      </button>
                      {/* 决策帧（A1）：截图在「模型判断那一刻」先拍后落库（非事后补拍）——元数据钉住帧状态。 */}
                      {f.evidenceFrame && (
                        <div className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                          {t('explorations:evidenceFrame')}
                          {f.evidenceFrame.viewport
                            ? ` · ${f.evidenceFrame.viewport.width}×${f.evidenceFrame.viewport.height}`
                            : ''}
                          {` · ${fullDateTime(f.evidenceFrame.capturedAt)}`}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                      {t('explorations:noEvidence')}
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    {f.status === 'pending' && (
                      <>
                        <Button size="sm" disabled={review.isPending} onClick={() => review.mutate({ findingId: f.id, decision: 'confirmed' })}>
                          {t('explorations:confirmFinding')}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={review.isPending} onClick={() => review.mutate({ findingId: f.id, decision: 'dismissed' })}>
                          {t('explorations:dismissFinding')}
                        </Button>
                      </>
                    )}
                    {f.status === 'confirmed' && (
                      <Button
                        size="sm"
                        disabled={promote.isPending}
                        onClick={() => {
                          setPromoteTarget(f);
                          setGroupId('');
                        }}
                      >
                        <Icon name="beaker" size={12} />
                        {t('explorations:promote')}
                      </Button>
                    )}
                    {f.status === 'promoted' && f.promotedCaseId && (
                      <Button size="sm" variant="ghost" onClick={() => navigate(`/p/${projectId}/v/${versionId}/cases/${f.promotedCaseId}`)}>
                        {t('explorations:promoteCaseLink')}
                        <Icon name="chevronRight" size={12} />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 升格为用例：选分组 */}
      <Dialog open={!!promoteTarget} onOpenChange={(open) => { if (!open) setPromoteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('explorations:promoteTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <div className="text-[13px]" style={{ color: 'var(--foreground)' }}>
              {promoteTarget?.title}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>
                {t('explorations:group')}
              </label>
              {groups && groups.length > 0 ? (
                <select className="input-base" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  <option value="">{t('explorations:groupPlaceholder')}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              ) : (
                <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                  {t('explorations:noGroups')}
                </span>
              )}
            </div>
            <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('explorations:promoteHint')}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPromoteTarget(null)}>{t('common:cancel')}</Button>
            <Button disabled={!groupId || promote.isPending} onClick={() => promote.mutate()}>
              {promote.isPending ? t('common:loading') : t('explorations:promoteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 证据截图放大 */}
      <Dialog open={!!zoom} onOpenChange={(open) => { if (!open) setZoom(null); }}>
        <DialogContent style={{ maxWidth: 900 }}>
          {zoom && <img src={zoom} alt={t('explorations:zoomImage')} style={{ width: '100%', display: 'block' }} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
