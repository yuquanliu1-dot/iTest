import { generateSessionToken, type AuthUser } from '../../src/services/auth.service.js';

/** 直接构造一个指定组织的管理员身份（跳过登录往返，测试注入 req.user 用）。 */
export function managerUserOf(userId: string, username: string, orgId: string, orgPath: string): AuthUser {
  return {
    userId,
    username,
    orgId,
    orgPath,
    isManager: true,
    isUser: true,
    managerOrgPaths: [orgPath],
    tokenVersion: 1,
  };
}

/** 构造指定组织的普通成员身份（需自行保证 DB 里有对应 membership）。 */
export function memberUserOf(userId: string, username: string, orgId: string, orgPath: string): AuthUser {
  return {
    userId,
    username,
    orgId,
    orgPath,
    isManager: false,
    isUser: true,
    managerOrgPaths: [],
    tokenVersion: 1,
  };
}

/** 铸造 authToken cookie 头（supertest 的 .set('Cookie', ...) 用）。 */
export function authCookie(user: AuthUser): string {
  return `authToken=${generateSessionToken(user)}`;
}
