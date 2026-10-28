import { describe, it, expect, beforeEach } from 'vitest';
import { useSpaceEventsStore } from './spaceEventsStore';
import { useActiveLiveView } from './LiveViewRail';

const store = () => useSpaceEventsStore.getState();

beforeEach(() => {
  store().reset();
});

/** 直接调用 hook 需在 React 渲染上下文里；这里只取它内部的纯选择逻辑——
 *  用 renderHook（testing-library/react）避免复制实现。 */
async function activeLiveView() {
  const { renderHook } = await import('@testing-library/react');
  return renderHook(() => useActiveLiveView()).result.current;
}

describe('useActiveLiveView', () => {
  it('登录进行中 → 取登录卡（perform_login 的直播流可见）', async () => {
    store().ingest({ type: 'login_progress', phase: 'start', user: 'qa01', liveUrl: '/live/login', seq: 10 });
    const vp = await activeLiveView();
    expect(vp?.liveUrl).toBe('/live/login');
  });

  it('登录完成后 verify 才起 → 画面切到 verify 卡（登录卡 seq 更旧）', async () => {
    store().ingest({ type: 'login_progress', phase: 'start', user: 'qa01', liveUrl: '/live/login', seq: 10 });
    store().ingest({ type: 'login_progress', phase: 'end', result: 'passed' });
    store().ingest({ type: 'verify_progress', phase: 'start', caseId: 'c1', liveUrl: '/live/verify', seq: 20 });
    const vp = await activeLiveView();
    expect(vp?.liveUrl).toBe('/live/verify');
  });

  it('上一轮已结束的 verify 卡 + 本轮进行中的登录 → 取登录卡（已结束的流再连即 404）', async () => {
    store().ingest({ type: 'verify_progress', phase: 'start', caseId: 'c1', liveUrl: '/live/verify', seq: 5 });
    store().ingest({ type: 'verify_progress', phase: 'end', result: 'passed' });
    store().ingest({ type: 'login_progress', phase: 'start', user: 'qa01', liveUrl: '/live/login', seq: 30 });
    const vp = await activeLiveView();
    expect(vp?.liveUrl).toBe('/live/login');
  });

  it('无任何 liveUrl → null（不渲染画面栏）', async () => {
    const vp = await activeLiveView();
    expect(vp).toBeNull();
  });
});
