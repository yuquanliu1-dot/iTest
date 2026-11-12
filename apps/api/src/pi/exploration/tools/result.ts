/**
 * Unified exit for tool results (pi chain): every tool carries a one-line **result summary**
 * (details.summary).
 *
 * Why it is needed: the trail only records "what action was taken" (type/target), so the detail
 * page's "session process" used to look like — "observe page -", "page script -", "screenshot -":
 * actions present, conclusions absent. Users could see no value in the process.
 * The tool layer is the only place that knows "what this step actually saw / changed / why it
 * failed", so the summary is produced here:
 * - text (content): the full feedback for the model (unchanged);
 * - summary (details): a one-line conclusion for the trail and detail page — pi's details do not
 *   enter model context, no tokens burned.
 */
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

/** Trail-summary payload inside a tool result (details field). */
export interface ToolDetails {
  summary: string;
}

/** Summary length cap: the trail is an audit aid, not a full log. */
const SUMMARY_MAX = 200;

/** Success result (plain text). */
export function toolOk(summary: string, text: string): AgentToolResult<ToolDetails> {
  return { content: [{ type: 'text', text }], details: { summary: summary.slice(0, SUMMARY_MAX) } };
}

/** Success result (text + image block). */
export function toolOkImage(
  summary: string,
  text: string,
  data: string,
  mimeType: string,
): AgentToolResult<ToolDetails> {
  return {
    content: [
      { type: 'text', text },
      { type: 'image', data, mimeType },
    ],
    details: { summary: summary.slice(0, SUMMARY_MAX) },
  };
}

/** Failure result (the summary states the failure reason — the detail page must show "why it failed"). */
export function toolErr(summary: string, text: string): AgentToolResult<ToolDetails> {
  return {
    content: [{ type: 'text', text }],
    details: { summary: summary.slice(0, SUMMARY_MAX) },
    isError: true,
  };
}
