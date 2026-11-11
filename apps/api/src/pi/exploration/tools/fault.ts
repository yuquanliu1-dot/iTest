/**
 * 故障注入（D2）：offline（断网）/ slow_network（慢网）/ cpu_throttle（CPU 节流）/ none（复原）。
 *
 * 为什么值得做：错误处理与降级路径只有「真的断网/变慢」才暴露——正常路径下它们永远
 * 走的是成功分支，模型永远看不到 toast、错误页、加载超时这些分支。
 *
 * 三条硬约束：
 * - **必须显式授权**：工具只在会话带 allow_fault_injection 授权位时装配（章程说辞不算授权）——
 *   故障会打断被测系统自身的轮询/心跳，可能把 SUT 状态搞脏，必须由人点头。
 * - **必须能复原**：会话收尾的 finally 必调 reset()，不给被测系统留污染。
 * - **慢网只拖 GET**：写请求（POST/PUT/DELETE）不拦——否则会造出「提交失败」的假象。
 *
 * 工具永不 throw：失败一律 isError + 可行动中文说明（铁律同其它工具）。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import type { BrowserContext, Page } from 'playwright-core';

export type FaultMode = 'offline' | 'slow_network' | 'cpu_throttle' | 'none';

/** 慢网默认额外延迟（毫秒）：够明显（页面 loading 打转），又不至于把会话拖死。 */
const SLOW_NETWORK_DEFAULT_MS = 1500;
/** CPU 节流默认倍率：4 倍——慢到能看出差别，不到不可用。 */
const CPU_THROTTLE_DEFAULT_RATE = 4;

export interface FaultController {
  /** 施加/切换故障（none = 全部复原）。 */
  apply(mode: FaultMode, opts?: { delayMs?: number; rate?: number }): Promise<void>;
  /** 全部复原（会话收尾必调）。 */
  reset(): Promise<void>;
  /** 当前生效的故障模式（none = 无故障）。 */
  current(): FaultMode;
}

/** 模式名归一（大小写/空白容错；空串/不认识的返回 null——只有显式 none/off/复原才复原）。 */
export function normalizeFaultMode(raw: unknown): FaultMode | null {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'offline' || s === '断网') return 'offline';
  if (s === 'slow_network' || s === 'slow' || s === '慢网') return 'slow_network';
  if (s === 'cpu_throttle' || s === 'cpu' || s === '节流') return 'cpu_throttle';
  if (s === 'none' || s === 'off' || s === '复原') return 'none';
  return null;
}

/**
 * 故障控制器：持有 context/page，负责施加与复原。
 * CDP 会话按需创建（cpu_throttle 才用），复原时 detach。
 */
export function createFaultController(context: BrowserContext, page: Page): FaultController {
  let mode: FaultMode = 'none';
  let slowDelayMs = SLOW_NETWORK_DEFAULT_MS;
  let cdp: { send: (method: string, params?: unknown) => Promise<unknown>; detach: () => Promise<void> } | null = null;

  // 清理路径一律不抛：收尾的 finally 里抛错会掀翻会话终态（把「探索成功」变成 failed）。
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
      // 切换模式前先复原上一个——避免断网+慢网叠加出测不出原因的现场。
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
            // 只拖 GET：写请求照常放行（否则会造出「提交失败」的假象）。
            if (route.request().method() === 'GET') {
              await new Promise((r) => setTimeout(r, slowDelayMs));
            }
            await route.continue();
          } catch {
            // 路由已被取消/页面已跳转——忽略。
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
 * inject_fault 工具：注入/复原故障条件。
 * 平台已授权才装配（deps.fault 存在 = 授权通过）。
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
        return {
          content: [{ type: 'text', text: 'mode 只能是 offline / slow_network / cpu_throttle / none。' }],
          details: undefined,
          isError: true,
        };
      }
      try {
        await deps.fault.apply(mode, {
          ...(typeof params.delayMs === 'number' ? { delayMs: params.delayMs } : {}),
          ...(typeof params.rate === 'number' ? { rate: params.rate } : {}),
        });
        return {
          content: [
            {
              type: 'text',
              text:
                mode === 'none'
                  ? '已复原（无故障）。用 observe 确认页面恢复正常。'
                  : `已注入故障：${mode}。用 observe 看页面在故障下的表现（错误提示/加载态/降级），再决定是否上报缺陷。`,
            },
          ],
          details: undefined,
          isError: false,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: `注入故障失败：${msg}（可换一种模式再试，或用 none 复原）` }],
          details: undefined,
          isError: true,
        };
      }
    },
  });
}
