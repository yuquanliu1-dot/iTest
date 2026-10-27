/**
 * pi 会话 JSONL → 全量历史消息解析。
 * 服务「查看完整历史」抽屉:压缩只往 JSONL 追加 type:'compaction' 条目、从不删除旧消息,
 * 因此这里能取回已被压出模型上下文的对话(界面快照只含压缩后投影,见 session.ts snapshotOf)。
 * 只读视图,与 SSE/快照契约无关——context_edit 的替换刻意忽略,展示原始文本。
 */

export interface HistoryImage {
  mimeType: string;
  /** base64 裸串(无 data: 前缀),与 pi ImageContent 同形。 */
  data: string;
}

export interface HistoryToolBlock {
  type: 'tool';
  name: string;
  /** 工具入参的 JSON 文本(2 空格缩进);孤立 toolResult 无入参则为空串。 */
  argsText: string;
  /** 配对 toolResult 的文本正文;尚未返回/未配对则缺省。 */
  resultText?: string;
  isError?: boolean;
}

export type HistoryBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | HistoryToolBlock;

export interface HistoryUserMessage {
  kind: 'user';
  /** ms 纪元毫秒。 */
  timestamp: number;
  text: string;
  images: HistoryImage[];
}

export interface HistoryAssistantMessage {
  kind: 'assistant';
  timestamp: number;
  blocks: HistoryBlock[];
  /** LLM 失败(stopReason=error)时的错误原文;正常完成缺省。 */
  errorMessage?: string;
}

export interface HistoryCompaction {
  kind: 'compaction';
  timestamp: number;
  /** 压缩发生时的上下文 token 数;旧版本条目可能缺省 → null。 */
  tokensBefore: number | null;
  summary: string;
}

export type HistoryMessage = HistoryUserMessage | HistoryAssistantMessage | HistoryCompaction;

/** JSONL 单条目的宽松形状(只取用到的字段;会话文件无 schema 保证)。 */
interface RawEntry {
  type?: unknown;
  timestamp?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    timestamp?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
  };
  summary?: unknown;
  tokensBefore?: unknown;
}

const isTextBlock = (b: unknown): b is { type: 'text'; text: string } =>
  !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string';

const isImageBlock = (b: unknown): b is { type: 'image'; data: string; mimeType: string } =>
  !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'image'
  && typeof (b as { data?: unknown }).data === 'string' && typeof (b as { mimeType?: unknown }).mimeType === 'string';

const isThinkingBlock = (b: unknown): b is { type: 'thinking'; thinking: string } =>
  !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'thinking' && typeof (b as { thinking?: unknown }).thinking === 'string';

const isToolCallBlock = (b: unknown): b is { type: 'toolCall'; id: string; name: string; arguments?: unknown } =>
  !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'toolCall'
  && typeof (b as { id?: unknown }).id === 'string' && typeof (b as { name?: unknown }).name === 'string';

/** 条目时间戳:entry.timestamp(ISO 字符串)优先,message.timestamp(ms)兜底,都缺省 0。 */
function entryTimestamp(entry: RawEntry): number {
  if (typeof entry.timestamp === 'string') {
    const ms = Date.parse(entry.timestamp);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof entry.timestamp === 'number') return entry.timestamp;
  const m = entry.message;
  return m && typeof m.timestamp === 'number' ? m.timestamp : 0;
}

/** 消息 content 归一成块数组(pi 允许 user content 为纯字符串)。 */
function contentBlocks(content: unknown): unknown[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

/** 解析整个会话 JSONL。坏行/未知条目类型静默跳过——展示视图不该因单行损坏整体失败。 */
export function parseSessionHistory(jsonl: string): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  /** toolCallId → 已入列 tool 块的引用,toolResult 到达时回填 resultText/isError。 */
  const openToolCalls = new Map<string, HistoryToolBlock>();

  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: RawEntry;
    try {
      entry = JSON.parse(trimmed) as RawEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    if (entry.type === 'compaction') {
      if (typeof entry.summary === 'string' && entry.summary) {
        out.push({
          kind: 'compaction',
          timestamp: entryTimestamp(entry),
          tokensBefore: typeof entry.tokensBefore === 'number' ? entry.tokensBefore : null,
          summary: entry.summary,
        });
      }
      continue;
    }

    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue;
    const msg = entry.message;
    const ts = entryTimestamp(entry);

    if (msg.role === 'user') {
      let text = '';
      const images: HistoryImage[] = [];
      for (const b of contentBlocks(msg.content)) {
        if (isTextBlock(b)) text += (text ? '\n' : '') + b.text;
        else if (isImageBlock(b)) images.push({ mimeType: b.mimeType, data: b.data });
      }
      out.push({ kind: 'user', timestamp: ts, text, images });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: HistoryBlock[] = [];
      for (const b of contentBlocks(msg.content)) {
        if (isTextBlock(b)) blocks.push({ type: 'text', text: b.text });
        else if (isThinkingBlock(b)) blocks.push({ type: 'thinking', text: b.thinking });
        else if (isToolCallBlock(b)) {
          const block: HistoryToolBlock = { type: 'tool', name: b.name, argsText: safeArgsText(b.arguments) };
          blocks.push(block);
          openToolCalls.set(b.id, block);
        }
      }
      const failed = msg.stopReason === 'error' || typeof msg.errorMessage === 'string';
      out.push({
        kind: 'assistant',
        timestamp: ts,
        blocks,
        ...(failed && typeof msg.errorMessage === 'string' ? { errorMessage: msg.errorMessage } : {}),
      });
      continue;
    }

    if (msg.role === 'toolResult') {
      const resultText = contentBlocks(msg.content)
        .filter(isTextBlock)
        .map((b) => b.text)
        .join('\n')
        .trim();
      const isError = msg.isError === true;
      const paired = typeof msg.toolCallId === 'string' ? openToolCalls.get(msg.toolCallId) : undefined;
      if (paired) {
        paired.resultText = resultText;
        if (isError) paired.isError = true;
      } else if (resultText) {
        // 孤立 toolResult(如压缩条目边界截断的配对):独立成块,不丢工具输出。
        out.push({
          kind: 'assistant',
          timestamp: ts,
          blocks: [{ type: 'tool', name: typeof msg.toolName === 'string' ? msg.toolName : '', argsText: '', resultText, isError }],
        });
      }
      continue;
    }
    // system / 其他 role:展示视图不消费。
  }
  return out;
}

function safeArgsText(args: unknown): string {
  if (args === undefined || args === null) return '';
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
