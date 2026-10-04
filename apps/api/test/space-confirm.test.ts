import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { requestConfirmation, resolveConfirmation, pendingCountForTesting } from '../src/pi/space/confirm.js';

describe('confirm gate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('用户确认 → promise resolve(true),pending 清空', async () => {
    const events: Record<string, unknown>[] = [];
    const p = requestConfirmation(
      { threadId: 't1', toolName: 'manage_cases', action: 'delete', summary: '删除用例「登录-正常」', risk: 'delete' },
      (e) => events.push(e),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'confirm_request', threadId: 't1', summary: '删除用例「登录-正常」', risk: 'delete' });
    const confirmId = events[0]!.confirmId as string;
    expect(confirmId).toBeTruthy();
    resolveConfirmation(confirmId, true);
    await expect(p).resolves.toBe(true);
    expect(pendingCountForTesting()).toBe(0);
  });

  it('用户取消 → resolve(false)', async () => {
    const events: Record<string, unknown>[] = [];
    const p = requestConfirmation(
      { threadId: 't1', toolName: 'manage_environments', action: 'set_secret', summary: '设置 db 密码(值已隐藏)', risk: 'secret' },
      (e) => events.push(e),
    );
    resolveConfirmation(events[0]!.confirmId as string, false);
    await expect(p).resolves.toBe(false);
  });

  it('5 分钟超时 → 自动 resolve(false)', async () => {
    const p = requestConfirmation(
      { threadId: 't1', toolName: 'manage_cases', action: 'delete', summary: 'x', risk: 'delete' },
      () => {},
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await expect(p).resolves.toBe(false);
    expect(pendingCountForTesting()).toBe(0);
  });

  it('未知 confirmId → resolveConfirmation 返回 false', () => {
    expect(resolveConfirmation('nonexistent', true)).toBe(false);
  });

  it('并发挂起互不串扰', async () => {
    const events: Record<string, unknown>[] = [];
    const pa = requestConfirmation({ threadId: 't1', toolName: 'a', action: 'delete', summary: 'a', risk: 'delete' }, () => {});
    const pb = requestConfirmation({ threadId: 't1', toolName: 'b', action: 'delete', summary: 'b', risk: 'delete' }, () => {});
    const pc = requestConfirmation({ threadId: 't2', toolName: 'c', action: 'update', summary: 'c', risk: 'update' }, (e) => events.push(e));
    expect(pendingCountForTesting()).toBe(3);
    resolveConfirmation(events[0]!.confirmId as string, true);
    await expect(pc).resolves.toBe(true);
    expect(pendingCountForTesting()).toBe(2);
    // 其余两个用取消收尾,验证 id 各自独立(不误触发 pc 已验证)
    expect(resolveConfirmation('bogus', true)).toBe(false);
    void pa; void pb;
  });
});
