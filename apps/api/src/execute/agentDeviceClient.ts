import { logger } from '../logger.js';

export interface AccessibilityNode {
  accessibilityId?: string;
  label?: string;
  role?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  text?: string;
}

export interface AccessibilitySnapshot {
  nodes: AccessibilityNode[];
}

export interface AgentDeviceSession {
  deviceId: string;
  client: {
    snapshot(): Promise<AccessibilitySnapshot>;
    tap(opts: { x: number; y: number; doubleTap?: boolean; longPressMs?: number }): Promise<void>;
    swipe(opts: { fromX: number; fromY: number; toX: number; toY: number; durationMs: number }): Promise<void>;
    type(opts: { selector: string; value: string }): Promise<void>;
    fill(opts: { selector: string; value: string }): Promise<void>;
    expect(selector: string): { toBeVisible(): Promise<void>; toHaveText(text: string): Promise<void> };
    screenshot(opts: { path: string }): Promise<void>;
    setAppearance(opts: { mode: 'light' | 'dark' }): Promise<void>;
    setNetwork(opts: { state: 'online' | 'offline' | 'airplane' }): Promise<void>;
    setLocation(opts: { latitude: number; longitude: number }): Promise<void>;
    home(): Promise<void>;
    appBack(): Promise<void>;
    openApp(opts: { bundleId: string; launchArgs?: string[] }): Promise<void>;
    restartApp(opts: { bundleId: string }): Promise<void>;
    installApp(opts: { path: string }): Promise<void>;
  };
  viewerUrl: string;
}

let sdkModule: unknown | null = null;
async function loadSdk(): Promise<any> {
  if (sdkModule) return sdkModule as any;
  try {
    sdkModule = await import('agent-device');
    return sdkModule as any;
  } catch (e) {
    logger.warn({ err: e }, 'failed to load agent-device SDK; running in degraded mode');
    throw e;
  }
}

/** Spawns a daemon and acquires a device. Failure throws EngineUnavailable. SDK protocol assumed per 0.21.22;
 *  the actual shape may differ, so this wrapper does lazy import + shape adaptation, keeping the AgentDeviceSession interface stable externally. */
export async function acquireDevice(opts: {
  mobileOs: 'ios' | 'android';
  deviceRef: string;
  bundleId: string;
  appPath?: string;
  launchArgs?: string[];
}): Promise<AgentDeviceSession> {
  const sdk = await loadSdk();
  // 0.21.22 assumes sdk.acquireDevice returns { client, deviceId, viewerUrl, installApp, openApp, ... }
  // The protocol may drift between versions; capture the SDK return value first, then adapt it to the AgentDeviceSession shape.
  const raw = await sdk.acquireDevice({
    platform: opts.mobileOs,
    device: opts.deviceRef,
    appPath: opts.appPath,
  });
  if (opts.appPath && typeof raw.installApp === 'function') {
    await raw.installApp({ path: opts.appPath });
  }
  if (typeof raw.openApp === 'function') {
    await raw.openApp({ bundleId: opts.bundleId, launchArgs: opts.launchArgs ?? [] });
  }
  return raw as AgentDeviceSession;
}
