import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';

// Mock playwright-core so we can verify dispatch logic without a real browser.
vi.mock('playwright-core', () => {
  const makeLocator = () => ({
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(true),
    isChecked: vi.fn().mockResolvedValue(false),
    check: vi.fn().mockResolvedValue(undefined),
    uncheck: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    innerText: vi.fn().mockResolvedValue('{"code":0}'),
    inputValue: vi.fn().mockResolvedValue('input-val'),
    filter: vi.fn().mockReturnThis(),
    first: vi.fn().mockReturnThis(),
  });

  const getByRole = vi.fn().mockReturnValue(makeLocator());
  const getByText = vi.fn().mockReturnValue(makeLocator());
  const locatorFn = vi.fn().mockReturnValue(makeLocator());

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    locator: locatorFn,
    getByRole,
    getByText,
    screenshot: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };

  return {
    chromium: {
      launch: vi.fn().mockResolvedValue({
        newContext: () => ({ newPage: () => Promise.resolve(page) }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    },
    __page: page,
    __getByRole: getByRole,
    __getByText: getByText,
    __locator: locatorFn,
  };
});

import { executeCaseReal } from '../src/execute/cdp.js';

const mocked = await import('playwright-core') as unknown as {
  __page: Page & {
    goto: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    waitForTimeout: ReturnType<typeof vi.fn>;
  };
  __getByRole: ReturnType<typeof vi.fn>;
  __getByText: ReturnType<typeof vi.fn>;
  __locator: ReturnType<typeof vi.fn>;
};

describe('executeCaseReal — dispatch via mocked chromium', () => {
  it('navigate action forwards url + waitUntil to page.goto', async () => {
    mocked.__page.goto.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'navigate', url: 'https://example.com' } }],
      { reportId: 'r-1' },
    );
    expect(mocked.__page.goto).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ timeout: 30000 }));
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('passed');
  });

  it('click action picks first locator candidate and invokes click()', async () => {
    mocked.__locator.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000002',
      [{ order: 1, action: { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] } }],
      { reportId: 'r-2' },
    );
    expect(mocked.__locator).toHaveBeenCalledWith('#btn');
  });

  it('fill action passes value through to fill()', async () => {
    const page = mocked.__page as unknown as { goto: ReturnType<typeof vi.fn>; screenshot: ReturnType<typeof vi.fn> };
    page.screenshot.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000003',
      [{ order: 1, action: { kind: 'fill', locator: [{ strategy: 'testId', value: 'user' }], value: 'alice' } }],
      { reportId: 'r-3' },
    );
    expect(page.screenshot).toHaveBeenCalled();
  });

  it('failing step records error and stops the run', async () => {
    mocked.__page.goto.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000004',
      [
        { order: 1, action: { kind: 'navigate', url: 'https://x.test' } },
        { order: 2, action: { kind: 'click', locator: [{ strategy: 'css', value: '#nope' }] } },
      ],
      { reportId: 'r-4' },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/boom/);
  });

  it('check action performs check only when state differs', async () => {
    mocked.__page.waitForTimeout.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'check', locator: [{ strategy: 'css', value: '#cb' }], checked: true } }],
      { reportId: 'r-check' },
    );
    const loc = (mocked.__page.locator as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(loc.check).toHaveBeenCalled();
    expect(loc.uncheck).not.toHaveBeenCalled();
    expect(loc.isChecked).toHaveBeenCalled();
  });

  it('select action forwards materialized value to selectOption', async () => {
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'select', locator: [{ strategy: 'css', value: 'select' }], value: 'cn' } }],
      { reportId: 'r-select' },
    );
    const loc = (mocked.__page.locator as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(loc.selectOption).toHaveBeenCalledWith('cn', expect.objectContaining({ timeout: 5000 }));
  });

  it('upload without bound fileId fails attachment-missing', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }] } }],
      { reportId: 'r-upload' },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/attachment-missing/);
  });

  it('extract action stores element value into vars for later fill', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [
        { order: 1, action: { kind: 'extract', locator: [{ strategy: 'css', value: '#no' }], varName: 'orderNo' } },
        { order: 2, action: { kind: 'fill', locator: [{ strategy: 'css', value: '#f' }], value: '{{orderNo}}' } },
      ],
      { reportId: 'r-extract' },
    );
    expect(results.every((r) => r.status === 'passed')).toBe(true);
    const loc = (mocked.__page.locator as ReturnType<typeof vi.fn>).mock.results[1]!.value;
    expect(loc.fill).toHaveBeenCalledWith('input-val', expect.anything());
  });

  it('unresolved {{var}} fails the step with missing var name', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'fill', locator: [{ strategy: 'css', value: '#f' }], value: '{{nope}}' } }],
      { reportId: 'r-var' },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/nope/);
  });

  it('assertJson deep-compares parsed element text', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'assertJson', locator: [{ strategy: 'css', value: 'pre' }], equals: { code: 0 } } }],
      { reportId: 'r-json' },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('uncompiled aiStep fails with clear error; compiled aiStep runs substeps', async () => {
    const bad = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'aiStep', instruction: 'x', compiled: null } }],
      { reportId: 'r-ai-bad' },
    );
    expect(bad[0]!.status).toBe('failed');
    expect(bad[0]!.error).toMatch(/未编译/);

    const good = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [
        {
          order: 1,
          action: {
            kind: 'aiStep',
            instruction: 'x',
            compiled: [{ kind: 'assertVisible', locator: [{ strategy: 'role', value: 'main' }] }],
          },
        },
      ],
      { reportId: 'r-ai-good' },
    );
    expect(good[0]!.status).toBe('passed');
  });

  it('applies delayMs via page.waitForTimeout before dispatch', async () => {
    mocked.__page.waitForTimeout.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, delayMs: 300, action: { kind: 'navigate', url: 'https://example.com' } }],
      { reportId: 'r-delay' },
    );
    expect(mocked.__page.waitForTimeout).toHaveBeenCalledWith(300);
  });

  it('switchTab action uses tabMap to switch the page context', async () => {
    const bringToFront = vi.fn().mockResolvedValue(undefined);
    (mocked.__page as unknown as { bringToFront: ReturnType<typeof vi.fn> }).bringToFront = bringToFront;
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000010',
      [{ order: 1, action: { kind: 'switchTab', tabRef: 'session-x|tab#1' } }],
      { reportId: 'r-switch', tabMap: new Map([['session-x|tab#1', mocked.__page]]) },
    );
    expect(bringToFront).toHaveBeenCalled();
    expect(results[0]!.status).toBe('passed');
  });

  it('switchTab without matching tabMap entry fails with tab-missing', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000011',
      [{ order: 1, action: { kind: 'switchTab', tabRef: 'session-x|tab#9' } }],
      { reportId: 'r-miss', tabMap: new Map() },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/tab-missing/);
  });

  it('upload action calls setInputFiles with stored_path', async () => {
    const setInputFiles = vi.fn().mockResolvedValue(undefined);
    mocked.__locator.mockReturnValueOnce({ setInputFiles } as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000012',
      [{ order: 1, action: { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: 'fake-id' } }],
      { reportId: 'r-up', attachmentResolver: async () => ({ storedPath: '/tmp/x.bin', originalName: 'x.bin' }) },
    );
    expect(setInputFiles).toHaveBeenCalledWith('/tmp/x.bin', { timeout: 5000 });
    expect(results[0]!.status).toBe('passed');
  });

  it('upload without resolver or db row fails attachment-missing', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000013',
      [{ order: 1, action: { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: 'nope' } }],
      { reportId: 'r-up-miss', attachmentResolver: async () => null },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/attachment-missing/);
  });

  it('sensitive fill resolves plaintext via secretResolver', async () => {
    const fill = vi.fn().mockResolvedValue(undefined);
    mocked.__locator.mockReturnValueOnce({ fill } as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000014',
      [{ order: 1, action: { kind: 'fill', locator: [{ strategy: 'css', value: 'input[type=password]' }], value: '__sensitive__', sensitive: true }, id: 'step-1' }],
      { reportId: 'r-secret', secretResolver: async (stepId: string) => (stepId === 'step-1' ? 'hunter2' : null) },
    );
    expect(fill).toHaveBeenCalledWith('hunter2', { timeout: 5000 });
    expect(results[0]!.status).toBe('passed');
  });

  it('sensitive fill without resolver value fails secret-missing', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000015',
      [{ order: 1, action: { kind: 'fill', locator: [{ strategy: 'css', value: 'input[type=password]' }], value: '__sensitive__', sensitive: true }, id: 'step-2' }],
      { reportId: 'r-secret-miss', secretResolver: async () => null },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/secret-missing/);
  });
});