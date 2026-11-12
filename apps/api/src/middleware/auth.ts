import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { HttpError } from './errorHandler.js';
import { verifySessionToken, type AuthUser } from '../services/auth.service.js';
import { isPathInSubtree } from '../services/org-path.js';
import { wrap } from '../lib/cache.js';
import { tokenVersionKey } from '../lib/cache-keys.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Extracts the token from the Bearer header or the authToken cookie (the cookie path serves requests that cannot carry headers, such as EventSource/links). */
export function extractAuthToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  const cookie = req.headers.cookie;
  if (cookie) {
    const m = cookie.match(/(?:^|;\s*)authToken=([^;]+)/);
    if (m) return decodeURIComponent(m[1]!);
  }
  return null;
}

// Chrome extension-only endpoints: self-authenticated via RECORDER_TOKEN / session id, bypassing user sessions
const EXTENSION_PATHS: Array<{ method: string; pattern: RegExp }> = [
  // secrets.ts verifies Bearer RECORDER_TOKEN_SECRET itself
  { method: 'GET', pattern: /^\/cases\/[^/]+\/steps\/secrets\/[^/]+$/ },
  // Recorder tab event upload; the session id is the credential (kept as-is)
  { method: 'POST', pattern: /^\/recorder\/sessions\/[^/]+\/tab-events$/ },
];

function isExtensionPath(method: string, path: string): boolean {
  return EXTENSION_PATHS.some((e) => e.method === method && e.pattern.test(path));
}

/**
 * Blanket login guard: signature verification → DB token_version lookup (logout/password change revoke instantly) → attach req.user.
 * Failures uniformly 401; unreachable DB vs invalid token are not distinguished in the message.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (isExtensionPath(req.method, req.path)) {
      next();
      return;
    }
    const token = extractAuthToken(req);
    const payload = token ? verifySessionToken(token) : null;
    if (!payload) throw new HttpError(401, 'unauthorized', '未登录或会话已过期');
    // tokenVersion short cache (30s): after logout/password change bumps +1, the entry point where the old JWT fails
    // verification never reaches the cache key, but legitimate JWTs issued within 30s still hit the database read
    // here to reduce SQL.
    const currentVersion = await wrap(tokenVersionKey(payload.userId), 30_000, async () => {
      const rows = await db.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, payload.userId)).limit(1);
      return rows[0]?.tokenVersion ?? null;
    });
    if (currentVersion === null || currentVersion !== payload.tokenVersion) {
      throw new HttpError(401, 'unauthorized', '未登录或会话已过期');
    }
    req.user = payload;
    next();
  } catch (err) {
    next(err);
  }
}

/** A manager of the active organization (or any of its ancestors) counts as an "effective manager". */
export function isEffectiveManager(user: AuthUser): boolean {
  return user.managerOrgPaths.some((p) => isPathInSubtree(user.orgPath, p));
}

/** Whether the user is a manager of the organization containing targetOrgPath (or its ancestors). */
export function isManagerOfOrg(user: AuthUser, targetOrgPath: string | null): boolean {
  return targetOrgPath != null && user.managerOrgPaths.some((p) => isPathInSubtree(targetOrgPath, p));
}

export function requireManager(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new HttpError(401, 'unauthorized', '未登录或会话已过期'));
    return;
  }
  if (!isEffectiveManager(req.user)) {
    next(new HttpError(403, 'forbidden', '需要管理员角色'));
    return;
  }
  next();
}
