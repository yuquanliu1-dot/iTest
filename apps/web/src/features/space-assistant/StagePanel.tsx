import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type StageDoc, type StageSaveBody } from '../../api/client';
import Button from '../../components/ui/Button';
import Icon from '../../components/Icon';
import PriorityBadge from '../../components/ui/PriorityBadge';
import { useUIStore } from '../../stores/ui';
import { stepKindLabel } from '../../lib/format';
import { stepSummary } from '../../lib/stepSummary';
import SaveDialog from './SaveDialog';
import {
  useSpaceEventsStore,
  type StageKind,
  type StagedItem,
} from './spaceEventsStore';

type Tab = Exclude<StageKind, 'group'>;

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'case', label: '用例' },
  { key: 'scenario', label: '场景' },
  { key: 'environment', label: '环境' },
  { key: 'plan', label: '计划' },
];

const KIND_LABEL: Record<Tab, string> = {
  case: '用例',
  scenario: '场景',
  environment: '环境',
  plan: '计划',
};

interface Props {
  projectId: string;
  versionId: string;
}

/** threadId 由 SpaceWorkspace mount 时写入 window.__spaceThreadId（panel 固化在右侧不便改 props 链）。 */
function readPinnedThreadId(): string {
  const w = window as unknown as { __spaceThreadId?: string };
  return w.__spaceThreadId ?? '';
}

/** 拉 stage list + 订阅 SSE stage 事件。SSE 即时更新 store，list 只在 mount 与 refetch 主动拉时跑。 */
function useStageDoc(threadId: string): { refetch: () => void } {
  const qc = useQueryClient();
  const ingest = useSpaceEventsStore((s) => s.ingest);
  const q = useQuery({
    queryKey: ['stage-doc', threadId],
    queryFn: async () => {
      const doc = await api.assistant.stage.list(threadId);
      useSpaceEventsStore.getState().setStaged(threadId, doc);
      return doc;
    },
    enabled: !!threadId,
    staleTime: 5_000,
  });
  useEffect(() => {
    if (!threadId) return;
    const es = new EventSource(`/api/assistant/threads/${threadId}/events?snapshot=false`);
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload?.type === 'stage') ingest(payload);
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [threadId, ingest, qc]);
  return { refetch: q.refetch };
}

/** 把 stagedByThread 的 Map<localId, StagedItem> 拆成四个 Tab 的列表。 */
function partition(staged: Map<string, StagedItem> | undefined): Record<Tab, StagedItem[]> {
  const out: Record<Tab, StagedItem[]> = { case: [], scenario: [], environment: [], plan: [] };
  if (!staged) return out;
  for (const item of staged.values()) out[item.kind as Tab].push(item);
  return out;
}

/** cases 行的步骤渲染（折叠）。 */
function CaseSteps({ steps }: { steps: StageDoc['cases'][number]['steps'] }) {
  if (!steps.length) return null;
  return (
    <details className="mt-1">
      <summary
        className="cursor-pointer select-none"
        style={{ color: 'var(--muted-foreground)', fontSize: 11 }}
      >
        步骤（{steps.length}）
      </summary>
      <ol className="mt-1 ml-4 list-decimal">
        {steps.map((s, i) => (
          <li key={i} className="mb-1">
            <div>{s.action}</div>
            {s.assertion && (
              <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                断言：{s.assertion}
              </div>
            )}
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
              编译：
              {s.compiled == null ? (
                <span style={{ color: '#92400e' }}>未编译，保存时由后端补编译</span>
              ) : (
                <ol className="ml-4 list-decimal">
                  {s.compiled.map((sub, j) => (
                    <li key={j}>
                      <span style={{ color: 'var(--primary)' }}>{stepKindLabel((sub as { kind?: string }).kind ?? '')}</span>{' '}
                      {stepSummary(sub)}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** 暂存面板：Tabs + 每行复选框 + 「保存选中」按钮。SSE 即时更新 + mount 时拉一次 list 兜底。 */
export default function StagePanel({ projectId, versionId }: Props) {
  void versionId; // 暂未用；保留为未来「在用例库打开」等跳转入参
  const [activeThreadId, setActiveThreadId] = useState<string>(() => readPinnedThreadId());
  // SpaceWorkspace mount/切线程时更新 window.__spaceThreadId → 这里同步进 state
  useEffect(() => {
    const id = readPinnedThreadId();
    if (id !== activeThreadId) setActiveThreadId(id);
  }, [activeThreadId]);
  const stagedByThread = useSpaceEventsStore((s) =>
    activeThreadId ? s.stagedByThread.get(activeThreadId) : undefined,
  );
  const selection = useSpaceEventsStore((s) =>
    activeThreadId ? s.stagedSelection.get(activeThreadId) : undefined,
  );
  const toggle = useSpaceEventsStore((s) => s.toggleStaged);
  const selectAll = useSpaceEventsStore((s) => s.selectAllStaged);
  const removeStaged = useSpaceEventsStore((s) => s.removeStagedLocal);

  const partitioned = useMemo(() => partition(stagedByThread), [stagedByThread]);
  const total = useMemo(
    () =>
      partitioned.case.length +
      partitioned.scenario.length +
      partitioned.environment.length +
      partitioned.plan.length,
    [partitioned],
  );

  const { refetch } = useStageDoc(activeThreadId);

  const [tab, setTab] = useState<Tab>('case');
  const [saveOpen, setSaveOpen] = useState(false);
  const toast = useUIStore((s) => s.showToast);

  const tabItems = partitioned[tab];
  const tabAllSelected = tabItems.length > 0 && tabItems.every((x) => selection?.has(`${tab}:${x.localId}`));

  // 用例/计划需要选 group；environment/scenario 不需要
  const groupsQ = useQuery({
    queryKey: ['project', projectId, 'groups'],
    queryFn: () => api.projects.groups(projectId),
    enabled: !!projectId,
  });

  const saveMut = useMutation({
    mutationFn: (body: StageSaveBody) => api.assistant.stage.save(activeThreadId, body),
    onSuccess: (res) => {
      const totalSaved =
        (res.savedCases ?? 0) +
        (res.savedScenarios ?? 0) +
        (res.savedEnvironments ?? 0) +
        (res.savedPlans ?? 0);
      toast(`已保存 ${totalSaved} 项`, 'success');
      // 同步清空本地视图（SSE remove 事件会再刷一次兜底）
      removeStaged(activeThreadId, 'case', partitioned.case.map((x) => x.localId));
      removeStaged(activeThreadId, 'scenario', partitioned.scenario.map((x) => x.localId));
      removeStaged(activeThreadId, 'environment', partitioned.environment.map((x) => x.localId));
      removeStaged(activeThreadId, 'plan', partitioned.plan.map((x) => x.localId));
      setSaveOpen(false);
      void refetch();
    },
    onError: (e: Error) => toast(e.message || '保存失败', 'error'),
  });

  const renderCaseRow = (it: StagedItem) => {
    const p = it.payload as StageDoc['cases'][number];
    const key = `case:${it.localId}`;
    const checked = !!selection?.has(key);
    return (
      <label key={it.localId} className="flex items-start gap-2 text-[12px] cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggle(activeThreadId, 'case', it.localId)}
        />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{p.title}</span>
            {p.priority && <PriorityBadge priority={p.priority} />}
          </div>
          {p.description && (
            <div style={{ color: 'var(--muted-foreground)' }}>{p.description}</div>
          )}
          {p.url && (
            <div className="text-[11px] break-all" style={{ color: 'var(--muted-foreground)' }}>{p.url}</div>
          )}
          <CaseSteps steps={p.steps} />
        </div>
      </label>
    );
  };

  const renderScenarioRow = (it: StagedItem) => {
    const p = it.payload as StageDoc['scenarios'][number];
    const key = `scenario:${it.localId}`;
    const checked = !!selection?.has(key);
    return (
      <label key={it.localId} className="flex items-start gap-2 text-[12px] cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggle(activeThreadId, 'scenario', it.localId)}
        />
        <div className="flex-1">
          <div className="font-semibold">{p.title}</div>
          {p.description && <div style={{ color: 'var(--muted-foreground)' }}>{p.description}</div>}
        </div>
      </label>
    );
  };

  const renderEnvRow = (it: StagedItem) => {
    const p = it.payload as StageDoc['environments'][number];
    const key = `environment:${it.localId}`;
    const checked = !!selection?.has(key);
    return (
      <label key={it.localId} className="flex items-start gap-2 text-[12px] cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggle(activeThreadId, 'environment', it.localId)}
        />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{p.name}</span>
            {p.baseUrl && (
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{p.baseUrl}</span>
            )}
          </div>
          {p.objects.length > 0 && (
            <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              凭据对象 {p.objects.length} 个
            </div>
          )}
        </div>
      </label>
    );
  };

  const renderPlanRow = (it: StagedItem) => {
    const p = it.payload as StageDoc['plans'][number];
    const key = `plan:${it.localId}`;
    const checked = !!selection?.has(key);
    return (
      <label key={it.localId} className="flex items-start gap-2 text-[12px] cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggle(activeThreadId, 'plan', it.localId)}
        />
        <div className="flex-1">
          <div className="font-semibold">{p.name}</div>
          <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            关联 {p.caseLocalIds.length} 个用例
          </div>
        </div>
      </label>
    );
  };

  const renderTab = () => {
    if (tabItems.length === 0) {
      return (
        <div className="text-[12px] text-center py-6" style={{ color: 'var(--muted-foreground)' }}>
          暂存表为空，AI 创建对象后会出现在这里
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        {tab === 'case' && tabItems.map(renderCaseRow)}
        {tab === 'scenario' && tabItems.map(renderScenarioRow)}
        {tab === 'environment' && tabItems.map(renderEnvRow)}
        {tab === 'plan' && tabItems.map(renderPlanRow)}
      </div>
    );
  };

  const selectedTotal = selection?.size ?? 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        className="px-4 py-2.5 text-[12px] font-medium shrink-0"
        style={{ borderBottom: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
      >
        暂存对象（{total}）
      </div>
      <div className="flex items-center gap-1 px-3 py-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className="rounded px-2 py-1 text-[12px]"
            style={{
              background: tab === t.key ? 'var(--primary-soft)' : 'transparent',
              color: tab === t.key ? 'var(--primary)' : 'var(--muted-foreground)',
              fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label} ({partitioned[t.key].length})
          </button>
        ))}
        {tabItems.length > 0 && (
          <button
            type="button"
            className="ml-auto text-[11px]"
            style={{ color: 'var(--muted-foreground)' }}
            onClick={() => selectAll(activeThreadId, tab, !tabAllSelected)}
          >
            {tabAllSelected ? '取消全选' : '全选'}
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {total === 0 ? (
          <div className="flex-1 flex items-center justify-center min-h-[120px]">
            <p className="text-[12px] text-center" style={{ color: 'var(--muted-foreground)' }}>
              AI 暂存的对象会展示在这里
            </p>
          </div>
        ) : (
          renderTab()
        )}
      </div>
      {total > 0 && (
        <div
          className="flex items-center gap-2 px-4 py-2.5 shrink-0"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            已选 {selectedTotal}
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            disabled={selectedTotal === 0 || saveMut.isPending}
            onClick={() => setSaveOpen(true)}
          >
            <Icon name="save" size={12} />
            {saveMut.isPending ? '保存中…' : '保存选中'}
          </Button>
        </div>
      )}
      <SaveDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        groups={groupsQ.data ?? []}
        saving={saveMut.isPending}
        partitioned={partitioned}
        selection={selection ?? new Set<string>()}
        onSave={(groupId) => {
          const body: StageSaveBody = {
            cases: partitioned.case
              .filter((x) => selection?.has(`case:${x.localId}`))
              .map((x) => ({ localId: x.localId, groupId })),
            scenarios: partitioned.scenario
              .filter((x) => selection?.has(`scenario:${x.localId}`))
              .map((x) => ({ localId: x.localId })),
            environments: partitioned.environment
              .filter((x) => selection?.has(`environment:${x.localId}`))
              .map((x) => ({ localId: x.localId })),
            plans: partitioned.plan
              .filter((x) => selection?.has(`plan:${x.localId}`))
              .map((x) => ({ localId: x.localId, groupId })),
          };
          saveMut.mutate(body);
        }}
        kindLabel={KIND_LABEL[tab]}
      />
    </div>
  );
}
