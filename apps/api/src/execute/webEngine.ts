import type { Engine, EngineInput } from './engine.js';
import { executeCaseReal, type ExecContext, type ExecStepResult } from './cdp.js';
import type { PreflightReport } from '@itest/shared';

export class WebEngine implements Engine {
  readonly platform = 'web' as const;

  async prepare(_input: EngineInput): Promise<void> {
    // no-op: WebEngine 不持有长生命周期资源（每次 execute 启停 browser）
  }

  async release(_input: EngineInput): Promise<void> {
    // no-op
  }

  async execute(
    input: EngineInput,
    targetUrl?: string,
    preflightSink?: (r: PreflightReport) => void,
  ): Promise<ExecStepResult[]> {
    const ctx: ExecContext = {
      reportId: input.reportId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.envCtx ? { envCtx: input.envCtx } : {}),
      ...(input.expectedOutcome ? { expectedOutcome: input.expectedOutcome } : {}),
      caseTitle: input.caseTitle,
      caseUrl: input.caseUrl,
      ...(input.initialVars ? { initialVars: input.initialVars } : {}),
      ...(input.sensitiveVarKeys ? { sensitiveVarKeys: input.sensitiveVarKeys } : {}),
      ...(input.liveView ? { liveView: input.liveView } : {}),
    };
    return executeCaseReal(
      input.caseId,
      input.steps,
      ctx,
      targetUrl,
      input.storageState,
      preflightSink,
      input.caseWindow,
      input.incognito,
    );
  }
}
