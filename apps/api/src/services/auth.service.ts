import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { membershipsOf } from './orgTree.js';
import { isPathInSubtree } from './org-path.js';
import { wrap } from '../lib/cache.js';
import { meKey } from '../lib/cache-keys.js';

const JWT_SECRET: string = process.env.AUTH_JWT_SECRET ?? ((): string => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_JWT_SECRET environment variable is required in production');
  }
  console.warn('[WARN] 使用默认 JWT 密钥。生产环境必须设置 AUTH_JWT_SECRET。');
  return 'dev-auth-secret-change-me';
})();
const JWT_EXPIRES_IN = '8h';
const SALT_ROUNDS = 10;

// Short-lived token for forced password change on first login: separate scope, valid for 5 minutes
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
  languagePreference: string;
}

function toSafeUser(row: typeof users.$inferSelect): SafeUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    languagePreference: row.languagePreference,
  };
}

/** JWT payload: carries the full tenant context (active org + roles + manageable subtree + revision version). */
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
    // Old tokens missing orgPath/managerOrgPaths/tokenVersion are forced to re-login
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

/** Computes managerOrgPaths (the list of managed org paths) from the membership list. */
function managerOrgPathsOf(memberships: Array<{ path: string; isManager: boolean }>): string[] {
  return memberships.filter((m) => m.isManager).map((m) => m.path);
}

/**
 * Whether the user is an "effective manager" — the algorithm shares its source of truth with how login/switchOrganization derive AuthUser:
 * the shortest-path membership is the active org; any membership (of the active one or an ancestor) with isManager → effective manager.
 * Lets space-assistant tools lazily resolve management rights from createdByUserId when there's no JWT context (membershipsOf is cached).
 */
export async function isEffectiveManagerOf(userId: string): Promise<boolean> {
  const memberships = await membershipsOf(userId);
  if (memberships.length === 0) return false;
  const active = [...memberships].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))[0]!;
  return memberships.some((m) => m.isManager && isPathInSubtree(active.path, m.path));
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
    // Timing-aligned dummy bcrypt compare, preventing username enumeration via response time
    await bcrypt.compare('dummy', '$2b$10$0000000000000000000000000000000000000000000000000000');
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;

  // First login (never changed password) or flagged must-change → enter the password-change flow
  const mustReset = user.mustChangePassword || user.passwordUpdatedAt === null;
  if (mustReset) {
    return { status: 'password_change_required', passwordChangeToken: generatePasswordChangeToken(user.id, user.username), username: user.username };
  }

  const memberships = await membershipsOf(user.id);
  if (memberships.length === 0) return null;

  // Shortest path wins (root org first); ties broken stably by lexicographic order
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
  // tokenVersion is carried in the JWT by the caller and used as a key suffix for versioned keys:
  // after logout/password change tokenVersion+1, old JWTs carry the old tv → the old key is unreachable (naturally invalid), no explicit del needed.
  // activeOrgId stays out of the key (memberships don't change when switching orgs, so the same tv can be reused).
  const user = await findById(userId);
  if (!user) return null;
  // An empty-string placeholder strongly binds the key to tokenVersion, avoiding an extra dimension from activeOrgId changes
  const cacheKey = meKey(userId, user.tokenVersion);
  return wrap(cacheKey, 60_000, async () => {
    const memberships = await membershipsOf(userId);
    return {
      user: toSafeUser(user),
      activeOrganizationId: activeOrgId,
      organizations: memberships.map((m) => ({ id: m.id, name: m.name, parentId: m.parentId, path: m.path, isManager: m.isManager, isUser: m.isUser })),
    };
  });
}

/**
 * Change password: validate strength → write new hash + clear the must-change flag → tokenVersion+1
 * (changing the password is revocation: all of the user's existing JWTs invalidate immediately).
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

/** Logout → tokenVersion+1, instantly invalidating all of the user's existing JWTs (single-point logout kicks every device; safer for an internal tool). */
export async function logout(userId: string): Promise<void> {
  const user = await findById(userId);
  if (!user) return; // silently succeeds when the user doesn't exist
  await db.update(users).set({ tokenVersion: user.tokenVersion + 1, updatedAt: new Date() }).where(eq(users.id, userId));
}

/** Finds a user by username (used by member management to add members); returns null when missing. */
export async function findUserByUsername(username: string): Promise<{ id: string; username: string; displayName: string } | null> {
  const rows = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Generates a one-time temporary password (for admin/manager resetting someone else's password). Satisfies PASSWORD_POLICY:
 *   - length 12 (between 10-64)
 *   - contains lowercase, uppercase, digits, special chars
 * The charset avoids confusable characters (0/O, 1/l/I) so the password is less error-prone when relayed in a console/chat.
 */
const TEMP_PASSWORD_LENGTH = 12;
const TEMP_PASSWORD_CHARSET =
  'abcdefghijkmnpqrstuvwxyz' + // drop l
  'ABCDEFGHJKLMNPQRSTUVWXYZ' + // drop I, O
  '23456789' + // drop 0, 1
  '!@#$%^&*';
export function generateRandomPassword(): string {
  // crypto.randomInt is synchronous in Node 22, avoiding the callback-form overhead
  const buf = new Uint32Array(TEMP_PASSWORD_LENGTH);
  // Node's global crypto exposes randomUUID / getRandomValues since 19+
  (globalThis.crypto as Crypto).getRandomValues(buf);
  let out = '';
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    out += TEMP_PASSWORD_CHARSET[buf[i]! % TEMP_PASSWORD_CHARSET.length];
  }
  return out;
}
