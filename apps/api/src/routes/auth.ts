import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, organizationMembers } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import {
  changePassword,
  generateRandomPassword,
  getMe,
  login,
  logout,
  switchOrganization,
  verifyPassword,
  verifyPasswordChangeToken,
  PasswordValidationError,
} from '../services/auth.service.js';
import { userService } from '../services/user.service.js';
import { getOrgPath } from '../services/orgTree.js';
import { isManagerOfOrg } from '../middleware/auth.js';

export const authRoute = Router();

const COOKIE_NAME = 'authToken';
const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 与 JWT 8h 对齐

import type { Request, Response } from 'express';

/** secure 跟随反向代理报告的协议；直连时按 NODE_ENV 决定。 */
function cookieSecureFlag(req: Request): boolean {
  const xfpRaw = req.headers['x-forwarded-proto'];
  const xfp = (typeof xfpRaw === 'string' ? xfpRaw : Array.isArray(xfpRaw) ? xfpRaw[0] : undefined)
    ?.split(',')[0]?.trim().toLowerCase();
  if (xfp === 'https') return true;
  if (xfp === 'http') return false;
  return process.env.NODE_ENV === 'production';
}

function setAuthCookie(req: Request, res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieSecureFlag(req),
    sameSite: 'strict',
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

function clearAuthCookie(res: import('express').Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

const LoginBody = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(128),
});

authRoute.post('/login', async (req, res) => {
  const body = LoginBody.parse(req.body);
  const result = await login(body.username, body.password);
  if (!result) throw new HttpError(401, 'invalid_credentials', '用户名或密码错误');
  if (result.status === 'password_change_required') {
    res.json(result);
    return;
  }
  setAuthCookie(req, res, result.token);
  res.json({ status: 'ok', user: result.user, organization: result.organization });
});

const ChangePasswordBody = z.object({
  passwordChangeToken: z.string().min(1),
  newPassword: z.string().min(1).max(128),
});

// 首登强制改密：改密成功后自动登录（发新会话 cookie）
authRoute.post('/change-password', async (req, res) => {
  const body = ChangePasswordBody.parse(req.body);
  const payload = verifyPasswordChangeToken(body.passwordChangeToken);
  if (!payload) throw new HttpError(401, 'invalid_token', '改密链接已失效，请重新登录');
  // 一次性消费：用户一旦完成过改密（已不在强制改密态），同一条改密 token 立即作废
  const pending = await db
    .select({ mustChangePassword: users.mustChangePassword, passwordUpdatedAt: users.passwordUpdatedAt })
    .from(users)
    .where(eq(users.id, payload.userId))
    .limit(1);
  const u = pending[0];
  if (!u || !(u.mustChangePassword || u.passwordUpdatedAt === null)) {
    throw new HttpError(401, 'invalid_token', '改密链接已失效，请重新登录');
  }
  try {
    await changePassword(payload.userId, body.newPassword);
  } catch (err) {
    if (err instanceof PasswordValidationError) {
      throw new HttpError(400, 'weak_password', err.reason);
    }
    throw err;
  }
  const result = await login(payload.username, body.newPassword);
  if (!result || result.status !== 'ok') throw new HttpError(401, 'invalid_credentials', '用户名或密码错误');
  setAuthCookie(req, res, result.token);
  res.json({ status: 'ok', user: result.user, organization: result.organization });
});

authRoute.get('/me', requireAuth, async (req, res) => {
  const me = await getMe(req.user!.userId, req.user!.orgId);
  if (!me) throw new HttpError(401, 'unauthorized', '未登录或会话已过期');
  res.json(me);
});

const SwitchOrgBody = z.object({
  organizationId: z.string().uuid(),
});

// 切换组织 = 重铸 cookie（新 JWT 携带新组织上下文）
authRoute.post('/switch-org', requireAuth, async (req, res) => {
  const body = SwitchOrgBody.parse(req.body);
  const result = await switchOrganization(req.user!.userId, body.organizationId);
  if (!result) throw new HttpError(403, 'forbidden', '不是该组织成员');
  setAuthCookie(req, res, result.token);
  res.json({ organization: result.organization, isManager: result.isManager, isUser: result.isUser });
});

authRoute.post('/logout', requireAuth, async (req, res) => {
  await logout(req.user!.userId);
  clearAuthCookie(res);
  res.json({ ok: true });
});

const UpdateMyPasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(1).max(128),
});

// 自助改密：改完 tokenVersion+1 旧会话吊销，客户端需重新登录
authRoute.patch('/me/password', requireAuth, async (req, res) => {
  const body = UpdateMyPasswordBody.parse(req.body);
  const userRows = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, req.user!.userId)).limit(1);
  const current = userRows[0];
  if (!current || !(await verifyPassword(body.currentPassword, current.passwordHash))) {
    throw new HttpError(400, 'wrong_password', '当前密码不正确');
  }
  try {
    await changePassword(req.user!.userId, body.newPassword, { checkOldByHash: current.passwordHash });
  } catch (err) {
    if (err instanceof PasswordValidationError) {
      throw new HttpError(400, 'weak_password', err.reason);
    }
    throw err;
  }
  clearAuthCookie(res);
  res.json({ status: 'ok' });
});

const RegisterAdminBody = z.object({
  username: z.string().min(3).max(50),
  displayName: z.string().min(1).max(100),
  email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  organizationId: z.string().uuid(),
});

/** POST /register-admin — Manager 在指定组织创建账号。后端生成临时密码 + 强制首登改密 + 加为该组织普通成员。
 *  与 /auth/login 同款 /api/auth 子路径；auth.ts 在 requireAuth 毯子守卫之前挂载于 /api/auth。 */
authRoute.post('/register-admin', requireAuth, async (req, res) => {
  const body = RegisterAdminBody.parse(req.body);
  const targetOrgPath = await getOrgPath(body.organizationId);
  if (!targetOrgPath) throw new HttpError(404, 'not_found', 'target organization not found');
  if (!isManagerOfOrg(req.user!, targetOrgPath)) {
    throw new HttpError(403, 'forbidden', '无权管理目标组织');
  }
  try {
    const result = await userService.createUser({
      username: body.username,
      displayName: body.displayName,
      email: body.email ?? null,
      password: generateRandomPassword(),
      languagePreference: 'zh-CN',
    });
    // 加为该组织普通成员（不传 isManager=true）
    await db.insert(organizationMembers).values({
      organizationId: body.organizationId,
      userId: result.id,
      isManager: false,
      isUser: true,
    });
    // 重新拉一次刚建好的 user（要拿到一次性密码返回）
    // userService.createUser 已经返回 SafeUser 形状；直接取临时密码需要另存。
    // 这里直接重置密码以拿到明文：generate → create 是浪费一次 hash，直接拼装：
    res.status(201).json({
      status: 'ok',
      user: result,
      temporaryPassword: (result as unknown as { _temporaryPassword?: string })._temporaryPassword,
      message: '请将临时密码一次性转交给用户，用户首次登录后将被强制修改',
    });
  } catch (err) {
    if ((err as Error).message === 'Username already exists') {
      throw new HttpError(409, 'conflict', 'Username already exists');
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      throw new HttpError(409, 'conflict', 'Email already in use by another user');
    }
    throw err;
  }
});
