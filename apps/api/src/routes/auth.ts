import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import {
  changePassword,
  getMe,
  login,
  logout,
  switchOrganization,
  verifyPassword,
  verifyPasswordChangeToken,
  PasswordValidationError,
} from '../services/auth.service.js';

export const authRoute = Router();

const COOKIE_NAME = 'authToken';
const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 与 JWT 8h 对齐

function setAuthCookie(res: import('express').Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
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
  setAuthCookie(res, result.token);
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
  setAuthCookie(res, result.token);
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
  setAuthCookie(res, result.token);
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
