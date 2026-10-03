import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { membershipsOf } from './orgTree.js';

const JWT_SECRET: string = process.env.AUTH_JWT_SECRET ?? ((): string => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_JWT_SECRET environment variable is required in production');
  }
  console.warn('[WARN] 使用默认 JWT 密钥。生产环境必须设置 AUTH_JWT_SECRET。');
  return 'dev-auth-secret-change-me';
})();
const JWT_EXPIRES_IN = '8h';
const SALT_ROUNDS = 10;

// 首登强制改密用的短时 token：独立 scope，5 分钟有效
const PASSWORD_CHANGE_TOKEN_TTL = '5m';

export const PASSWORD_POLICY = {
  minLength: 10,
  maxLength: 64,
};

export type PasswordValidationResult = { ok: true } | { ok: false; reason: string };

export function validatePasswordStrength(password: string): PasswordValidationResult {
  if (password.length < PASSWORD_POLICY.minLength || password.length > PASSWORD_POLICY.maxLength) {
    return { ok: false, reason: `密码长度需在 ${PASSWORD_POLICY.minLength}-${PASSWORD_POLICY.maxLength} 位之间` };
  }
  if (!/[a-z]/.test(password)) return { ok: false, reason: '密码必须包含小写字母' };
  if (!/[A-Z]/.test(password)) return { ok: false, reason: '密码必须包含大写字母' };
  if (!/[0-9]/.test(password)) return { ok: false, reason: '密码必须包含数字' };
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(password)) return { ok: false, reason: '密码必须包含特殊字符' };
  return { ok: true };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export interface SafeUser {
  id: string;
  username: string;
  displayName: string;
  createdAt: Date;
  updatedAt: Date;
}

function toSafeUser(row: typeof users.$inferSelect): SafeUser {
  return { id: row.id, username: row.username, displayName: row.displayName, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** JWT payload：携带完整租户上下文（激活组织 + 角色 + 可管理子树 + 吊销版本号）。 */
export interface AuthUser {
  userId: string;
  username: string;
  orgId: string;
  orgPath: string;
  isManager: boolean;
  isUser: boolean;
  managerOrgPaths: string[];
  tokenVersion: number;
}

export function generateSessionToken(u: AuthUser): string {
  return jwt.sign(
    {
      sub: u.userId,
      username: u.username,
      orgId: u.orgId,
      orgPath: u.orgPath,
      isManager: u.isManager,
      isUser: u.isUser,
      managerOrgPaths: u.managerOrgPaths,
      tokenVersion: u.tokenVersion,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

export function verifySessionToken(token: string): AuthUser | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
    // 缺 orgPath/managerOrgPaths/tokenVersion 的旧 token 强制重登
    if (typeof decoded.orgPath !== 'string' || decoded.orgPath.length === 0) return null;
    if (!Array.isArray(decoded.managerOrgPaths) || !decoded.managerOrgPaths.every((p) => typeof p === 'string')) return null;
    if (typeof decoded.tokenVersion !== 'number') return null;
    return {
      userId: String(decoded.sub),
      username: String(decoded.username),
      orgId: String(decoded.orgId),
      orgPath: decoded.orgPath,
      isManager: !!decoded.isManager,
      isUser: !!decoded.isUser,
      managerOrgPaths: decoded.managerOrgPaths as string[],
      tokenVersion: decoded.tokenVersion,
    };
  } catch {
    return null;
  }
}

export function generatePasswordChangeToken(userId: string, username: string): string {
  return jwt.sign({ sub: userId, username, scope: 'password_change' }, JWT_SECRET, { expiresIn: PASSWORD_CHANGE_TOKEN_TTL });
}

export function verifyPasswordChangeToken(token: string): { userId: string; username: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
    if (decoded.scope !== 'password_change' || typeof decoded.sub !== 'string') return null;
    return { userId: decoded.sub, username: String(decoded.username ?? '') };
  } catch {
    return null;
  }
}

export class PasswordValidationError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = 'PasswordValidationError';
  }
}

/** 从成员资格列表计算 managerOrgPaths（管理的组织的 path 列表）。 */
function managerOrgPathsOf(memberships: Array<{ path: string; isManager: boolean }>): string[] {
  return memberships.filter((m) => m.isManager).map((m) => m.path);
}

async function findById(userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

async function findByUsername(username: string) {
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return rows[0] ?? null;
}

export type LoginResult =
  | { status: 'ok'; token: string; user: SafeUser; organization: { id: string; name: string; isManager: boolean; isUser: boolean } }
  | { status: 'password_change_required'; passwordChangeToken: string; username: string };

export async function login(username: string, password: string): Promise<LoginResult | null> {
  const user = await findByUsername(username);
  if (!user) {
    // 时序对齐的 dummy bcrypt 比较，防止按响应时间枚举用户名
    await bcrypt.compare('dummy', '$2b$10$0000000000000000000000000000000000000000000000000000');
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;

  // 首登（从未改密）或被标记强制改密 → 进入改密流程
  const mustReset = user.mustChangePassword || user.passwordUpdatedAt === null;
  if (mustReset) {
    return { status: 'password_change_required', passwordChangeToken: generatePasswordChangeToken(user.id, user.username), username: user.username };
  }

  const memberships = await membershipsOf(user.id);
  if (memberships.length === 0) return null;

  // path 最短者优先（根组织优先）；同长按字典序稳定排序
  const sorted = [...memberships].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  const active = sorted[0]!;

  const token = generateSessionToken({
    userId: user.id,
    username: user.username,
    orgId: active.organizationId,
    orgPath: active.path,
    isManager: active.isManager,
    isUser: active.isUser,
    managerOrgPaths: managerOrgPathsOf(memberships),
    tokenVersion: user.tokenVersion,
  });
  return {
    status: 'ok',
    token,
    user: toSafeUser(user),
    organization: { id: active.organizationId, name: active.name, isManager: active.isManager, isUser: active.isUser },
  };
}

export async function switchOrganization(userId: string, organizationId: string): Promise<{
  organization: { id: string; name: string };
  isManager: boolean;
  isUser: boolean;
  token: string;
} | null> {
  const user = await findById(userId);
  if (!user) return null;
  const memberships = await membershipsOf(userId);
  const target = memberships.find((m) => m.organizationId === organizationId);
  if (!target) return null;

  const token = generateSessionToken({
    userId,
    username: user.username,
    orgId: target.organizationId,
    orgPath: target.path,
    isManager: target.isManager,
    isUser: target.isUser,
    managerOrgPaths: managerOrgPathsOf(memberships),
    tokenVersion: user.tokenVersion,
  });
  return { organization: { id: target.id, name: target.name }, isManager: target.isManager, isUser: target.isUser, token };
}

export async function getMe(userId: string, activeOrgId: string): Promise<{
  user: SafeUser;
  activeOrganizationId: string;
  organizations: Array<{ id: string; name: string; parentId: string | null; path: string; isManager: boolean; isUser: boolean }>;
} | null> {
  const user = await findById(userId);
  if (!user) return null;
  const memberships = await membershipsOf(userId);
  return {
    user: toSafeUser(user),
    activeOrganizationId: activeOrgId,
    organizations: memberships.map((m) => ({ id: m.id, name: m.name, parentId: m.parentId, path: m.path, isManager: m.isManager, isUser: m.isUser })),
  };
}

/**
 * 修改密码：校验强度 → 写新 hash + 清除强制改密标记 → tokenVersion+1
 * （改密即吊销：该用户所有现存 JWT 立即失效）。
 */
export async function changePassword(userId: string, newPassword: string, opts: { checkOldByHash?: string } = {}): Promise<void> {
  const pv = validatePasswordStrength(newPassword);
  if (!pv.ok) throw new PasswordValidationError(pv.reason);

  const user = await findById(userId);
  if (!user) throw new Error('user not found');

  if (opts.checkOldByHash && (await bcrypt.compare(newPassword, opts.checkOldByHash))) {
    throw new PasswordValidationError('新密码不能与旧密码相同');
  }

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash, passwordUpdatedAt: new Date(), mustChangePassword: false, tokenVersion: user.tokenVersion + 1, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/** 登出 → tokenVersion+1，让该用户所有现存 JWT 即时失效（单点登出踢掉全部设备，内部工具语义下更安全）。 */
export async function logout(userId: string): Promise<void> {
  const user = await findById(userId);
  if (!user) return; // 用户不存在时静默成功
  await db.update(users).set({ tokenVersion: user.tokenVersion + 1, updatedAt: new Date() }).where(eq(users.id, userId));
}

/** 按 username 查用户（成员管理添加成员用）；不存在返回 null。 */
export async function findUserByUsername(username: string): Promise<{ id: string; username: string; displayName: string } | null> {
  const rows = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 生成一次性临时密码（admin/manager 重置他人密码用）。满足 PASSWORD_POLICY：
 *   - 长度 12（介于 10-64 之间）
 *   - 含小写、大写、数字、特殊字符
 * 字符集避开易混淆字符（0/O、1/l/I），密码在控制台/聊天里复述不易抄错。
 */
const TEMP_PASSWORD_LENGTH = 12;
const TEMP_PASSWORD_CHARSET =
  'abcdefghijkmnpqrstuvwxyz' + // 去掉 l
  'ABCDEFGHJKLMNPQRSTUVWXYZ' + // 去掉 I, O
  '23456789' + // 去掉 0, 1
  '!@#$%^&*';
export function generateRandomPassword(): string {
  // crypto.randomInt 在 Node 22 是同步的，避免 callback 形态的额外开销
  const buf = new Uint32Array(TEMP_PASSWORD_LENGTH);
  // Node 全局 crypto 在 19+ 暴露 randomUUID / getRandomValues
  (globalThis.crypto as Crypto).getRandomValues(buf);
  let out = '';
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    out += TEMP_PASSWORD_CHARSET[buf[i]! % TEMP_PASSWORD_CHARSET.length];
  }
  return out;
}
