import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * background.js 的会话/传输层单测。
 *
 * 覆盖的是 b0dbb886 同族的「步骤静默丢失」三条路径：
 *  ① WS 闸门丢步 → 改成入队 + 补发；
 *  ② MV3 SW 被回收 → 会话状态落 storage.session，醒来按同 sessionId 续写；
 *  ③ 弹窗 ack 假成功 → step 消息改成端到端回执。
 *
 * background.js 是纯 JS ESM，顶层就摸 chrome.*，所以这里先装好替身再动态 import。
 */

/** chrome API 替身：只覆盖 background.js 用得到的面。 */
type MsgListener = (msg: any, sender: any, sendResponse: (r?: any) => void) => boolean | void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
    // 服务端收到 finish 会关连接（apps/api/src/recorder/ws.ts 的 msg.type === 'finish' 分支）
    if (data.includes('"type":"finish"')) this.close();
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** 模拟服务端接受连接 */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** 模拟连接被断开 */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  payloads(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

interface FakeState {
  listeners: MsgListener[];
  sentToTabs: Array<{ tabId: number; msg: any }>;
  createdTabs: any[];
}

function createFakeChrome(sessionStore: Record<string, any>) {
  const state: FakeState = { listeners: [], sentToTabs: [], createdTabs: [] };
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn: MsgListener) => { state.listeners.push(fn); } },
      onInstalled: { addListener: () => {} },
      lastError: undefined as any,
      getURL: (p: string) => `chrome-extension://fake/${p}`,
    },
    storage: {
      session: {
        async get(key: string) {
          return key in sessionStore ? { [key]: sessionStore[key] } : {};
        },
        async set(obj: Record<string, any>) {
          Object.assign(sessionStore, obj);
        },
        async remove(key: string) {
          delete sessionStore[key];
        },
      },
      sync: {
        async get() { return {}; },
        async set() {},
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      async sendMessage(tabId: number, msg: any, cb?: (r?: any) => void) {
        state.sentToTabs.push({ tabId, msg });
        cb?.(undefined);
      },
      create(opts: any, cb?: (tab: any) => void) {
        const tab = { id: 4242, ...opts };
        state.createdTabs.push(tab);
        cb?.(tab);
      },
      async get(tabId: number) {
        if (tabId === 4242) return { id: 4242, windowId: 1 };
        throw new Error('no such tab');
      },
      async update() {},
    },
    scripting: {
      async getRegisteredContentScripts() { return []; },
      async registerContentScripts() {},
      async unregisterContentScripts() {},
      async executeScript() { return []; },
    },
    windows: { create() {}, async update() {} },
    i18n: { getMessage: (k: string) => k },
  };
  return { chrome, state };
}

/** 等若干个微任务轮次：handler 里的 await 链要跑完。 */
async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** 发一条消息给 background，等它的回执。 */
function send(state: FakeState, msg: any, sender: any = { tab: { id: 77 } }): Promise<any> {
  const listener = state.listeners[state.listeners.length - 1]!;
  return new Promise((resolve) => {
    listener(msg, sender, resolve);
  });
}

const SESSION = {
  wsUrl: 'ws://sut/recorder',
  sessionId: 'sid-1',
  token: 'tok-1',
  mode: 'fresh',
  targetUrl: 'http://sut/login',
};

const CLICK = { kind: 'click', locator: [{ strategy: 'css', value: '#login' }] };

describe('background — 录制会话与步骤投递', () => {
  let sessionStore: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    FakeWebSocket.instances = [];
    sessionStore = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).chrome;
    delete (globalThis as any).WebSocket;
  });

  async function load(session: Record<string, any> = {}) {
    const { chrome, state } = createFakeChrome(sessionStore);
    (globalThis as any).chrome = chrome;
    (globalThis as any).WebSocket = FakeWebSocket;
    // background.js 是纯 JS 模块（仓库里没有 .d.ts），测试只关心它的副作用
    // @ts-expect-error 找不到 '../background.js' 的类型声明
    await import('../background.js');
    await tick();
    return { chrome, state };
  }

  it('连接未就绪时步骤入队而不是丢弃，连上后按序补发', async () => {
    const { state } = await load();
    // start：连接还没 accept
    const startPromise = send(state, { type: 'start', session: SESSION });
    await tick();
    const sock = FakeWebSocket.instances[0]!;
    expect(sock.url).toContain('sessionId=sid-1');

    // 连接未就绪时来一步：后台接收成功（不是丢弃），但还没发出去
    const resp = await send(state, { type: 'step', dsl: CLICK });
    expect(resp.ok).toBe(true);
    expect(sock.sent).toHaveLength(0);

    // 连接建立 → 补发
    sock.accept();
    await tick();
    expect(sock.payloads().map((p) => p.step.action.kind)).toEqual(['click']);
    await startPromise;
  });

  it('断线期间的多步在重连后按原序补发', async () => {
    vi.useFakeTimers();
    const { state } = await load();
    const startPromise = send(state, { type: 'start', session: SESSION });
    await tick();
    const sock = FakeWebSocket.instances[0]!;
    sock.accept();
    await tick();
    await startPromise;

    // 连接断开
    sock.drop();
    await tick();

    // 断线期间连来两步 → 入队
    const r1 = await send(state, { type: 'step', dsl: CLICK });
    const r2 = await send(state, { type: 'step', dsl: { kind: 'fill', locator: [], value: 'a' } });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(sock.sent).toHaveLength(0);

    // 退避 1s 后自动重连
    await vi.advanceTimersByTimeAsync(1000);
    const sock2 = FakeWebSocket.instances[1]!;
    expect(sock2.url).toContain('sessionId=sid-1');
    sock2.accept();
    await tick();

    expect(sock2.payloads().map((p) => p.step.action.kind)).toEqual(['click', 'fill']);
  });

  it('SW 被回收后按 storage.session 恢复会话并继续投递步骤', async () => {
    // 模拟上一轮 SW 写下的会话快照
    sessionStore.recordingSession = {
      wsUrl: 'ws://sut/recorder',
      sessionId: 'sid-9',
      token: 'tok-9',
      mode: 'fresh',
      incognito: false,
      webTabId: 77,
      recordingTabId: 4242,
      recordingTabs: [],
      nextTabIndex: 1,
      paused: false,
      stepCount: 3,
      pending: [],
    };
    const { state } = await load();
    // 恢复时按同 sessionId 重连（服务端据此续写）
    const sock = FakeWebSocket.instances[0]!;
    expect(sock.url).toContain('sessionId=sid-9');
    sock.accept();
    await tick();

    // 恢复后到来的步骤照常投递（不再被空闸门吃掉）
    const resp = await send(state, { type: 'step', dsl: CLICK });
    expect(resp.ok).toBe(true);
    expect(sock.payloads().map((p) => p.step.action.kind)).toEqual(['click']);
  });

  it('没有活动会话时明确回失败（不再假成功）', async () => {
    const { state } = await load();
    const resp = await send(state, { type: 'step', dsl: CLICK });
    expect(resp.ok).toBe(false);
    expect(typeof resp.error).toBe('string');
    expect(resp.error.length).toBeGreaterThan(0);
  });

  it('stop 会发 finish 并清掉持久化的会话', async () => {
    const { state } = await load();
    const startPromise = send(state, { type: 'start', session: SESSION });
    await tick();
    const sock = FakeWebSocket.instances[0]!;
    sock.accept();
    await tick();
    await startPromise;

    expect(sessionStore.recordingSession).toBeTruthy();

    const stopPromise = send(state, { type: 'stop', from: 'panel' });
    await tick(10);
    await stopPromise;

    expect(sock.payloads().some((p) => p.type === 'finish')).toBe(true);
    expect(sessionStore.recordingSession).toBeUndefined();
  });

  it('录制标签页已关时恢复即判定录制结束并清会话', async () => {
    sessionStore.recordingSession = {
      wsUrl: 'ws://sut/recorder',
      sessionId: 'sid-9',
      token: 'tok-9',
      mode: 'fresh',
      incognito: false,
      webTabId: 77,
      recordingTabId: 9999, // 已被用户关掉
      recordingTabs: [],
      nextTabIndex: 1,
      paused: false,
      stepCount: 3,
      pending: [],
    };
    const { state } = await load();
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(sessionStore.recordingSession).toBeUndefined();
    const resp = await send(state, { type: 'step', dsl: CLICK });
    expect(resp.ok).toBe(false);
  });
});
