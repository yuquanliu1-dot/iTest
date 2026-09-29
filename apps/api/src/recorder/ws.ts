import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';

export interface RecorderSession {
  sessionId: string;
  caseId: string;
  steps: unknown[];
  ws?: WebSocket;
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
          if (msg.type === 'finish') ws.close(1000);
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

export function createSession(caseId: string): RecorderSession {
  const session: RecorderSession = { sessionId: crypto.randomUUID(), caseId, steps: [] };
  sessions.set(session.sessionId, session);
  return session;
}

export function getSession(id: string) {
  return sessions.get(id);
}
