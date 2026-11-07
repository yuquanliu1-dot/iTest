import type { Page, Frame } from 'playwright-core';

export type StabilityReason = 'disabled' | 'loading' | 'overlay' | 'hidden';

export interface StabilityOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface StabilityReport {
  ready: boolean;
  reason?: StabilityReason;
  source?: string;
}

export class ElementNotStable extends Error {
  name = 'ElementNotStable' as const;
  reason: StabilityReason;
  source?: string;
  constructor(reason: StabilityReason, source?: string) {
    super(`ElementNotStable: ${reason}${source ? ` (${source})` : ''}`);
    this.reason = reason;
    this.source = source;
  }
}

/**
 * 页内稳定性探测函数。必须自包含（只引用页面全局 document/window）——probe 经
 * page.evaluate 序列化注入执行；独立导出仅为单测可直调（stub 全局 document/window）。
 *
 * 不检查 readonly：页面级探针拿不到本步要操作的目标元素，只能按 DOM 顺序抓第一个
 * 「交互样」元素——prod228 MRM 登录页页顶的语言选择框（readonly 假输入框，点击弹
 * 选择器）会被误判成「页面未就绪」，把页面上所有交互步拖进 2s 稳定性空转（机械步
 * 静默走 dom-fallback、aiTask 步无降级直接失败，2026-11-03 报告
 * c934d5b6 即此）。真正的 readonly 目标由 Playwright fill 自身的报错兜底。
 */
export function stabilityProbeFn(): StabilityReport {
  const sel = document.querySelector(':focus, [data-itest-active="true"], button, input, select, [role="button"]') as HTMLElement | null;
  const el = sel ?? (document.activeElement as HTMLElement | null);
  if (!el) return { ready: true };
  const isDisabled = (el: HTMLElement) =>
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute('aria-busy') === 'true' ||
    el.getAttribute('data-loading') === 'true' ||
    el.classList.contains('ant-btn-loading');
  if (isDisabled(el)) return { ready: false, reason: 'disabled', source: el.outerHTML.slice(0, 80) };
  const isLoadingAncestor = (el: HTMLElement): string | null => {
    let cur: HTMLElement | null = el;
    for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
      if (cur.classList.contains('ant-spin') || cur.classList.contains('ant-spin-spinning')) return '.ant-spin';
      if (cur.getAttribute('aria-busy') === 'true') return '[aria-busy="true"]';
    }
    return null;
  };
  const loadingSrc = isLoadingAncestor(el);
  if (loadingSrc) return { ready: false, reason: 'loading', source: loadingSrc };
  const isOverlayAncestor = (el: HTMLElement): string | null => {
    let cur: HTMLElement | null = el;
    for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
      if (cur.classList.contains('ant-modal-mask') || cur.classList.contains('el-overlay')) return 'overlay-mask';
      if (cur.getAttribute('data-mask') === 'true') return '[data-mask="true"]';
      const pe = window.getComputedStyle(cur).pointerEvents;
      if (pe === 'none') return 'pointer-events:none';
    }
    return null;
  };
  const overlaySrc = isOverlayAncestor(el);
  if (overlaySrc) return { ready: false, reason: 'overlay', source: overlaySrc };
  return { ready: true };
}

async function probe(page: Page | Frame): Promise<StabilityReport> {
  return page.evaluate(stabilityProbeFn);
}

export async function waitForStable(
  page: Page | Frame,
  _locator: ReturnType<Page['locator']>,
  opts: StabilityOptions = {},
): Promise<StabilityReport> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: StabilityReport = { ready: true };
  while (true) {
    // probe 结果形状异常（evaluate 被桥接/替换、返回非 {ready} 形状）时视为稳定，避免阻塞正常执行。
    const raw = (await probe(page)) as unknown;
    const shaped = raw as StabilityReport;
    if (!raw || typeof raw !== 'object' || typeof shaped.ready !== 'boolean') {
      return { ready: true };
    }
    last = shaped;
    if (last.ready) return last;
    if (last.reason && last.reason !== 'hidden') {
      if (Date.now() >= deadline) throw new ElementNotStable(last.reason, last.source);
    }
    if (Date.now() >= deadline) throw new ElementNotStable(last.reason ?? 'hidden', last.source);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * 点击后静默期：机械 click 成功后等 DOM 落定再放行下一步。
 *
 * 现有稳定性机制全是 pre-action（waitForStable 查 disabled/loading/overlay、waitTargetEnabled
 * 等目标恢复），拦不住「点击已成功、效果被后到的异步重渲染冲掉」：prod228 14dd97e2/e3f9a616
 * 实录——行点击落在 Search 响应到达前 275ms，响应到来后 el-table 替换数据数组清掉
 * current-row 选中态，下一步等 Modify 启用等到 target-disabled 降级 AI；而 Search 后等 4s
 * 再点行则一切正常（Modify ≤2.5s 启用）。这里按 DOM 指纹（元素数 + innerText 长度）轮询，
 * 连续 quietMs 无变化视为静默，让异步响应与重渲染在下一次动作前落完。
 *
 * best-effort：绝不失败本步（点击已发生）——探不了（evaluate 缺失/页面跳转抛错）立即放行，
 * 预算到点仍未静默也放行，不比现状差。deadline + maxIters 双保险（模式同 waitForPageSettled：
 * 单测 mock 墙钟不推进需迭代上限终止）。预算 4s 覆盖实测 0.5-2s 的查询响应窗口；健康页面
 * 代价约 quietMs(400ms)/次 click。
 */
export async function waitForDomQuiet(
  page: Page,
  budgetMs = 4000,
  quietMs = 400,
  pollMs = 100,
): Promise<void> {
  const signature = async (): Promise<number | null> => {
    try {
      return await page.evaluate(() => {
        const n = document.getElementsByTagName('*').length;
        const t = document.body?.innerText ?? '';
        return n * 1000003 + t.length;
      });
    } catch {
      return null;
    }
  };
  let prev = await signature();
  if (prev === null) return; // 探不了 → 不等，绝不比现状差
  let lastChange = Date.now();
  const deadline = lastChange + budgetMs;
  const maxIters = Math.max(2, Math.ceil(budgetMs / Math.max(1, pollMs)) + 5);
  for (let iter = 0; iter < maxIters && Date.now() < deadline; iter++) {
    await page.waitForTimeout(pollMs).catch(() => undefined);
    const cur = await signature();
    if (cur === null) return;
    if (cur !== prev) {
      prev = cur;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return; // 连续 quietMs 无 DOM 变化 → 已静默
    }
  }
  // 预算到点仍未静默 → 返回，绝不失败本步
}
