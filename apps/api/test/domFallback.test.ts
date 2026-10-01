import { describe, it, expect, vi } from 'vitest';
import { domClick, domFill, domCheck, domSelect } from '../src/execute/domFallback.js';

function pageWith(evalImpl: (fn: (arg: unknown) => unknown, arg?: unknown) => Promise<unknown>) {
  return {
    evaluate: vi.fn().mockImplementation((fn: unknown, arg?: unknown) => evalImpl(fn as never, arg)),
  } as never;
}

describe('domFallback', () => {
  it('domClick returns ok when evaluator returns ok=true', async () => {
    const page = pageWith(async () => ({ ok: true }));
    const r = await domClick(page, [{ strategy: 'css', value: '#btn' }]);
    expect(r.ok).toBe(true);
  });

  it('domClick returns error when evaluator returns ok=false', async () => {
    const page = pageWith(async () => ({ ok: false, error: 'not found' }));
    const r = await domClick(page, [{ strategy: 'css', value: '#btn' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/);
  });

  it('domFill passes value through', async () => {
    let captured: unknown;
    const page = pageWith(async (_fn, arg) => { captured = arg; return { ok: true }; });
    const r = await domFill(page, [{ strategy: 'css', value: '#x' }], 'hello');
    expect(r.ok).toBe(true);
    expect(captured).toMatchObject({ value: 'hello' });
  });

  it('domCheck toggles checked', async () => {
    let captured: unknown;
    const page = pageWith(async (_fn, arg) => { captured = arg; return { ok: true }; });
    await domCheck(page, [{ strategy: 'css', value: '#cb' }], true);
    expect(captured).toMatchObject({ checked: true });
  });

  it('domSelect passes value', async () => {
    let captured: unknown;
    const page = pageWith(async (_fn, arg) => { captured = arg; return { ok: true }; });
    await domSelect(page, [{ strategy: 'css', value: 'select' }], 'cn');
    expect(captured).toMatchObject({ value: 'cn' });
  });
});