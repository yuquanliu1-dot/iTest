import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type StagedCase, type WorkspaceDoc } from '../../api/client';
import Button from '../../components/ui/Button';
import PriorityBadge from '../../components/ui/PriorityBadge';
import { stepKindLabel } from '../../lib/format';
import { stepSummary } from '../../lib/stepSummary';
import ContextModeSelector, { type ContextMode } from './ContextModeSelector';

interface Props {
  requirementId: string;
  projectId: string;
  threadId: string;
  /** 父页持有的 contextMode，初始值与回写都通过 props 同步（让 ThreadPane 也能读到）。 */
  contextMode: ContextMode;
  onContextModeChange: (m: ContextMode) => void;
  onOpenSave: (selection: { scenarioIds: string[]; caseIds: string[] }) => void;
}

/** SSE: subscribe to `/api/pi/threads/:id/events` and refetch on `workspace_doc`. */
function useSseWorkspace(threadId: string, onEvent: () => void) {
  useEffect(() => {
    const es = new EventSource(`/api/pi/threads/${threadId}/events?snapshot=false`);
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === 'workspace_doc') onEvent();
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [threadId, onEvent]);
}

/** 上下文状态 chip：repo > page > 空。 */
function RepoChip({ doc }: { doc: WorkspaceDoc | undefined }) {
  if (doc?.repoContext) {
    return (
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
        style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
      >
        已参考源码 v{doc.repoContext.commit.slice(0, 7)}
      </span>
    );
  }
  if (doc?.pageContext) {
    return (
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
        style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
      >
        已抓取页面 {doc.pageContext.url}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
    >
      未参考任何上下文
    </span>
  );
}

export default function WorkspacePanel({
  requirementId,
  projectId,
  threadId,
  contextMode,
  onContextModeChange,
  onOpenSave,
}: Props) {
  const { data: doc, refetch } = useQuery<WorkspaceDoc>({
    queryKey: ['ai-workspace', requirementId],
    queryFn: () => api.aiWorkspace.getWorkspace(requirementId),
  });
  useSseWorkspace(threadId, refetch);

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.projects.get(projectId),
    enabled: !!projectId,
  });
  const hasRepo = !!project?.repoUrl;

  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  const [selectedScenarios, setSelectedScenarios] = useState<Set<string>>(new Set());
  // 选中语义：勾选场景 = 全选其下用例；勾/取消单个用例时父场景自动同步（全选则勾，部分则不勾）。
  // 后端按「场景全量 + 显式 caseIds」取并集保存，因此场景下用例的部分勾选是合法操作。
  const scenarioById = useMemo(() => new Map((doc?.scenarios ?? []).map((s) => [s.id, s])), [doc]);

  const toggleScenario = (scenarioId: string, checked: boolean) => {
    setSelectedScenarios((prev) => {
      const next = new Set(prev);
      if (checked) next.add(scenarioId);
      else next.delete(scenarioId);
      return next;
    });
    const s = scenarioById.get(scenarioId);
    if (!s) return;
    const nextCases = new Set(selectedCases);
    for (const c of s.cases) {
      if (checked) nextCases.add(c.id);
      else nextCases.delete(c.id);
    }
    setSelectedCases(nextCases);
  };

  const toggleCase = (caseId: string, scenarioId: string, checked: boolean) => {
    const nextCases = new Set(selectedCases);
    if (checked) nextCases.add(caseId);
    else nextCases.delete(caseId);
    setSelectedCases(nextCases);
    const s = scenarioById.get(scenarioId);
    if (!s || s.cases.length === 0) return;
    const allSelected = s.cases.every((c) => nextCases.has(c.id));
    setSelectedScenarios((prev) => {
      const next = new Set(prev);
      if (allSelected) next.add(scenarioId);
      else next.delete(scenarioId);
      return next;
    });
  };

  const renderCase = (c: StagedCase, scenarioId: string) => (
    <div key={c.id} className="flex items-start gap-2 text-[12px]">
      <input
        type="checkbox"
        checked={selectedCases.has(c.id)}
        onChange={(e) => toggleCase(c.id, scenarioId, e.target.checked)}
      />
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{c.title}</span>
          <PriorityBadge priority={c.priority} />
        </div>
        {c.description && (
          <div style={{ color: 'var(--muted-foreground)' }}>{c.description}</div>
        )}
        {c.steps?.length > 0 && (
          <details className="mt-1">
            <summary
              className="cursor-pointer select-none"
              style={{ color: 'var(--muted-foreground)', fontSize: 11 }}
            >
              步骤（{c.steps.length}）
            </summary>
            <ol className="mt-1 ml-4 list-decimal">
              {c.steps.map((s, i) => (
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
                            <span style={{ color: 'var(--primary)' }}>{stepKindLabel(sub.kind)}</span>{' '}
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
        )}
      </div>
    </div>
  );

  const totalCases = useMemo(() => {
    if (!doc) return 0;
    return doc.scenarios.reduce((n, s) => n + s.cases.length, 0) + doc.looseCases.length;
  }, [doc]);
  const progress = doc?.plan ? Math.min(1, totalCases / Math.max(1, doc.plan.cases)) : 0;

  // 保存后 doc 会移除已保存条目；按当前 doc 过滤掉失效的选中 id，避免计数/提交脏数据
  const liveSelection = useMemo(() => {
    const caseIds = new Set<string>();
    if (doc) {
      for (const s of doc.scenarios) for (const c of s.cases) caseIds.add(c.id);
      for (const c of doc.looseCases) caseIds.add(c.id);
    }
    const scenarioIds = new Set((doc?.scenarios ?? []).map((s) => s.id));
    return {
      caseIds: new Set([...selectedCases].filter((id) => caseIds.has(id))),
      scenarioIds: new Set([...selectedScenarios].filter((id) => scenarioIds.has(id))),
    };
  }, [doc, selectedCases, selectedScenarios]);

  return (
    <div className="flex flex-col h-full gap-4 p-5 overflow-y-auto">
      <div className="flex items-center gap-2 text-[12px] flex-wrap" style={{ color: 'var(--muted-foreground)' }}>
        <span>上下文：</span>
        <ContextModeSelector value={contextMode} onChange={onContextModeChange} hasRepo={hasRepo} />
        <RepoChip doc={doc} />
      </div>
      {doc === undefined && <div style={{ padding: 16 }}>加载中…</div>}
      {doc && doc.plan && (
        <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          进度: {Math.round(progress * 100)}% · 暂存 {totalCases} / 计划 {doc.plan.cases}
          <div
            className="h-[3px] mt-1 rounded"
            style={{ background: 'var(--muted)' }}
          >
            <div
              className="h-full rounded"
              style={{ width: `${progress * 100}%`, background: 'var(--primary)' }}
            />
          </div>
        </div>
      )}
{doc && (
        <div
          className="rounded-[var(--radius-sm)] px-3 py-2 text-[12px]"
          style={
            doc.pageContext
              ? { background: 'var(--primary-soft)', color: 'var(--foreground)' }
              : { background: 'rgba(245,158,11,0.10)', color: '#92400e' }
          }
        >
          {doc.pageContext ? (
            <>已参考页面实际代码：{doc.pageContext.url}</>
          ) : (
            <>AI 未参考页面实际代码，以下用例基于假设生成，请人工评审。</>
          )}
        </div>
      )}
      {doc && (
        <div className="flex justify-end">
          <Button
            onClick={() =>
              onOpenSave({
                scenarioIds: [...liveSelection.scenarioIds],
                caseIds: [...liveSelection.caseIds],
              })
            }
            disabled={liveSelection.caseIds.size === 0 && liveSelection.scenarioIds.size === 0}
          >
            保存所选 ({liveSelection.caseIds.size})
          </Button>
        </div>
      )}
      {doc && doc.scenarios.map((s) => {
        const allSelected = s.cases.length > 0 && s.cases.every((c) => selectedCases.has(c.id));
        const someSelected = s.cases.some((c) => selectedCases.has(c.id));
        return (
        <div key={s.id} className="bg-card border rounded-[var(--radius-md)] p-4">
          <label className="flex items-center gap-2 text-[13px] font-semibold">
            <input
              type="checkbox"
              checked={selectedScenarios.has(s.id)}
              ref={(el) => {
                if (el) el.indeterminate = !allSelected && someSelected;
              }}
              onChange={(e) => toggleScenario(s.id, e.target.checked)}
            />
            {s.title}
          </label>
          <div className="flex flex-col gap-2 mt-3 ml-5">
            {s.cases.map((c) => renderCase(c, s.id))}
          </div>
        </div>
        );
      })}
      {doc && doc.looseCases.length > 0 && (
        <div className="bg-card border rounded-[var(--radius-md)] p-4">
          <div className="text-[13px] font-semibold">未分组用例</div>
          <div className="flex flex-col gap-2 mt-3 ml-5">
            {doc.looseCases.map((c) => renderCase(c, ''))}
          </div>
        </div>
      )}
    </div>
  );
}
