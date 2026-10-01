import { describe, it, expect, vi } from 'vitest';

function makePage(evalResult: unknown) {
  return {
    evaluate: vi.fn().mockResolvedValue(evalResult),
  } as never;
}

import { waitForStable, ElementNotStable } from '../src/execute/stability.js';

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
