/**
 * Result summaries for the action trail (pi chain).
 *
 * The trail originally recorded only "what was done" (type/target/ok), so the detail page's
 * "session process" looked like "observe page -", "page script -", "screenshot -": actions
 * present, conclusions absent. The tool layer is the only place that knows "what this step saw /
 * what it changed into / why it failed", so the summary is produced by the tool
 * (AgentToolResult.details.summary, which never enters model context); this module lifts it
 * into the trail.
 */

/** Tool result → trail summary (details.summary). */
export function readToolSummary(result: unknown): string | undefined {
  const details = (result as { details?: { summary?: unknown } } | undefined)?.details;
  const s = details?.summary;
  return typeof s === 'string' && s.trim() ? s.trim().slice(0, 200) : undefined;
}

/** Fallback: when the tool gave no summary but is judged failed, extract the reason from the error text ("…: error <reason>"). */
export function fallbackFailureReason(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
  const text = content?.find((b) => b.type === 'text' && typeof b.text === 'string')?.text;
  if (!text) return undefined;
  const m = text.match(/error\s+([^。\n]{1,120})/);
  return m?.[1] ? `失败：${m[1].trim()}` : `失败：${text.replace(/\s+/g, ' ').slice(0, 120)}`;
}
