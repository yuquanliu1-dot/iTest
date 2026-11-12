/**
 * Fault injection (D2): offline (network cut) / slow_network (slow network) / cpu_throttle (CPU
 * throttling) / none (restore).
 *
 * Why it is worth doing: error-handling and degradation paths only surface when the network is
 * genuinely cut or slowed — on the happy path the model never sees toast, error page, load
 * timeout branches.
 *
 * Three hard constraints:
 * - **Explicit authorization required**: the tool is only mounted when the session carries the
 *   allow_fault_injection authorization bit (charter wording does not count) — faults interrupt
 *   the SUT's own polling/heartbeat and may dirty SUT state, so a human must approve.
 * - **Must be restorable**: the session-teardown finally must call reset() — no pollution left
 *   in the SUT.
 * - **Slow network delays GET only**: write requests (POST/PUT/DELETE) pass through — otherwise
 *   a fake "submit failed" picture would be fabricated.
 *
 * Tools never throw: failures are always isError + actionable message (iron rule shared with
 * other tools).
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import type { BrowserContext, Page } from 'playwright-core';
import { toolErr, toolOk } from './result.js';

export type FaultMode = 'offline' | 'slow_network' | 'cpu_throttle' | 'none';

/** Default slow-network extra delay (ms): noticeable (page loading spins) yet not session-killing. */
const SLOW_NETWORK_DEFAULT_MS = 1500;
/** Default CPU throttle rate: 4x — slow enough to notice, not unusable. */
const CPU_THROTTLE_DEFAULT_RATE = 4;

export interface FaultController {
  /** Apply/switch fault (none = restore all). */
  apply(mode: FaultMode, opts?: { delayMs?: number; rate?: number }): Promise<void>;
  /** Restore all (must be called in session teardown). */
  reset(): Promise<void>;
  /** Currently active fault mode (none = no fault). */
  current(): FaultMode;
}

/** Mode-name normalization (case/whitespace tolerant; empty/unknown returns null — only explicit none/off/restore restores). */
export function normalizeFaultMode(raw: unknown): FaultMode | null {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'offline' || s === '断网') return 'offline';
  if (s === 'slow_network' || s === 'slow' || s === '慢网') return 'slow_network';
  if (s === 'cpu_throttle' || s === 'cpu' || s === '节流') return 'cpu_throttle';
  if (s === 'none' || s === 'off' || s === '复原') return 'none';
  return null;
}

/**
 * Fault controller: owns context/page, applies and restores faults.
 * CDP session created on demand (only cpu_throttle uses it), detached on restore.
 */
export function createFaultController(context: BrowserContext, page: Page): FaultController {
  let mode: FaultMode = 'none';
  let slowDelayMs = SLOW_NETWORK_DEFAULT_MS;
  let cdp: { send: (method: string, params?: unknown) => Promise<unknown>; detach: () => Promise<void> } | null = null;

  // Cleanup paths never throw: an error raised in teardown's finally would overturn the session
  // terminal state (turning a successful exploration into failed).
  const clearSlowRoute = async (): Promise<void> => {
    if (typeof context.unroute !== 'function') return;
    await context.unroute('**/*').catch(() => undefined);
  };

  const clearCpuThrottle = async (): Promise<void> => {
    if (!cdp) return;
    const s = cdp;
    cdp = null;
    await s.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
    await s.detach().catch(() => undefined);
  };

  const setOffline = async (v: boolean): Promise<void> => {
    if (typeof context.setOffline !== 'function') return;
    await context.setOffline(v).catch(() => undefined);
  };

  return {
    async apply(next, opts): Promise<void> {
      if (next === 'none') {
        await this.reset();
        return;
      }
      // Restore the previous mode before switching — avoids offline+slow stacking into an
      // unexplainable scene.
      await clearSlowRoute();
      await clearCpuThrottle();
      await setOffline(false);

      if (next === 'offline') {
        await context.setOffline(true);
        mode = 'offline';
        return;
      }
      if (next === 'slow_network') {
        const delay = Number.isFinite(opts?.delayMs) && (opts?.delayMs ?? 0) > 0 ? Number(opts!.delayMs) : SLOW_NETWORK_DEFAULT_MS;
        slowDelayMs = delay;
        await context.route('**/*', async (route) => {
          try {
            // Delay GET only: write requests pass through (otherwise a fake "submit failed" picture would be fabricated).
            if (route.request().method() === 'GET') {
              await new Promise((r) => setTimeout(r, slowDelayMs));
            }
            await route.continue();
          } catch {
            // Route already cancelled/page navigated away — ignore.
          }
        });
        mode = 'slow_network';
        return;
      }
      // cpu_throttle
      const rate = Number.isFinite(opts?.rate) && (opts?.rate ?? 0) > 0 ? Number(opts!.rate) : CPU_THROTTLE_DEFAULT_RATE;
      if (!cdp) {
        const session = await context.newCDPSession(page);
        cdp = session as unknown as typeof cdp;
      }
      await cdp!.send('Emulation.setCPUThrottlingRate', { rate });
      mode = 'cpu_throttle';
    },
    async reset(): Promise<void> {
      await clearSlowRoute();
      await clearCpuThrottle();
      await setOffline(false);
      mode = 'none';
    },
    current(): FaultMode {
      return mode;
    },
  };
}

/**
 * inject_fault tool: inject/restore fault conditions.
 * Mounted only when the platform has authorized (deps.fault present = authorized).
 */
export function createInjectFaultTool(deps: { fault: FaultController }) {
  return defineTool({
    name: 'inject_fault',
    label: 'inject_fault',
    description:
      '注入故障条件以验证错误处理与降级路径（平台已授权）：offline=断网、slow_network=慢网、cpu_throttle=CPU 节流、none=复原。注入后用 observe 看页面怎么表现。',
    promptGuidelines: [
      '故障期间页面报错往往是断网/慢网造成的，先用 none 复原再判断是不是产品缺陷',
      '注入后一定要 observe 一次，记录页面在故障下的真实表现（这正是本次探索要验的东西）',
    ],
    parameters: Type.Object({
      mode: Type.String({ description: 'offline | slow_network | cpu_throttle | none' }),
      delayMs: Type.Optional(Type.Number({ description: 'slow_network 的额外延迟毫秒（默认 1500）' })),
      rate: Type.Optional(Type.Number({ description: 'cpu_throttle 的节流倍率（默认 4；1 = 复原）' })),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const mode = normalizeFaultMode(params.mode);
      if (!mode) {
        return toolErr(
          '模式非法（只认 offline / slow_network / cpu_throttle / none）',
          'mode 只能是 offline / slow_network / cpu_throttle / none。',
        );
      }
      try {
        await deps.fault.apply(mode, {
          ...(typeof params.delayMs === 'number' ? { delayMs: params.delayMs } : {}),
          ...(typeof params.rate === 'number' ? { rate: params.rate } : {}),
        });
        return toolOk(
          mode === 'none' ? '已复原（无故障）' : `已注入故障：${mode}`,
          mode === 'none'
            ? '已复原（无故障）。用 observe 确认页面恢复正常。'
            : `已注入故障：${mode}。用 observe 看页面在故障下的表现（错误提示/加载态/降级），再决定是否上报缺陷。`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolErr(
          `注入失败：${msg.slice(0, 120)}`,
          `注入故障失败：${msg}（可换一种模式再试，或用 none 复原）`,
        );
      }
    },
  });
}
