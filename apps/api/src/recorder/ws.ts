import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';

export interface RecorderTabEvent {
  kind: 'opened' | 'closed';
  tabRef: string;
  title?: string;
  url?: string;
}

export interface RecorderSession {
  sessionId: string;
  caseId: string;
  steps: unknown[];
  ws?: WebSocket;
  mode?: 'fresh' | 'append' | 'resume' | 'incognito';
  incognito?: boolean;
  resumeFromOrder?: number;
  tabs?: RecorderTabEvent[];
  /** web 中台启动录制时传入的目标 URL；finish() 用作 test_cases.url 的来源之一。 */
  targetUrl?: string | null;
  /** test_sessions audit row id, set by the route that persisted it. */
  dbSessionId?: string;
}

const sessions = new Map<string, RecorderSession>();
const secret = process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me';

export function attachRecorderWs(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/recorder') return;
    const sessionId = url.searchParams.get('sessionId');
    const token = url.searchParams.get('token');
    if (!sessionId || !token || token !== secret) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = sessions.get(sessionId);
      if (!session) {
        ws.close(1008, 'unknown session');
        return;
      }
      session.ws = ws;
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'step') session.steps.push(msg.step);
          else if (msg.type === 'tab-event' && session.tabs) session.tabs.push(msg.event);
          else if (msg.type === 'finish') ws.close(1000);
        } catch {
          // ignore malformed
        }
      });
      ws.on('close', () => {
        if (session.ws === ws) session.ws = undefined;
      });
    });
  });
}

export function createSession(
  caseId: string,
  opts: { mode?: 'fresh' | 'append' | 'resume' | 'incognito'; incognito?: boolean; resumeFromOrder?: number; targetUrl?: string | null } = {},
): RecorderSession {
  const session: RecorderSession = {
    sessionId: crypto.randomUUID(),
    caseId,
    steps: [],
    mode: opts.mode ?? 'fresh',
    incognito: opts.incognito ?? false,
    resumeFromOrder: opts.resumeFromOrder,
    tabs: [],
    targetUrl: opts.targetUrl ?? null,
  };
  sessions.set(session.sessionId, session);
  return session;
}

export function getSession(id: string) {
  return sessions.get(id);
}
