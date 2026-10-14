import type { ExecStepResult, ExecContext, CaseWindow } from './cdp.js';
import type { FailureReason, PreflightReport } from '@itest/shared';
import type { EnvCtx } from './envContext.js';

export interface EngineInput {
  caseId: string;
  caseTitle: string;
  caseUrl: string | null;
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
  }>;
  envCtx?: EnvCtx;
  initialVars?: Record<string, string>;
  sensitiveVarKeys?: string[];
  rowPlan?: { rowIndex: number; snapshot: unknown; vars: Record<string, string>; sensitiveVarKeys: string[] };
  reportId: string;
  projectId: string | undefined;
  caseWindow?: CaseWindow;
  incognito: boolean;
  /** 计划级 loginPrepare 导出的登录态（runPlan → runCase 透传）；单用例执行无此值。 */
  storageState?: unknown;
  appRef?: { bundleId: string; appPath?: string; launchArgs?: string[] } | null;
  deviceTargetId?: string | null;
  mobileOs?: 'ios' | 'android' | null;
  /** playground 实时画面源：每页新开时 setPage，让画面跟随执行（计划运行/单用例执行）。 */
  liveView?: import('./liveView.js').LiveViewHandle;
}

export interface Engine {
  readonly platform: 'web' | 'mobile';
  /** 每步结束（passed/failed 均已落 results）后回调该步结果——供 runCase 层增量落库，
   *  报告页 2s 轮询即可逐步看到结果，不必等整段跑完。 */
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
