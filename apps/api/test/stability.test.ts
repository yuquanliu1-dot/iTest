import { describe, it, expect, vi, afterEach } from 'vitest';

function makePage(evalResult: unknown) {
  return {
    evaluate: vi.fn().mockResolvedValue(evalResult),
  } as never;
}

import { waitForStable, ElementNotStable, stabilityProbeFn, waitForDomQuiet } from '../src/execute/stability.js';

describe('waitForStable', () => {
  it('returns ready when evaluate reports no blockers', async () => {
    const page = makePage({ ready: true });
    const r = await waitForStable(page as never, {} as never);
    expect(r.ready).toBe(true);
  });

  it('throws ElementNotStable(disabled) when reason=disabled', async () => {
    const page = makePage({ ready: false, reason: 'disabled', source: '.ant-btn[disabled]' });
    await expect(waitForStable(page as never, {} as never, { timeoutMs: 50, pollMs: 10 }))
      .rejects.toMatchObject({ name: 'ElementNotStable', reason: 'disabled' });
  });

  it('retries until ready within timeout', async () => {
    let calls = 0;
    const page = {
      evaluate: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls < 3) return { ready: false, reason: 'loading', source: '.ant-spin' };
        return { ready: true };
      }),
    };
    const r = await waitForStable(page as never, {} as never, { timeoutMs: 500, pollMs: 10 });
    expect(r.ready).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('throws on timeout with last reason=overlay', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue({ ready: false, reason: 'overlay', source: '.ant-modal-mask' }),
    };
    await expect(waitForStable(page as never, {} as never, { timeoutMs: 30, pollMs: 10 }))
      .rejects.toMatchObject({ name: 'ElementNotStable', reason: 'overlay' });
  });
});

/** 直调页内探测函数：stub 全局 document/window，不依赖真实浏览器。 */
function withStubDom(doc: unknown) {
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { getComputedStyle: () => ({ pointerEvents: 'auto' }) });
}

describe('stabilityProbeFn（页内探测）', () => {
  afterEach(() => vi.unstubAllGlobals());

  // 回归：prod228 报告 c934d5b6——MRM 登录页页顶 readonly 语言选择框是 DOM 里第一个
  // input，页面级探针按文档序抓到它。readonly 一旦算「未就绪」，页面所有交互步都会
  // 空转 2s：机械步静默 dom-fallback、aiTask 步直接 ElementNotStable 失败。
  it('DOM 首个交互元素是 readonly 输入框（语言选择器）→ 视为就绪', () => {
    const langInput = {
      outerHTML: '<input type="text" readonly="readonly" placeholder="Chose Language">',
      readOnly: true,
      getAttribute: () => null,
      classList: { contains: () => false },
      parentElement: null,
    };
    withStubDom({ querySelector: () => langInput, activeElement: langInput });
    expect(stabilityProbeFn()).toEqual({ ready: true });
  });

  it('disabled 按钮仍然拦截（reason=disabled）', () => {
    const btn = {
      outerHTML: '<button disabled>登录</button>',
      disabled: true,
      getAttribute: () => null,
      classList: { contains: () => false },
      parentElement: null,
    };
    withStubDom({ querySelector: () => btn, activeElement: btn });
    expect(stabilityProbeFn()).toMatchObject({ ready: false, reason: 'disabled' });
  });

  it('页面无交互元素 → 就绪', () => {
    withStubDom({ querySelector: () => null, activeElement: null });
    expect(stabilityProbeFn()).toEqual({ ready: true });
  });
});

describe('waitForDomQuiet（点击后静默期）', () => {
  function makeQuietPage(evalImpl: () => Promise<unknown>) {
    return {
      evaluate: vi.fn(evalImpl),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('指纹恒定 → 收敛返回（静默路径）', async () => {
    const page = makeQuietPage(() => Promise.resolve(12345));
    await waitForDomQuiet(page as never, 2000, 300, 50);
    expect(page.evaluate.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(page.waitForTimeout).toHaveBeenCalled();
  });

  it('指纹变化重置静默计时，落定后才返回', async () => {
    const seq = [100, 200, 200, 200, 200];
    const page = makeQuietPage(() => Promise.resolve(seq.shift() ?? 200));
    await waitForDomQuiet(page as never, 2000, 300, 50);
    // 至少轮询到变化点之后：签名采样数 > 序列中唯一变化次数
    expect(page.evaluate.mock.calls.length).toBeGreaterThanOrEqual(seq.length + 1);
  });

  it('evaluate 抛错（探不了）→ 立即放行，零等待', async () => {
    const page = makeQuietPage(() => Promise.reject(new Error('page navigated')));
    await waitForDomQuiet(page as never, 2000, 300, 50);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
    expect(page.evaluate.mock.calls.length).toBe(1);
  });

  it('指纹持续变化 → maxIters 兜底终止（墙钟不推进也不死循环）', async () => {
    let n = 0;
    const page = makeQuietPage(() => Promise.resolve(++n));
    await waitForDomQuiet(page as never, 1000, 300, 50);
    // 1000/50 + 5 = 25 轮上限 + 首次采样
    expect(page.evaluate.mock.calls.length).toBeLessThanOrEqual(30);
    expect(page.evaluate.mock.calls.length).toBeGreaterThanOrEqual(20);
  });
});
