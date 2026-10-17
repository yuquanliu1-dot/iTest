import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type StageDoc, type StageSaveBody } from '../../api/client';
import Button from '../../components/ui/Button';
import CollapsiblePanel from '../../components/ui/CollapsiblePanel';
import Icon from '../../components/Icon';
import PriorityBadge from '../../components/ui/PriorityBadge';
import { useUIStore } from '../../stores/ui';
import { stepKindLabel } from '../../lib/format';
import { stepSummary } from '../../lib/stepSummary';
import { COVERAGE_LABELS } from '@itest/shared';
import SaveDialog from './SaveDialog';
import {
  useSpaceEventsStore,
  type StageKind,
  type StagedItem,
} from './spaceEventsStore';

type Tab = Exclude<StageKind, 'group'>;

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'case', label: '用例' },
  { key: 'case_op', label: '修改' },
  { key: 'scenario', label: '场景' },
  { key: 'environment', label: '环境' },
  { key: 'plan', label: '计划' },
  { key: 'dataset', label: '数据集' },
];

const KIND_LABEL: Record<Tab, string> = {
  case: '用例',
  case_op: '修改',
  scenario: '场景',
  environment: '环境',
  plan: '计划',
  dataset: '数据集',
};

interface Props {
  projectId: string;
  versionId: string;
}

/** 把 stagedByThread 的 Map<localId, StagedItem> 拆成六个 Tab 的列表。 */
function partition(staged: Map<string, StagedItem> | undefined): Record<Tab, StagedItem[]> {
  const out: Record<Tab, StagedItem[]> = { case: [], case_op: [], scenario: [], environment: [], plan: [], dataset: [] };
  if (!staged) return out;
  for (const item of staged.values()) out[item.kind as Tab].push(item);
  return out;
}

/** cases 行的步骤渲染（折叠）。 */
function CaseSteps({ steps }: { steps: StageDoc['cases'][number]['steps'] }) {
  const { t } = useTranslation();
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
                <span style={{ color: '#92400e' }}>未编译：落库后该步骤不会执行，请用 [{'{"kind":"aiTask","instruction":"..."}'}] 表达「由 AI 临场执行」</span>
              ) : (
                <ol className="ml-4 list-decimal">
                  {s.compiled.map((sub, j) => (
                    <li key={j}>
                      <span style={{ color: 'var(--primary)' }}>{t(stepKindLabel((sub as { kind?: string }).kind ?? ''))}</span>{' '}
                      {stepSummary({ compiled: [sub] })}
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

/** 拉 stage list + 订阅 SSE stage 事件。SSE 即时更新 store，list 在 mount 与 SSE stage 事件时拉。 */
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
        if (payload?.type === 'stage') {
          ingest(payload);
          // SSE 收到 stage 事件就拉一次 list，覆盖 store 里可能缺失的暂存对象
          void qc.invalidateQueries({ queryKey: ['stage-doc', threadId] });
        }
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [threadId, ingest, qc]);
  return { refetch: q.refetch };
}

/** 暂存面板：Tabs + 每行复选框 + 「保存选中」按钮。SSE 即时更新 + mount 时拉一次 list 兜底。 */
export default function StagePanel({ projectId, versionId }: Props) {
  void versionId; // 暂未用；保留为未来「在用例库打开」等跳转入参
  const qc = useQueryClient();
  // threadId 存 spaceEventsStore,由 SpaceWorkspace mount 时写入;订阅同一 state 规避 window 全局的时序竞态
  const activeThreadId = useSpaceEventsStore((s) => s.threadId);
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
      partitioned.case_op.length +
      partitioned.scenario.length +
      partitioned.environment.length +
      partitioned.plan.length +
      partitioned.dataset.length,
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
        (res.savedCaseOps ?? 0) +
        (res.savedScenarios ?? 0) +
        (res.savedEnvironments ?? 0) +
        (res.savedPlans ?? 0) +
        (res.savedDatasets ?? 0);
      toast(`已保存 ${totalSaved} 项`, 'success');
      // 同步清空本地视图（SSE remove 事件会再刷一次兜底）
      removeStaged(activeThreadId, 'case', partitioned.case.map((x) => x.localId));
      removeStaged(activeThreadId, 'case_op', partitioned.case_op.map((x) => x.localId));
      removeStaged(activeThreadId, 'scenario', partitioned.scenario.map((x) => x.localId));
      removeStaged(activeThreadId, 'environment', partitioned.environment.map((x) => x.localId));
      removeStaged(activeThreadId, 'plan', partitioned.plan.map((x) => x.localId));
      removeStaged(activeThreadId, 'dataset', partitioned.dataset.map((x) => x.localId));
      setSaveOpen(false);
      void refetch();
      // 让用户跳回 CaseDetail 时数据新鲜（修改类落库影响具体用例）
      qc.invalidateQueries({ queryKey: ['cases'] });
      // 数据集管理页/绑定下拉需要新鲜数据
      qc.invalidateQueries({ queryKey: ['datasets'] });
    },
    onError: (e: Error) => toast(e.message || '保存失败', 'error'),
  });

  const renderCaseRow = (it: StagedItem) => {
    const p = it.payload as StageDoc['cases'][number];
    const key = `case:${it.localId}`;
    const checked = !!selection?.has(key);
    const boundDataset = p.datasetLocalId
      ? (partitioned.dataset.find(
          (d) => (d.payload as StageDoc['datasets'][number]).localId === p.datasetLocalId,
        )?.payload as StageDoc['datasets'][number] | undefined)
      : undefined;
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
          {p.coverageTypes?.length ? (
            <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              覆盖：{p.coverageTypes.map((k) => COVERAGE_LABELS.get(k) ?? k).join('、')}
            </div>
          ) : null}
          {p.datasetLocalId && (
            <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              配套数据集：{boundDataset ? `「${boundDataset.name}」（同批保存时自动绑定）` : '草稿已不在暂存区，保存时不绑定'}
            </div>
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

  const renderDatasetRow = (it: StagedItem) => {
    const p = it.payload as StageDoc['datasets'][number];
    const key = `dataset:${it.localId}`;
    const checked = !!selection?.has(key);
    const disabledCount = p.rows.filter((r) => r.disabled).length;
    return (
      <label key={it.localId} className="flex items-start gap-2 text-[12px] cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggle(activeThreadId, 'dataset', it.localId)}
        />
        <div className="flex-1 min-w-0">
          <div className="font-semibold">{p.name}</div>
          {p.description && (
            <div style={{ color: 'var(--muted-foreground)' }}>{p.description}</div>
          )}
          <div className="flex flex-wrap items-center gap-1 mt-1">
            {p.columns.map((c) => (
              <span
                key={c.name}
                className="text-[10px] px-1 rounded"
                style={{
                  color: 'var(--muted-foreground)',
                  border: '1px solid var(--border)',
                  background: 'var(--popover)',
                }}
                title={c.sensitive ? '敏感列，落库时加密存储' : undefined}
              >
                {`{{${c.name}}}`}
                {c.sensitive ? ' 🔒' : ''}
              </span>
            ))}
          </div>
          {p.rows.length > 0 && (
            <details className="mt-1">
              <summary
                className="cursor-pointer select-none"
                style={{ color: 'var(--muted-foreground)', fontSize: 11 }}
              >
                行数据（{p.rows.length}
                {disabledCount > 0 ? `，${disabledCount} 行禁用` : ''}；敏感列为明文草稿，落库时加密）
              </summary>
              <div className="mt-1 overflow-x-auto">
                <table className="text-[11px] whitespace-nowrap" style={{ borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {p.columns.map((c) => (
                        <th key={c.name} style={{ border: '1px solid var(--border)', padding: '2px 6px', textAlign: 'left' }}>
                          {c.name}
                          {c.sensitive ? ' 🔒' : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {p.rows.map((r, i) => (
                      <tr key={i} style={{ opacity: r.disabled ? 0.5 : 1 }}>
                        {p.columns.map((c) => (
                          <td key={c.name} style={{ border: '1px solid var(--border)', padding: '2px 6px' }}>
                            {r.cells[c.name] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      </label>
    );
  };

  const renderCaseOpRow = (it: StagedItem) => {
    const p = it.payload as StageDoc['caseOps'][number];
    const key = `case_op:${it.localId}`;
    const checked = !!selection?.has(key);
    const destructive = p.op === 'delete_case' || p.op === 'delete_step';
    return (
      <label key={it.localId} className="flex items-start gap-2 text-[12px] cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggle(activeThreadId, 'case_op', it.localId)}
        />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span
              className="font-semibold"
              style={{ color: destructive ? 'var(--destructive, #b91c1c)' : 'inherit' }}
            >
              {p.summary}
            </span>
            <span
              className="text-[10px] px-1 rounded"
              style={{
                color: 'var(--muted-foreground)',
                border: '1px solid var(--border)',
                background: 'var(--popover)',
              }}
            >
              {p.op}
            </span>
          </div>
          {p.diff && (
            <pre
              className="mt-1 text-[11px] whitespace-pre-wrap"
              style={{ color: 'var(--muted-foreground)' }}
            >
              {p.diff}
            </pre>
          )}
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
        {tab === 'case_op' && tabItems.map(renderCaseOpRow)}
        {tab === 'scenario' && tabItems.map(renderScenarioRow)}
        {tab === 'environment' && tabItems.map(renderEnvRow)}
        {tab === 'plan' && tabItems.map(renderPlanRow)}
        {tab === 'dataset' && tabItems.map(renderDatasetRow)}
      </div>
    );
  };

  const selectedTotal = selection?.size ?? 0;

  return (
    <CollapsiblePanel title={`暂存对象（${total}）`} defaultOpen divider={false}>
      <div className="flex flex-col flex-1 min-h-0">
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
            caseOps: partitioned.case_op
              .filter((x) => selection?.has(`case_op:${x.localId}`))
              .map((x) => ({ localId: x.localId })),
            scenarios: partitioned.scenario
              .filter((x) => selection?.has(`scenario:${x.localId}`))
              .map((x) => ({ localId: x.localId })),
            environments: partitioned.environment
              .filter((x) => selection?.has(`environment:${x.localId}`))
              .map((x) => ({ localId: x.localId })),
            plans: partitioned.plan
              .filter((x) => selection?.has(`plan:${x.localId}`))
              .map((x) => ({ localId: x.localId })),
            datasets: partitioned.dataset
              .filter((x) => selection?.has(`dataset:${x.localId}`))
              .map((x) => ({ localId: x.localId })),
          };
          saveMut.mutate(body);
        }}
        kindLabel={KIND_LABEL[tab]}
      />
      </div>
    </CollapsiblePanel>
  );
}
