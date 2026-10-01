import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type WorkspaceDoc } from '../../api/client';
import Button from '../../components/ui/Button';
import PriorityBadge from '../../components/ui/PriorityBadge';

interface Props {
  requirementId: string;
  threadId: string;
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

export default function WorkspacePanel({ requirementId, threadId, onOpenSave }: Props) {
  const { data: doc, refetch } = useQuery<WorkspaceDoc>({
    queryKey: ['ai-workspace', requirementId],
    queryFn: () => api.aiWorkspace.getWorkspace(requirementId),
  });
  useSseWorkspace(threadId, refetch);

  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  const [selectedScenarios, setSelectedScenarios] = useState<Set<string>>(new Set());

  const totalCases = useMemo(() => {
    if (!doc) return 0;
    return doc.scenarios.reduce((n, s) => n + s.cases.length, 0) + doc.looseCases.length;
  }, [doc]);
  const progress = doc?.plan ? Math.min(1, totalCases / Math.max(1, doc.plan.cases)) : 0;

  if (!doc) return <div style={{ padding: 16 }}>加载中…</div>;
  return (
    <div className="flex flex-col gap-4 p-5 overflow-y-auto">
      {doc.plan && (
        <div className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
          进度: {Math.round(progress * 100)}% · 暂存 {totalCases} / 计划 {doc.plan.cases}
          <div
            className="h-[3px] mt-1 rounded"
            style={{ background: 'var(--color-muted)' }}
          >
            <div
              className="h-full rounded"
              style={{ width: `${progress * 100}%`, background: 'var(--color-accent)' }}
            />
          </div>
        </div>
      )}
      <div className="flex justify-end">
        <Button
          onClick={() =>
            onOpenSave({
              scenarioIds: [...selectedScenarios],
              caseIds: [...selectedCases],
            })
          }
          disabled={selectedCases.size === 0 && selectedScenarios.size === 0}
        >
          保存所选 ({selectedCases.size + selectedScenarios.size})
        </Button>
      </div>
      {doc.scenarios.map((s) => (
        <div key={s.id} className="glass-card rounded-[12px] p-4">
          <label className="flex items-center gap-2 text-[13px] font-semibold">
            <input
              type="checkbox"
              checked={selectedScenarios.has(s.id)}
              onChange={(e) =>
                setSelectedScenarios((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(s.id);
                  else next.delete(s.id);
                  return next;
                })
              }
            />
            {s.title}
          </label>
          <div className="flex flex-col gap-2 mt-3 ml-5">
            {s.cases.map((c) => (
              <div key={c.id} className="flex items-start gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={selectedCases.has(c.id)}
                  onChange={(e) =>
                    setSelectedCases((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      return next;
                    })
                  }
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{c.title}</span>
                    <PriorityBadge priority={c.priority} />
                  </div>
                  {c.description && (
                    <div style={{ color: 'var(--color-foreground-muted)' }}>{c.description}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}