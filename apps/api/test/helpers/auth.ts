import { generateSessionToken, type AuthUser } from '../../src/services/auth.service.js';

/** Construct a manager identity for a given org directly (skips the login round-trip; used by tests to inject req.user). */
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

/** Construct a regular member identity for a given org (the caller must ensure a matching membership exists in the DB). */
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

/** Mint an authToken cookie header (for supertest's .set('Cookie', ...)). */
export function authCookie(user: AuthUser): string {
  return `authToken=${generateSessionToken(user)}`;
}
