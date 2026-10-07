import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentDeviceSession } from '../src/execute/agentDeviceClient.js';
import type { EngineInput } from '../src/execute/engine.js';

// Mock the agent-device client so we can drive the engine without a real device.
const { acquireDeviceMock } = vi.hoisted(() => ({ acquireDeviceMock: vi.fn() }));
vi.mock('../src/execute/agentDeviceClient.js', () => ({
  acquireDevice: acquireDeviceMock,
}));

// visionAssert is a no-op for mobile (page=undefined); mock it explicitly so the
// engine call doesn't pull in real LLM machinery.
vi.mock('../src/execute/visionAssert.js', () => ({
  runCaseVisionAssert: vi.fn().mockResolvedValue(null),
}));

type SessionOverrides = Partial<AgentDeviceSession>;

function makeStubSession(overrides: SessionOverrides = {}): AgentDeviceSession {
  const tap = vi.fn().mockResolvedValue(undefined);
  const swipe = vi.fn().mockResolvedValue(undefined);
  const type = vi.fn().mockResolvedValue(undefined);
  const fill = vi.fn().mockResolvedValue(undefined);
  const expectApi = {
    toBeVisible: vi.fn().mockResolvedValue(undefined),
    toHaveText: vi.fn().mockResolvedValue(undefined),
  };
  const expectFn = vi.fn().mockReturnValue(expectApi);
  const screenshot = vi.fn().mockResolvedValue(undefined);
  const setAppearance = vi.fn().mockResolvedValue(undefined);
  const setNetwork = vi.fn().mockResolvedValue(undefined);
  const setLocation = vi.fn().mockResolvedValue(undefined);
  const home = vi.fn().mockResolvedValue(undefined);
  const appBack = vi.fn().mockResolvedValue(undefined);
  const openApp = vi.fn().mockResolvedValue(undefined);
  const restartApp = vi.fn().mockResolvedValue(undefined);
  const installApp = vi.fn().mockResolvedValue(undefined);
  // The login button at bounds {0,0,100,40} => center (50, 20).
  const snapshot = vi.fn().mockResolvedValue({
    nodes: [
      {
        accessibilityId: 'loginBtn',
        label: '登录',
        role: 'Button',
        bounds: { x: 0, y: 0, width: 100, height: 40 },
      },
    ],
  });

  const session: AgentDeviceSession = {
    deviceId: 'fake-device',
    viewerUrl: 'http://stub/viewer',
    client: {
      snapshot,
      tap,
      swipe,
      type,
      fill,
      expect: expectFn,
      screenshot,
      setAppearance,
      setNetwork,
      setLocation,
      home,
      appBack,
      openApp,
      restartApp,
      installApp,
    },
    ...overrides,
  };
  // expose the inner vi.fn so tests can introspect without re-mocking.
  (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks = {
    snapshot,
    tap,
    swipe,
    type,
    fill,
    expect: expectFn,
    toBeVisible: expectApi.toBeVisible,
    toHaveText: expectApi.toHaveText,
    screenshot,
    setAppearance,
    setNetwork,
    setLocation,
    home,
    appBack,
    openApp,
    restartApp,
    installApp,
  };
  return session;
}

function buildEngineInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    caseId: 'case-1',
    caseTitle: 'mobile case',
    caseUrl: null,
    expectedOutcome: null,
    steps: [],
    initialVars: {},
    sensitiveVarKeys: [],
    reportId: 'rep-1',
    projectId: 'proj-1',
    incognito: false,
    appRef: { bundleId: 'com.example.app' },
    deviceTargetId: 'iPhone 17 Pro',
    mobileOs: 'ios',
    ...overrides,
  };
}

let session: AgentDeviceSession;

beforeEach(() => {
  acquireDeviceMock.mockReset();
  session = makeStubSession();
  acquireDeviceMock.mockResolvedValue(session);
});

describe('MobileEngine dispatch', () => {
  it('tap: snapshot + tap at bounds center (50,20)', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          compiled: [{ kind: 'tap', locator: [{ strategy: 'accessibilityId', value: 'loginBtn' }] }],
        },
      ],
    });
    await engine.prepare(input);
    expect(acquireDeviceMock).toHaveBeenCalledTimes(1);
    const results = await engine.execute(input);
    const mocks = (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(mocks.tap).toHaveBeenCalledTimes(1);
    expect(mocks.tap).toHaveBeenCalledWith({ x: 50, y: 20 });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('passed');
  });

  it('swipe: from/to centers + durationMs', async () => {
    // Add a second node for the swipe target.
    session.client.snapshot = vi.fn().mockResolvedValue({
      nodes: [
        { accessibilityId: 'a', bounds: { x: 0, y: 0, width: 100, height: 40 } },
        { accessibilityId: 'b', bounds: { x: 0, y: 200, width: 100, height: 40 } },
      ],
    }) as unknown as typeof session.client.snapshot;
    const mocks = (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    mocks.snapshot = session.client.snapshot as unknown as ReturnType<typeof vi.fn>;
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          compiled: [
            {
              kind: 'swipe',
              from: [{ strategy: 'accessibilityId', value: 'a' }],
              to: [{ strategy: 'accessibilityId', value: 'b' }],
              durationMs: 250,
            },
          ],
        },
      ],
    });
    await engine.prepare(input);
    const results = await engine.execute(input);
    expect(mocks.swipe).toHaveBeenCalledTimes(1);
    expect(mocks.swipe).toHaveBeenCalledWith({ fromX: 50, fromY: 20, toX: 50, toY: 220, durationMs: 250 });
    expect(results[0]!.status).toBe('passed');
  });

  it('fill: materialized value passed to session.client.fill', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      initialVars: { user: 'alice' },
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          compiled: [
            {
              kind: 'fill',
              locator: [{ strategy: 'css', value: '#u' }],
              value: '{{user}}',
            },
          ],
        },
      ],
    });
    await engine.prepare(input);
    await engine.execute(input);
    const mocks = (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(mocks.fill).toHaveBeenCalledTimes(1);
    expect(mocks.fill).toHaveBeenCalledWith({ selector: '#u', value: 'alice' });
  });

  it('click: snapshot + tap delegated to center', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          compiled: [{ kind: 'click', locator: [{ strategy: 'accessibilityId', value: 'loginBtn' }] }],
        },
      ],
    });
    await engine.prepare(input);
    const results = await engine.execute(input);
    const mocks = (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(mocks.tap).toHaveBeenCalledTimes(1);
    expect(mocks.tap).toHaveBeenCalledWith({ x: 50, y: 20 });
    expect(results[0]!.status).toBe('passed');
  });

  it('assertVisible: expect().toBeVisible called with selector', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          compiled: [{ kind: 'assertVisible', locator: [{ strategy: 'css', value: '#ok' }] }],
        },
      ],
    });
    await engine.prepare(input);
    await engine.execute(input);
    const mocks = (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(mocks.expect).toHaveBeenCalledWith('#ok');
    expect(mocks.toBeVisible).toHaveBeenCalledTimes(1);
  });

  it('assertText: expect().toHaveText called with materialized equals', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      initialVars: { role: 'admin' },
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          compiled: [
            { kind: 'assertText', locator: [{ strategy: 'css', value: '#who' }], equals: 'role:{{role}}' },
          ],
        },
      ],
    });
    await engine.prepare(input);
    await engine.execute(input);
    const mocks = (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(mocks.expect).toHaveBeenCalledWith('#who');
    expect(mocks.toHaveText).toHaveBeenCalledWith('role:admin');
  });

  it('setNetwork airplane: client.setNetwork called', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          compiled: [{ kind: 'setNetwork', state: 'airplane' }],
        },
      ],
    });
    await engine.prepare(input);
    await engine.execute(input);
    const mocks = (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(mocks.setNetwork).toHaveBeenCalledWith({ state: 'airplane' });
  });

  it('setAppearance dark: client.setAppearance called', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          compiled: [{ kind: 'setAppearance', mode: 'dark' }],
        },
      ],
    });
    await engine.prepare(input);
    await engine.execute(input);
    const mocks = (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(mocks.setAppearance).toHaveBeenCalledWith({ mode: 'dark' });
  });

  it('setLocation: client.setLocation called with lat/lng', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          compiled: [{ kind: 'setLocation', latitude: 1, longitude: 2 }],
        },
      ],
    });
    await engine.prepare(input);
    await engine.execute(input);
    const mocks = (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(mocks.setLocation).toHaveBeenCalledWith({ latitude: 1, longitude: 2 });
  });

  it('home: client.home called', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          compiled: [{ kind: 'home' }],
        },
      ],
    });
    await engine.prepare(input);
    await engine.execute(input);
    const mocks = (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(mocks.home).toHaveBeenCalledTimes(1);
  });

  it('appBack: client.appBack called', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          compiled: [{ kind: 'appBack' }],
        },
      ],
    });
    await engine.prepare(input);
    await engine.execute(input);
    const mocks = (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(mocks.appBack).toHaveBeenCalledTimes(1);
  });

  it('appOpen without explicit bundleId uses cached bundleId from prepare', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      appRef: { bundleId: 'com.cached.app' },
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          // action.bundleId omitted intentionally
          compiled: [{ kind: 'appOpen' }],
        },
      ],
    });
    await engine.prepare(input);
    expect(engine.cachedBundleId).toBe('com.cached.app');
    await engine.execute(input);
    const mocks = (session as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(mocks.openApp).toHaveBeenCalledWith({ bundleId: 'com.cached.app' });
  });

  it('unsupported kind (select) → step fails with MobileUnsupportedCapability', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    const engine = new MobileEngine();
    const input = buildEngineInput({
      steps: [
        {
          order: 1,
          id: 's1',
          assertion: null,
          delayMs: null,
          tabRef: null,
          componentKind: null,
          sensitive: false,
          compiled: [{ kind: 'select', locator: [{ strategy: 'css', value: 'select#x' }], values: ['a'] }],
        },
      ],
    });
    await engine.prepare(input);
    const results = await engine.execute(input);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureReason).toBe('MobileUnsupportedCapability');
    expect(results[0]!.error).toContain('select');
  });
});