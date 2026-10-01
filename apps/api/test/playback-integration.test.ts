import { describe, it, expect, vi } from 'vitest';
import type { PreflightReport } from '@itest/shared';

// 可变 mock 状态：count 决定定位候选是否命中（0 = 全部未命中 → LocatorAllFailed；1 = 首候选命中）；
// clickReject = false 时 click 成功，覆盖「命中且步骤通过」的 hitLocator 记录路径。
const mockState = vi.hoisted(() => ({ locatorCount: 0, clickReject: true }));

vi.mock('playwright-core', () => {
  const makeLocator = () => ({
    count: vi.fn().mockResolvedValue(mockState.locatorCount),
    click: vi.fn().mockImplementation(() =>
      mockState.clickReject ? Promise.reject(new Error('not found')) : Promise.resolve(undefined),
    ),
    first: vi.fn().mockReturnThis(),
  });
  const makePage = () => ({
    goto: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockImplementation(() => makeLocator()),
    getByText: vi.fn().mockImplementation(() => makeLocator()),
    getByRole: vi.fn().mockImplementation(() => makeLocator()),
    screenshot: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    url: vi.fn(() => 'https://example.com/login'),
    evaluate: vi.fn().mockResolvedValue('欢迎回来'),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    context: () => ({ pages: () => [{}] }),
  });
  return {
    chromium: {
      launch: vi.fn().mockImplementation(async () => ({
        newContext: vi.fn().mockResolvedValue({ newPage: vi.fn().mockResolvedValue(makePage()) }),
        close: vi.fn().mockResolvedValue(undefined),
      })),
    },
  };
});

import { executeCaseReal } from '../src/execute/cdp.js';

describe('playback integration', () => {
  it('failure path writes failureReason + humanMessage', async () => {
    mockState.locatorCount = 0;
    mockState.clickReject = true;
    const preflights: PreflightReport[] = [];
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000099',
      [{ order: 1, action: { kind: 'click', locator: [{ strategy: 'css', value: '#missing' }] } }],
      { reportId: 'r-fail' },
      undefined,
      undefined,
      (r) => preflights.push(r),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureReason).toBe('LocatorAllFailed');
    expect(results[0]!.humanMessage).toBe('所有定位候选均未命中');
    expect(results[0]!.hitLocator).toBeUndefined();
    expect(preflights).toHaveLength(1);
    expect(preflights[0]!.urlReachable).toBe(true);
  });

  it('records hitLocator when a locator candidate hits', async () => {
    mockState.locatorCount = 1;
    mockState.clickReject = false;
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000098',
      [{
        order: 1,
        action: {
          kind: 'click',
          locator: [{ strategy: 'css', value: '.btn' }],
          intentLocator: { semanticRole: 'loginBtn' },
        },
      }],
      { reportId: 'r-hit' },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.hitLocator?.kind).toBe('intent-testid');
    expect(results[0]!.hitLocator?.value).toBe('[data-testid="loginBtn"]');
  });
});
