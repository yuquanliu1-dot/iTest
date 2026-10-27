import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/shadcn/sheet';
import Icon from '../../components/Icon';
import Markdown from '../../components/ui/Markdown';
import { api, type HistoryBlock, type HistoryCompaction, type HistoryMessage } from '../../api/client';
import { toolMeta } from './toolMeta';

/**
 * 「查看完整历史」抽屉：只读展示 pi 会话 JSONL 全量（含被自动压缩掉的旧消息）。
 * 数据来自 GET /threads/:id/history（服务端 parseSessionHistory），对话流本身不动。
 * 与 SpaceThreadPane 共用 toolMeta，视觉语言对齐对话流（气泡/思考折叠/工具 chip）。
 */
export default function ThreadHistorySheet({ threadId, open, onClose }: {
  threadId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useQuery({
    queryKey: ['assistant', 'history', threadId],
    queryFn: () => api.assistant.threadHistory(threadId),
    enabled: open && !!threadId,
  });
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" size="2xl" className="p-0 gap-0" aria-describedby={undefined}>
        {/* pr-12:标题行要避开右上角绝对定位的关闭按钮 */}
        <SheetHeader className="shrink-0 pr-12">
          <SheetTitle size="lg">{data?.title ?? t('assistant:threadList.untitled')}</SheetTitle>
          <SheetDescription>
            {t('assistant:history.title')} · {t('assistant:history.messageCount', { count: data?.messages.length ?? 0 })}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
          {isPending ? (
            <div className="flex justify-center py-10">
              <Icon name="loader" size={16} className="animate-spin" style={{ color: 'var(--muted-foreground)' }} />
            </div>
          ) : isError || !data ? (
            <div className="py-10 text-center text-[12px]" style={{ color: 'var(--destructive)' }}>
              {t('assistant:history.loadFailed')}
            </div>
          ) : data.messages.length === 0 ? (
            <div className="py-10 text-center text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('assistant:history.empty')}
            </div>
          ) : (
            <div className="space-y-4">
              {data.messages.map((m, i) => <HistoryMessageView key={i} message={m} />)}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function HistoryMessageView({ message }: { message: HistoryMessage }) {
  if (message.kind === 'user') return <HistoryUserMessage message={message} />;
  if (message.kind === 'assistant') return <HistoryAssistantMessage message={message} />;
  return <HistoryCompactionRow message={message} />;
}

/** 用户气泡：右对齐，复刻对话流 UserMessage 配色；历史图片是 data URL 形式的 base64。 */
function HistoryUserMessage({ message }: { message: Extract<HistoryMessage, { kind: 'user' }> }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[85%] whitespace-pre-wrap rounded-[var(--radius-md)] rounded-br-sm px-3.5 py-2 text-[13px] leading-relaxed"
        style={{ background: 'var(--primary-soft)', color: 'var(--foreground)' }}
      >
        {message.text}
        {message.images.map((img, i) => (
          <img
            key={i}
            src={`data:${img.mimeType};base64,${img.data}`}
            alt=""
            className="my-1 block max-h-64 max-w-full rounded-[var(--radius-sm)] object-contain"
          />
        ))}
      </div>
    </div>
  );
}

/** AI 回复：text → markdown；thinking 折叠；tool chip 可展开入参/出参；LLM 失败展示错误原文。 */
function HistoryAssistantMessage({ message }: { message: Extract<HistoryMessage, { kind: 'assistant' }> }) {
  return (
    <div className="text-[13px] leading-relaxed" style={{ color: 'var(--foreground)' }}>
      <div className="space-y-1.5">
        {message.blocks.map((b, i) => <HistoryBlockView key={i} block={b} />)}
      </div>
      {message.errorMessage && (
        <div
          className="mt-1.5 block w-fit max-w-full break-all rounded-[var(--radius-md)] px-2.5 py-1.5 text-[12px]"
          style={{
            background: 'var(--destructive-soft)',
            border: '1px solid var(--destructive-soft-border)',
            color: 'var(--destructive)',
          }}
        >
          {message.errorMessage}
        </div>
      )}
    </div>
  );
}

function HistoryBlockView({ block }: { block: HistoryBlock }) {
  const { t } = useTranslation();
  if (block.type === 'text') return <Markdown text={block.text} />;
  if (block.type === 'thinking') {
    if (!block.text) return null;
    return (
      <details className="group">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] [&::-webkit-details-marker]:hidden"
          style={{ color: 'var(--muted-foreground)' }}>
          <Icon name="chevronRight" size={11} className="transition-transform group-open:rotate-90" />
          {t('assistant:thinkingDone')}
        </summary>
        <div
          className="mt-1 whitespace-pre-wrap break-words rounded-[var(--radius-sm)] px-2.5 py-2 text-[12px] leading-relaxed"
          style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
        >
          {block.text}
        </div>
      </details>
    );
  }
  return <HistoryToolChip block={block} />;
}

/** 工具 chip：图标 + 文案 + 结果态，点开查看原始入参/出参（定位失败工具的唯一信息源）。 */
function HistoryToolChip({ block }: { block: Extract<HistoryBlock, { type: 'tool' }> }) {
  const { t } = useTranslation();
  let args: unknown = {};
  try { args = block.argsText ? JSON.parse(block.argsText) : {}; } catch { /* 非 JSON 入参不阻断展示 */ }
  const meta = toolMeta(block.name, args);
  const detail = [block.argsText, block.resultText].filter((x) => x && x.trim() && x.trim() !== '{}').join('\n\n');
  return (
    <details className="group">
      <summary
        className="inline-flex w-fit max-w-full cursor-pointer list-none items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1 text-[12px] [&::-webkit-details-marker]:hidden"
        style={{ background: 'var(--muted)', border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
      >
        <Icon name={meta?.icon ?? 'code'} size={12} style={{ flexShrink: 0 }} />
        <span className="truncate">
          {meta ? t(meta.label) : block.name}
          {meta?.summary ? `：${meta.summary}` : ''}
        </span>
        {block.isError ? (
          <Icon name="close" size={12} style={{ color: 'var(--destructive)', flexShrink: 0 }} />
        ) : block.resultText ? (
          <Icon name="check" size={12} style={{ color: 'var(--success)', flexShrink: 0 }} />
        ) : null}
        <Icon
          name="chevronRight"
          size={11}
          style={{ flexShrink: 0 }}
          className="transition-transform group-open:rotate-90"
        />
      </summary>
      {detail && (
        <pre
          className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-sm)] px-2.5 py-2 text-[11px] leading-relaxed"
          style={{ background: 'var(--muted)', border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
        >
          {detail}
        </pre>
      )}
    </details>
  );
}

/** 压缩标记行：居中分隔线 + token 数，摘要可折叠——它就是「旧消息从对话流消失」的原因注脚。 */
function HistoryCompactionRow({ message }: { message: HistoryCompaction }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col items-center gap-1 pt-1 text-[12px]"
      style={{ color: 'var(--muted-foreground)' }}
    >
      <div className="flex w-full items-center gap-2">
        <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Icon name="clock" size={11} />
          {t('assistant:history.compaction')}
          {message.tokensBefore != null
            ? ` · ${t('assistant:history.compactionTokens', { count: message.tokensBefore })}`
            : ''}
        </span>
        <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
      </div>
      {message.summary && (
        <details className="group w-full max-w-[520px]">
          <summary className="inline-flex cursor-pointer list-none items-center justify-center gap-1 text-[12px] hover:underline underline-offset-2 [&::-webkit-details-marker]:hidden">
            {t('assistant:history.compactionSummary')}
            <Icon name="chevronRight" size={11} className="transition-transform group-open:rotate-90" />
          </summary>
          <div className="mt-1 rounded-[var(--radius-sm)] px-2.5 py-2 text-left"
            style={{ background: 'var(--muted)' }}>
            <Markdown text={message.summary} />
          </div>
        </details>
      )}
    </div>
  );
}