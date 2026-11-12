/**
 * 动作留痕的结果摘要（pi 链路）。
 *
 * 留痕原本只记「做了什么」（type/target/ok），详情页的「会话过程」于是长成
 * 「观察页面 -」「页内脚本 -」「截图 -」：动作在、结论无。工具层是唯一知道
 * 「这步看到了什么 / 变成了什么 / 为什么失败」的地方，所以摘要由工具产出
 * （AgentToolResult.details.summary，不进模型上下文），这里负责把它取出来落进留痕。
 */

/** 工具结果 → 留痕摘要（details.summary）。 */
export function readToolSummary(result: unknown): string | undefined {
  const details = (result as { details?: { summary?: unknown } } | undefined)?.details;
  const s = details?.summary;
  return typeof s === 'string' && s.trim() ? s.trim().slice(0, 200) : undefined;
}

/** 兜底：工具没给摘要但判失败时，从错误文本里摘原因（「…: error <原因>」）。 */
export function fallbackFailureReason(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
  const text = content?.find((b) => b.type === 'text' && typeof b.text === 'string')?.text;
  if (!text) return undefined;
  const m = text.match(/error\s+([^。\n]{1,120})/);
  return m?.[1] ? `失败：${m[1].trim()}` : `失败：${text.replace(/\s+/g, ' ').slice(0, 120)}`;
}
