import { useEffect, useMemo, useRef } from 'react';
import Icon from '../Icon';
import StatusPill from './StatusPill';
import { useAgentRunStore, type AgentRunEvent } from '../../stores/agentRun';

interface Props {
  /** 触发器：传入 runId 时组件订阅 SSE 并写入 store；卸载/换 runId 自动取消订阅。 */
  runId: string | null;
  /** streaming 状态：决定是否显示「生成中」徽标 */
  streaming: boolean;
  /** 失败文案（来自 mutation.error） */
  errorMessage?: string | null;
}

/** 把后端 AgentEvent 投射成 4 列进度展示（id → stepText → stepOutput → result）。 */
export default function AgentStreamPanel({ runId, streaming, errorMessage }: Props) {
  const events = useAgentRunStore((s) => s.events);
  const clear = useAgentRunStore((s) => s.clear);
  const lastRunIdRef = useRef<string | null>(null);

  // runId 切换时清空 store 残留事件，避免上一轮的 step_text 污染新 run 的渲染。
  useEffect(() => {
    if (runId !== lastRunIdRef.current) {
      clear();
      lastRunIdRef.current = runId;
    }
  }, [runId, clear]);

  const status = useMemo(() => deriveStatus(events, streaming, errorMessage ?? null), [events, streaming, errorMessage]);

  return (
    <div className="bg-card border rounded-[var(--radius-md)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
          Agent 进度
        </span>
        <div className="flex-1" />
        <StatusPill tone={status.tone} pulse={status.tone === 'accent'}>
          {status.label}
        </StatusPill>
      </div>
      {events.length === 0 ? (
        <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {streaming ? '准备中...' : '点击上方按钮启动 Agent。'}
        </div>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {events.map((e, i) => (
            <EventRow key={i} event={e} />
          ))}
        </ol>
      )}
    </div>
  );
}

function EventRow({ event }: { event: AgentRunEvent }) {
  switch (event.type) {
    case 'step_start':
      return (
        <li className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          <Icon name="play" size={11} style={{ color: 'var(--info)' }} />
          <span className="font-mono">{(event.payload as { stepId?: string }).stepId ?? 'step'}</span>
          <span style={{ color: 'var(--muted-foreground)' }}>started</span>
        </li>
      );
    case 'step_text':
      return (
        <li className="flex items-start gap-2 text-[12px]">
          <Icon name="chevronRight" size={11} style={{ color: 'var(--muted-foreground)', marginTop: 4 }} />
          <pre
            className="flex-1 min-w-0 whitespace-pre-wrap font-mono"
            style={{ color: 'var(--muted-foreground)', maxHeight: 80, overflow: 'auto' }}
          >
            {((event.payload as { delta?: string }).delta ?? '').slice(-400)}
          </pre>
        </li>
      );
    case 'step_complete':
      return (
        <li className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--success)' }}>
          <Icon name="checkCircle" size={11} />
          <span className="font-mono">{(event.payload as { stepId?: string }).stepId ?? 'step'}</span>
          <span style={{ color: 'var(--muted-foreground)' }}>completed</span>
        </li>
      );
    case 'workflow_complete':
      return (
        <li className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--success)' }}>
          <Icon name="checkCircle" size={11} />
          已完成
        </li>
      );
    case 'workflow_error':
      return (
        <li className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--destructive)' }}>
          <Icon name="exclamationCircle" size={11} />
          <span>{(event.payload as { error?: string }).error ?? '失败'}</span>
        </li>
      );
    default:
      return null;
  }
}

function deriveStatus(events: AgentRunEvent[], streaming: boolean, err: string | null): { tone: 'accent' | 'success' | 'destructive' | 'muted'; label: string } {
  if (err) return { tone: 'destructive', label: '失败' };
  if (events.some((e) => e.type === 'workflow_complete')) return { tone: 'success', label: '已完成' };
  if (events.some((e) => e.type === 'workflow_error')) return { tone: 'destructive', label: '失败' };
  if (streaming || events.some((e) => e.type === 'step_start')) return { tone: 'accent', label: '运行中' };
  return { tone: 'muted', label: '待启动' };
}