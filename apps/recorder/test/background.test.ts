import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for the session/transport layer of background.js.
 *
 * Covers the three "silent step loss" paths from the b0dbb886 family:
 *  ① WS gate dropping steps → queue + re-send on connect;
 *  ② MV3 SW being reclaimed → session state persisted to storage.session, resumed with the same sessionId on wake;
 *  ③ popup ack false success → step messages changed to end-to-end receipts.
 *
 * background.js is a plain JS ESM that touches chrome.* at the top level, so stubs are installed here before a dynamic import.
 */

/** chrome API stubs: only the surface background.js actually uses. */
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
    // The server closes the connection when it receives finish (the msg.type === 'finish' branch in apps/api/src/recorder/ws.ts)
    if (data.includes('"type":"finish"')) this.close();
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** Simulates the server accepting the connection */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** Simulates the connection being dropped */
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

/** Waits several microtask rounds: the await chains inside handlers must finish. */
async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Sends a message to background and waits for its receipt. */
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
    // background.js is a plain JS module (no .d.ts in the repo); the test only cares about its side effects
    // @ts-expect-error no type declaration found for '../background.js'
    await import('../background.js');
    await tick();
    return { chrome, state };
  }

  it('连接未就绪时步骤入队而不是丢弃，连上后按序补发', async () => {
    const { state } = await load();
    // start: connection not accepted yet
    const startPromise = send(state, { type: 'start', session: SESSION });
    await tick();
    const sock = FakeWebSocket.instances[0]!;
    expect(sock.url).toContain('sessionId=sid-1');

    // A step arrives while the connection is not ready: background accepts it (not dropped), but has not sent it yet
    const resp = await send(state, { type: 'step', dsl: CLICK });
    expect(resp.ok).toBe(true);
    expect(sock.sent).toHaveLength(0);

    // Connection established → re-send queued steps
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

    // Connection dropped
    sock.drop();
    await tick();

    // Two steps arrive while disconnected → queued
    const r1 = await send(state, { type: 'step', dsl: CLICK });
    const r2 = await send(state, { type: 'step', dsl: { kind: 'fill', locator: [], value: 'a' } });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(sock.sent).toHaveLength(0);

    // Auto-reconnect after 1s backoff
    await vi.advanceTimersByTimeAsync(1000);
    const sock2 = FakeWebSocket.instances[1]!;
    expect(sock2.url).toContain('sessionId=sid-1');
    sock2.accept();
    await tick();

    expect(sock2.payloads().map((p) => p.step.action.kind)).toEqual(['click', 'fill']);
  });

  it('SW 被回收后按 storage.session 恢复会话并继续投递步骤', async () => {
    // Simulates the session snapshot written by the previous SW round
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
    // Reconnects with the same sessionId on restore (the server resumes writing based on it)
    const sock = FakeWebSocket.instances[0]!;
    expect(sock.url).toContain('sessionId=sid-9');
    sock.accept();
    await tick();

    // Steps arriving after restore are delivered as usual (no longer swallowed by the empty gate)
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
      recordingTabId: 9999, // already closed by the user
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
