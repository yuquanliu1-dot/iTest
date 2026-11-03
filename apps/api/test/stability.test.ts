import { describe, it, expect, vi, afterEach } from 'vitest';

function makePage(evalResult: unknown) {
  return {
    evaluate: vi.fn().mockResolvedValue(evalResult),
  } as never;
}

import { waitForStable, ElementNotStable, stabilityProbeFn } from '../src/execute/stability.js';

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
