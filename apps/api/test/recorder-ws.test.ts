import { describe, it, expect, beforeAll } from 'vitest';
import { attachRecorderWs, createSession, getSessionSteps, getSessionTabs } from '../src/recorder/ws.js';
import { Server } from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';

let port: number;
let server: Server;

beforeAll(async () => {
  server = new Server();
  attachRecorderWs(server);
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as AddressInfo).port;
});

describe('recorder/ws envelope', () => {
  it('accepts step with tabRef and componentKind', async () => {
    const session = createSession('00000000-0000-0000-0000-000000000aaa');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/recorder?sessionId=${session.sessionId}&token=dev-secret-change-me`);
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    ws.send(JSON.stringify({
      type: 'step',
      step: {
        action: { kind: 'click', locator: [{ strategy: 'css', value: '#x' }] },
        url: 'https://example.com',
        tabRef: `${session.sessionId}|tab#0`,
        componentKind: 'select',
      },
    }));
    await new Promise((r) => setTimeout(r, 50));
    const got = await getSessionSteps(session.sessionId);
    expect(got).toHaveLength(1);
    expect((got[0] as { tabRef: string }).tabRef).toBe(`${session.sessionId}|tab#0`);
    expect((got[0] as { componentKind: string }).componentKind).toBe('select');
    ws.close();
  });

  it('accepts tab-event messages and appends to session.tabs', async () => {
    const session = createSession('00000000-0000-0000-0000-000000000bbb');
    session.mode = 'fresh';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/recorder?sessionId=${session.sessionId}&token=dev-secret-change-me`);
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    ws.send(JSON.stringify({
      type: 'tab-event',
      event: { kind: 'opened', tabRef: `${session.sessionId}|tab#1`, title: 'child', url: 'https://example.com/c' },
    }));
    await new Promise((r) => setTimeout(r, 50));
    const tabs = await getSessionTabs(session.sessionId);
    expect(tabs.some((t) => t.tabRef === `${session.sessionId}|tab#1`)).toBe(true);
    ws.close();
  });
});
