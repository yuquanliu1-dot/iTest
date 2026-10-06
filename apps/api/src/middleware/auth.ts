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

/** 从 Bearer 头或 authToken cookie 取令牌（cookie 通路供 EventSource/链接等无法带头的请求使用）。 */
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

// Chrome 扩展专用端点：用 RECORDER_TOKEN / session id 自鉴权，不走用户会话
const EXTENSION_PATHS: Array<{ method: string; pattern: RegExp }> = [
  // secrets.ts 自校验 Bearer RECORDER_TOKEN_SECRET
  { method: 'GET', pattern: /^\/cases\/[^/]+\/steps\/secrets\/[^/]+$/ },
  // 录制器 tab 事件上报，session id 即凭据（保持现状）
  { method: 'POST', pattern: /^\/recorder\/sessions\/[^/]+\/tab-events$/ },
];

function isExtensionPath(method: string, path: string): boolean {
  return EXTENSION_PATHS.some((e) => e.method === method && e.pattern.test(path));
}

/**
 * 毯子登录守卫：签名校验 → 回查 DB token_version（登出/改密吊销即时生效）→ 挂 req.user。
 * 失败统一 401；不可达/无效 token 不区分文案。
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
    // tokenVersion 短缓存(30s):登出/改密走 +1 后旧 JWT 校验失败的入口不会落到缓存键,
    // 但 30s 内已签发的合法 JWT 仍能命中此处的数据库读取以减少 SQL。
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

/** 激活组织（或其任一祖先）的管理员视为「有效管理员」。 */
export function isEffectiveManager(user: AuthUser): boolean {
  return user.managerOrgPaths.some((p) => isPathInSubtree(user.orgPath, p));
}

/** 用户是否 targetOrgPath 所在组织（或其祖先）的管理员。 */
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
