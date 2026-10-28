import { describe, it, expect, beforeEach } from 'vitest';
import { useSpaceEventsStore } from './spaceEventsStore';

const store = () => useSpaceEventsStore.getState();

beforeEach(() => {
  store().reset();
});

describe('login_progress（环境凭据自动登录进度）', () => {
  it('start → 建卡：user/targetUrl/liveUrl 落地，result 为 null（运行中）', () => {
    store().ingest({
      type: 'login_progress',
      phase: 'start',
      user: 'qa01',
      targetUrl: 'http://e/login',
      liveUrl: '/api/assistant/threads/t1/live/abc',
    });
    expect(store().loginProgress).toEqual({
      user: 'qa01',
      targetUrl: 'http://e/login',
      result: null,
      liveUrl: '/api/assistant/threads/t1/live/abc',
    });
  });

  it('end → result=passed，liveUrl 保留（结束后定格帧靠它存活）', () => {
    store().ingest({ type: 'login_progress', phase: 'start', user: 'qa01', liveUrl: '/live/abc' });
    store().ingest({ type: 'login_progress', phase: 'end', result: 'passed' });
    expect(store().loginProgress?.result).toBe('passed');
    expect(store().loginProgress?.liveUrl).toBe('/live/abc');
  });

  it('end → result=failed', () => {
    store().ingest({ type: 'login_progress', phase: 'start', user: 'qa01', liveUrl: '/live/abc' });
    store().ingest({ type: 'login_progress', phase: 'end', result: 'failed' });
    expect(store().loginProgress?.result).toBe('failed');
  });

  it('agent_start 只清「没跑完的」登录卡：已完成的保留（定格帧跨轮存活）', () => {
    store().ingest({ type: 'login_progress', phase: 'start', user: 'qa01', liveUrl: '/live/abc' });
    store().ingest({ type: 'login_progress', phase: 'end', result: 'passed' });
    store().ingest({ type: 'agent_start' });
    expect(store().loginProgress?.result).toBe('passed');

    store().ingest({ type: 'login_progress', phase: 'start', user: 'qa01', liveUrl: '/live/def' });
    store().ingest({ type: 'agent_start' });
    expect(store().loginProgress).toBeNull();
  });
});
