import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import type { ExecStepResult } from './cdp.js';
import { materializeExpectedOutcome, maskSensitiveValues } from './cdp.js';

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

export interface VisionAssertInput {
  /** 可选；mobile 路径下不传,由调用方短路(不在此处短路,由调用方决定)。 */
  page?: import('playwright-core').Page;
  reportId: string;
  caseTitle: string;
  caseUrl: string | null;
  expectedOutcome: string;
  vars: Record<string, string>;
  sensitiveVarKeys: string[];
  llmClient?: import('../agent/llm-client.js').LLMClient;
}

export interface VisionAssertOutcome {
  /** 用于追加 order=-1 的失败步；mobile 路径下不返回 */
  failureStep?: ExecStepResult;
  /** 用于回写到最后一个 pass 步 */
  onLastPass?: { reason: string; screenshot: string; expected: string };
}

/** 用例级 vision 判定:从 cdp.ts 抽出,与 web 路径共用。mobile 路径下传入 page=undefined 时跳过(best-effort)。
 *  调用方根据返回值决定是 push 一个失败步、还是给最后一个 pass 步挂 visionAssert。
 *  异常 swallow(best-effort),不抛出。 */
export async function runCaseVisionAssert(input: VisionAssertInput): Promise<VisionAssertOutcome | null> {
  if (!input.page) return null; // mobile 路径不传 page → 短路(MVP 暂跳过 vision 终态判定)
  try {
    const expectedForJudge = materializeExpectedOutcome(input.expectedOutcome, input.vars);
    // 终态判定前给 SPA 收尾时间:点击提交 → 接口往返 → 前端跳转是异步的,
    // 立即截图会把「仍停在提交前页面」误判为失败(实测点击后 ~100ms 截图仍显示登录页)。
    await input.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    await input.page.waitForTimeout(800);
    const buffer = await input.page.screenshot({ timeout: 5000 });
    // 终态判定截图单独保存,便于报告页把「最终页面 vs 预期」展示给用户。
    const visionScreenshotPath = `/screenshots/${input.reportId}/final.png`;
    try {
      const dir = join(SCREENSHOTS_DIR, input.reportId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'final.png'), buffer);
    } catch (e) {
      logger.warn({ err: e, reportId: input.reportId }, 'failed to save final vision screenshot');
    }
    const { judgeCaseOutcome } = await import('../agent/judgeCaseOutcome.js');
    const verdict = await judgeCaseOutcome({
      expectedOutcome: expectedForJudge,
      caseTitle: input.caseTitle,
      caseUrl: input.caseUrl,
      screenshot: { base64: buffer.toString('base64'), mime: 'image/png' },
      llmClient: input.llmClient,
    });
    // 报告侧脱敏:LLM 提示按 spec §8.3 走明文,但落库的 visionAssert(expected / reason 可能复述敏感列值)
    // 与步骤错误信息同口径打码 —— 报告与详情只出掩码,闭环列级加密。
    const maskForReport = (t: string) =>
      input.sensitiveVarKeys.length > 0
        ? maskSensitiveValues(t, input.vars, input.sensitiveVarKeys)
        : t;
    const expectedForReport = maskForReport(expectedForJudge);
    if (verdict && !verdict.passed) {
      // 用例级 vision 判失败 → 追加一个 order=-1 的 failed stepResult,调用方以「任意 failed」判定为失败。
      return {
        failureStep: {
          order: -1,
          status: 'failed',
          durationMs: 0,
          error: `case-level vision assert failed: ${maskForReport(verdict.reason)}`,
          screenshot: visionScreenshotPath,
          failureReason: 'VisionAssertionFailed',
          humanMessage: '最终页面与用例预期不符',
          visionAssert: { passed: false, reason: maskForReport(verdict.reason), screenshot: visionScreenshotPath, expected: expectedForReport },
        },
      };
    }
    if (verdict) {
      // 通过:在最后一步 result 上挂 visionAssert,调用方可读到 reason(不影响 passed 计数)。
      return {
        onLastPass: {
          reason: maskForReport(verdict.reason),
          screenshot: visionScreenshotPath,
          expected: expectedForReport,
        },
      };
    }
    return null;
  } catch (e) {
    // vision 兜底失败不视作用例失败:best-effort
    logger.warn({ err: e, reportId: input.reportId }, 'case-outcome vision assert skipped');
    return null;
  }
}
