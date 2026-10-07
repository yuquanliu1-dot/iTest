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
  appRef?: { bundleId: string; appPath?: string; launchArgs?: string[] } | null;
  deviceTargetId?: string | null;
  mobileOs?: 'ios' | 'android' | null;
}

export interface Engine {
  readonly platform: 'web' | 'mobile';
  execute(
    input: EngineInput,
    targetUrl?: string,
    preflightSink?: (r: PreflightReport) => void,
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
