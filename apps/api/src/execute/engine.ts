import type { ExecStepResult, ExecContext, CaseWindow } from './cdp.js';
import type { FailureReason, PreflightReport } from '@itest/shared';
import type { EnvCtx } from './envContext.js';

export interface EngineInput {
  caseId: string;
  caseTitle: string;
  caseUrl: string | null;
  /** Origin of the web service bound to the case (used to join relative urls on mid-case T7 navigates); omitted when the environment has no web service. */
  caseWebOrigin?: string | null;
  /** Web service name bound to the case (second-level resolution target for credential placeholders without @ref). */
  caseWebServiceRef?: string | null;
  expectedOutcome: string | null;
  steps: Array<{
    order: number;
    assertion: unknown;
    delayMs: number | null;
    id: string;
    tabRef: string | null;
    componentKind: string | null;
    sensitive: boolean;
    compiled: unknown[] | null | undefined;
    /** Row-level natural-language instruction; replay reads it only as the AI-fallback fallback — mechanical replay never reads it. */
    instruction: string | null;
  }>;
  /** Replay AI-fallback switches (global settings; read in and injected at the runCase layer; all default off). */
  aiFallback?: import('./aiFallback.js').AiFallbackSettings;
  envCtx?: EnvCtx;
  initialVars?: Record<string, string>;
  sensitiveVarKeys?: string[];
  rowPlan?: { rowIndex: number; snapshot: unknown; vars: Record<string, string>; sensitiveVarKeys: string[] };
  reportId: string;
  projectId: string | undefined;
  caseWindow?: CaseWindow;
  incognito: boolean;
  /** Login state exported by plan-level loginPrepare (passed through runPlan → runCase); single-case execution has no value here. */
  storageState?: unknown;
  appRef?: { bundleId: string; appPath?: string; launchArgs?: string[] } | null;
  deviceTargetId?: string | null;
  mobileOs?: 'ios' | 'android' | null;
  /** playground live-view source: setPage on each newly opened page so the view follows execution (plan runs / single-case runs). */
  liveView?: import('./liveView.js').LiveViewHandle;
  /** Abort checkpoint (plan-run cancel): runPlan injects isCancelRequested; the step loop polls before each step starts. */
  shouldAbort?: () => boolean | Promise<boolean>;
}

export interface Engine {
  readonly platform: 'web' | 'mobile';
  /** After each step ends (passed/failed both already in results), callbacks with that step's result — lets the runCase layer persist incrementally,
   *  so the report page's 2s polling sees results step by step instead of waiting for the whole run to finish. */
  execute(
    input: EngineInput,
    targetUrl?: string,
    preflightSink?: (r: PreflightReport) => void,
    onStep?: (r: ExecStepResult) => void,
  ): Promise<ExecStepResult[]>;
  prepare(input: EngineInput): Promise<void>;
  release(input: EngineInput): Promise<void>;
}

export class EngineUnavailable extends Error {
  readonly failureReason: FailureReason = 'EngineUnavailable';
  constructor(msg: string) {
    super(msg);
    this.name = 'EngineUnavailable';
  }
}
