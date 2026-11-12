/**
 * Exploration tool-set assembly (pi chain).
 *
 * ToolDefinition uses pi's native defineTool shape (content supports ImageContent ⇒ vision
 * available); it does not reuse the repo's own pi/tools.ts ToolExecutor — the latter is plain
 * text, has no image channel, no label.
 * Tools receive dependencies via factories, so page stubs are easy to swap in tests.
 *
 * Assembly list (15 resident): navigate/observe/screenshot/read_text/click/fill/press/select/
 * scroll/back/wait/evaluate/report_finding/note_excluded/finish + conditionally mounted
 * sql_probe (with databases) / repo_read (with code scope) / inject_fault (with the
 * fault-injection authorization bit).
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ExplorationStep } from '../../../execute/explorationPrompt.js';
import type { RepoReadRequest, RepoReadResult } from '../../../execute/aiTask.js';
import {
  createObserveTool,
  createReadTextTool,
  createScreenshotTool,
  type ToolDeps,
} from './observe.js';
import {
  createBackTool,
  createClickTool,
  createFillTool,
  createNavigateTool,
  createPressTool,
  createScrollTool,
  createSelectTool,
  createWaitTool,
} from './browser.js';
import { createEvaluateTool } from './evaluate.js';
import { createFinishTool, createNoteExcludedTool, createReportFindingTool } from './finding.js';
import { createRepoReadTool, createSqlProbeTool, type SqlProbeEnv } from './forensics.js';
import { createInjectFaultTool, type FaultController } from './fault.js';
import type { FindingStore } from '../findings.js';

export type { ToolDeps };

/** Full tool-set dependencies (injected by the runner at assembly). sql/repo channels are mounted per session data availability. */
export interface ExplorationDeps extends ToolDeps {
  findings: FindingStore;
  /** Declare exclusions → number of entries actually recorded (dedup/capping in the runner-side ledger). */
  noteExcluded(items: Array<{ claim: string; evidence?: string }>): number;
  /** Wrap-up: summary + subgoal completion reported back by the model (goals is undefined when there are no subgoals). */
  onFinish(summary: string, goals?: Array<{ id: string; done: boolean }>): void;
  /** sql_probe is mounted only when dbRefs is non-empty. */
  sql?: { env: SqlProbeEnv; dbRefs: Array<{ label: string; dialect: string }> };
  /** repo_read is mounted only when a code commit scope exists. */
  repo?: { channel: (req: RepoReadRequest) => Promise<RepoReadResult>; hasDiff: boolean };
  /**
   * Fault-injection controller (D2): **mounted only when the session carries the explicit
   * allow_fault_injection authorization bit** — unauthorized = the tool simply does not exist
   * (mechanical rejection, not prompt persuasion).
   */
  fault?: FaultController;
}

export function createExplorationTools(deps: ExplorationDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createNavigateTool(deps),
    createObserveTool(deps),
    createScreenshotTool(deps),
    createReadTextTool(deps),
    createClickTool(deps),
    createFillTool(deps),
    createPressTool(deps),
    createSelectTool(deps),
    createScrollTool(deps),
    createBackTool(deps),
    createWaitTool(deps),
    createEvaluateTool(deps),
    createReportFindingTool(deps),
    createNoteExcludedTool(deps),
    createFinishTool(deps),
  ];
  if (deps.sql) tools.push(createSqlProbeTool(deps.sql));
  if (deps.repo) tools.push(createRepoReadTool(deps.repo));
  if (deps.fault) tools.push(createInjectFaultTool({ fault: deps.fault }));
  return tools;
}

/**
 * Tool name + args → action trail draft (registered at tool_execution_start; ok/detail filled in
 * at tool_execution_end). type aligns with the legacy ExplorationStep vocabulary
 * (click/fill/navigate/press/wait/sql/repo/screenshot), so the mechanical mapping for promoted
 * cases (trailToCaseSteps) works unchanged; pi-specific actions (observe/read_text/
 * evaluate/report_finding/note_excluded/finish/select/scroll/back) use their own tool name as
 * type — the detail page renders by "tool name + target", and trailToSteps takes the default branch.
 * Note: fill's value keeps the model's raw input (placeholder literal) — substitution happens
 * inside the tool, so the trail never contains real credentials.
 * Malformed args always get target='-' — the trail is an audit aid and must not throw on arg drift.
 */
export function trailStepOf(toolName: string, args: unknown): ExplorationStep | null {
  const o = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const str = (k: string): string => (typeof o[k] === 'string' && o[k] ? (o[k] as string).slice(0, 300) : '-');
  const num = (k: string, d: number): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : d);
  switch (toolName) {
    case 'navigate':
      return { type: 'navigate', target: str('url'), ok: true };
    case 'observe':
      return { type: 'observe', target: '-', ok: true };
    case 'screenshot':
      return { type: 'screenshot', target: str('selector'), ok: true };
    case 'read_text':
      return { type: 'read_text', target: str('selector'), ok: true };
    case 'click':
      return { type: 'click', target: str('target'), ok: true };
    case 'fill':
      return { type: 'fill', target: str('target'), value: str('value'), ok: true };
    case 'press': {
      const key = str('key');
      return { type: 'press', target: key, key, ok: true };
    }
    case 'select':
      return { type: 'select', target: str('target'), value: str('value'), ok: true };
    case 'scroll':
      return { type: 'scroll', target: `${str('direction') === '-' ? 'down' : str('direction')} ${num('amount', 120)}`, ok: true };
    case 'back':
      return { type: 'back', target: '-', ok: true };
    case 'wait': {
      const ms = typeof o.ms === 'number' && Number.isFinite(o.ms) ? Math.round(o.ms) : null;
      return { type: 'wait', target: ms !== null ? String(ms) : str('selector'), ...(ms !== null ? { ms } : {}), ok: true };
    }
    case 'evaluate':
      return { type: 'evaluate', target: '-', ok: true };
    case 'sql_probe': {
      // Same semantics as legacy: normalize whitespace + cap length 1000 (audit must see "what was actually queried", without bloating on overlength).
      const q = typeof o.query === 'string' ? o.query : '';
      return { type: 'sql', target: q.replace(/\s+/g, ' ').slice(0, 1000), ok: true };
    }
    case 'repo_read': {
      // Same semantics as legacy: `${op} ${path ?? pattern ?? ''}`.trim() (ls/diff without path → bare op).
      const op = str('op') === '-' ? 'read' : str('op');
      const arg = str('path') !== '-' ? str('path') : str('pattern') === '-' ? '' : str('pattern');
      return { type: 'repo', target: `${op} ${arg}`.trim(), ok: true };
    }
    case 'report_finding':
      return { type: 'report_finding', target: str('title'), ok: true };
    case 'note_excluded':
      return { type: 'note_excluded', target: '-', ok: true };
    case 'inject_fault':
      return { type: 'inject_fault', target: str('mode'), ok: true };
    case 'finish':
      return { type: 'finish', target: '-', ok: true };
    default:
      return { type: toolName, target: '-', ok: true };
  }
}
