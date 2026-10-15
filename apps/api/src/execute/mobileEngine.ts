import type { Engine, EngineInput } from './engine.js';
import { EngineUnavailable } from './engine.js';
import type { ExecStepResult } from './cdp.js';
import { maskSensitiveValues, materializeExpectedOutcome } from './cdp.js';
import { acquireDevice, type AgentDeviceSession } from './agentDeviceClient.js';
import { findBounds, matchLocator } from './deviceSnapshot.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import type { StepAction } from '@itest/shared';
import { substituteVars, materializeValue } from '@itest/shared';
import { runCaseVisionAssert } from './visionAssert.js';
import type { PreflightReport } from '@itest/shared';

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

/** 把 mobile 路径下需要的 bundleId 缓存到 engine 实例上,供 appRestart/appOpen 在未指定 bundleId 时回退。
 *  acquireDevice 时写入,mobile engine 持有期间不变。 */
function getOrCacheBundleId(engine: MobileEngine, opts: { explicit?: string }): string {
  if (opts.explicit) return opts.explicit;
  if (engine.cachedBundleId) return engine.cachedBundleId;
  throw new Error('mobile engine: appRef.bundleId missing (set in case row)');
}

export class MobileEngine implements Engine {
  readonly platform = 'mobile' as const;
  private session: AgentDeviceSession | null = null;
  private reportId: string | null = null;
  /** caseRow.appRef.bundleId 的缓存;MobileEngine 生命周期内不变。 */
  cachedBundleId: string | null = null;

  async prepare(input: EngineInput): Promise<void> {
    if (!input.deviceTargetId || !input.mobileOs) {
      throw new EngineUnavailable('mobile case missing deviceTargetId or mobileOs');
    }
    const appRef = input.appRef;
    if (!appRef?.bundleId) throw new EngineUnavailable('mobile case missing appRef.bundleId');
    // resolveDeviceTarget service 尚未在本任务实现 (Task 5),先放过 deviceTargetId 解析,直接传 deviceRef = input.deviceTargetId 作为临时约定。
    // Task 5 完成后,会改为 await resolveDeviceTarget(input.deviceTargetId) 取 deviceRef。
    // 这里仍走 acquireDevice(deviceRef = input.deviceTargetId);若用户传错,agent-device 会自己报 unsupported。
    this.cachedBundleId = appRef.bundleId;
    try {
      this.session = await acquireDevice({
        mobileOs: input.mobileOs,
        deviceRef: input.deviceTargetId, // 临时:Task 5 改成 device_target.deviceRef
        bundleId: appRef.bundleId,
        ...(appRef.appPath ? { appPath: appRef.appPath } : {}),
        launchArgs: appRef.launchArgs ?? [],
      });
      this.reportId = input.reportId;
    } catch (e) {
      throw new EngineUnavailable(`agent-device acquire failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async release(_input: EngineInput): Promise<void> {
    this.session = null;
    this.reportId = null;
  }

  async execute(input: EngineInput, _targetUrl?: string, _preflightSink?: (r: PreflightReport) => void, onStep?: (r: ExecStepResult) => void): Promise<ExecStepResult[]> {
    if (!this.session) throw new EngineUnavailable('mobile session not prepared');
    const results: ExecStepResult[] = [];
    const vars: Record<string, string> = { ...(input.initialVars ?? {}) };
    for (const step of input.steps) {
      const started = Date.now();
      const compiled = step.compiled;
      if (!Array.isArray(compiled) || compiled.length === 0) {
        const missing: ExecStepResult = {
          order: step.order, status: 'failed', durationMs: 0,
          instruction: step.instruction ?? undefined,
          compiled: Array.isArray(step.compiled) ? step.compiled : undefined,
          error: `compile-missing: 第 ${step.order} 步未编译`,
          failureReason: 'MobileUnsupportedCapability',
          humanMessage: '移动端步骤缺少 compiled DSL',
        };
        results.push(missing);
        onStep?.(missing);
        break;
      }
      try {
        for (const sub of compiled as StepAction[]) {
          await this.dispatchMobile(sub, vars);
        }
        const screenshot = await this.captureStepScreenshot(input.reportId, step.order);
        const passedResult: ExecStepResult = {
          order: step.order, status: 'passed', durationMs: Date.now() - started, screenshot,
          instruction: step.instruction ?? undefined,
          compiled: Array.isArray(step.compiled) ? step.compiled : undefined,
        };
        results.push(passedResult);
        onStep?.(passedResult);
      } catch (e) {
        let msg = e instanceof Error ? e.message : String(e);
        if (input.sensitiveVarKeys?.length) msg = maskSensitiveValues(msg, vars, input.sensitiveVarKeys);
        const screenshot = await this.captureStepScreenshot(input.reportId, step.order);
        const reason: 'MobileUnsupportedCapability' | 'MobileStepFailed' =
          e instanceof Error && e.name === 'MobileUnsupportedCapability' ? 'MobileUnsupportedCapability' : 'MobileStepFailed';
        const failedResult: ExecStepResult = {
          order: step.order, status: 'failed', durationMs: Date.now() - started,
          instruction: step.instruction ?? undefined,
          compiled: Array.isArray(step.compiled) ? step.compiled : undefined,
          error: msg, screenshot, failureReason: reason,
          humanMessage: reason === 'MobileUnsupportedCapability' ? '当前 mobile 引擎不支持该动作' : `agent-device 命令失败：${msg}`,
        };
        results.push(failedResult);
        onStep?.(failedResult);
        break;
      }
    }
    // 用例级 vision 兜底：mobile 路径下 page=undefined → runCaseVisionAssert 内部短路,返回 null。
    if (input.expectedOutcome && results.every((r) => r.status === 'passed')) {
      const va = await runCaseVisionAssert({
        page: undefined,
        reportId: input.reportId,
        caseTitle: input.caseTitle,
        caseUrl: input.caseUrl,
        expectedOutcome: materializeExpectedOutcome(input.expectedOutcome, vars),
        vars,
        sensitiveVarKeys: input.sensitiveVarKeys ?? [],
      });
      if (va?.failureStep) results.push(va.failureStep);
      else if (va?.onLastPass) {
        const last = results[results.length - 1];
        if (last) last.visionAssert = { passed: true, ...va.onLastPass };
      }
    }
    return results;
  }

  private async dispatchMobile(action: StepAction, vars: Record<string, string>): Promise<void> {
    const session = this.session!;
    switch (action.kind) {
      case 'tap': {
        const snap = await session.client.snapshot();
        const bounds = findBounds(snap, (n) => action.locator.some((l) => matchLocator(l, n)));
        if (!bounds) throw new Error('tap: locator not found in accessibility tree');
        await session.client.tap({
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
          ...(action.doubleTap ? { doubleTap: true } : {}),
          ...(action.longPressMs ? { longPressMs: action.longPressMs } : {}),
        });
        return;
      }
      case 'swipe': {
        const snap = await session.client.snapshot();
        const fromBounds = findBounds(snap, (n) => action.from.some((l) => matchLocator(l, n)));
        const toBounds = findBounds(snap, (n) => action.to.some((l) => matchLocator(l, n)));
        if (!fromBounds || !toBounds) throw new Error('swipe: from/to not found');
        await session.client.swipe({
          fromX: fromBounds.x + fromBounds.width / 2,
          fromY: fromBounds.y + fromBounds.height / 2,
          toX: toBounds.x + toBounds.width / 2,
          toY: toBounds.y + toBounds.height / 2,
          durationMs: action.durationMs,
        });
        return;
      }
      case 'fill': {
        let value: string;
        if (action.sensitive) {
          // mobile 路径下不持有 secretResolver(暂未实现);若 sensitive 在 mobile 必抛 unsupported
          throw unsupported('fill with sensitive=true not supported on mobile engine yet');
        }
        value = materializeValue(action.value ?? '', vars);
        const selector = action.locator[0]?.value ?? '';
        await session.client.fill({ selector, value });
        return;
      }
      case 'click': {
        const snap = await session.client.snapshot();
        const bounds = findBounds(snap, (n) => action.locator.some((l) => matchLocator(l, n)));
        if (!bounds) throw new Error('click: locator not found');
        await session.client.tap({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
        return;
      }
      case 'assertVisible': {
        await session.client.expect(action.locator[0]?.value ?? '').toBeVisible();
        return;
      }
      case 'assertText': {
        const value = substituteVars(action.equals, vars).value;
        await session.client.expect(action.locator[0]?.value ?? '').toHaveText(value);
        return;
      }
      case 'screenshot': {
        const dir = join(SCREENSHOTS_DIR, this.reportId!);
        await mkdir(dir, { recursive: true });
        const name = substituteVars(action.name, vars).value || 'snap';
        await session.client.screenshot({ path: join(dir, `${name}.png`) });
        return;
      }
      case 'setAppearance':
        await session.client.setAppearance({ mode: action.mode }); return;
      case 'setNetwork':
        await session.client.setNetwork({ state: action.state }); return;
      case 'setLocation':
        await session.client.setLocation({ latitude: action.latitude, longitude: action.longitude }); return;
      case 'home':
        await session.client.home(); return;
      case 'appBack':
        await session.client.appBack(); return;
      case 'appRestart':
        await session.client.restartApp({ bundleId: getOrCacheBundleId(this, {}) }); return;
      case 'appOpen':
        await session.client.openApp({ bundleId: getOrCacheBundleId(this, { explicit: action.bundleId }) }); return;
      default: {
        const err = new Error(`mobile engine does not support kind=${(action as { kind: string }).kind}`);
        err.name = 'MobileUnsupportedCapability';
        throw err;
      }
    }
  }

  private async captureStepScreenshot(reportId: string, stepIndex: number): Promise<string | undefined> {
    try {
      const dir = join(SCREENSHOTS_DIR, reportId);
      await mkdir(dir, { recursive: true });
      const filename = `step-${stepIndex}.png`;
      const path = join(dir, filename);
      await this.session?.client.screenshot({ path });
      return `/screenshots/${reportId}/${filename}`;
    } catch (e) {
      logger.warn({ err: e, reportId, stepIndex }, 'mobile step screenshot failed');
      return undefined;
    }
  }
}

function unsupported(msg: string): Error {
  const err = new Error(msg);
  err.name = 'MobileUnsupportedCapability';
  return err;
}
