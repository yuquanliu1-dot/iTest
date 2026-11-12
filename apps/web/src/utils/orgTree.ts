/**
 * Organization materialized-path utilities for the iTest frontend (same source as the backend services/orgTree.ts / org-path.ts).
 * Only frontend-derived computation: subtree checks, depth, sorting, fallback org selection, etc. The backend still treats
 * the path field as the single source of truth; the frontend must not rely on this module for authoritative decisions.
 */

export interface PathedOrg {
  id: string;
  path?: string | null;
}

/** Materialized-path depth: /a/ → 1, /a/b/ → 2; an empty path falls back to 0. */
export const orgDepth = (path?: string | null): number =>
  path ? path.split('/').filter(Boolean).length : 0;

/** Derives the direct parent's path from the materialized path: '/a/b/c/' → '/a/b/'; top-level nodes return null. */
export const parentPathOf = (path: string): string | null => {
  const segs = path.split('/').filter(Boolean);
  if (segs.length <= 1) return null;
  return `/${segs.slice(0, -1).join('/')}/`;
};

/** Sorts by materialized path into tree shape (parents before children), returning a new array; entries without a path sort to the front. */
export const sortByPath = <T extends PathedOrg>(orgs: readonly T[]): T[] =>
  [...orgs].sort((a, b) => (a.path || '').localeCompare(b.path || ''));

/** Whether candidate lies within ancestor's subtree (self included); same source as the backend isPathInSubtree. */
export const isPathInSubtree = (candidatePath: string, ancestorPath: string): boolean => {
  const cand = candidatePath.endsWith('/') ? candidatePath : candidatePath + '/';
  const anc = ancestorPath.endsWith('/') ? ancestorPath : ancestorPath + '/';
  return cand === anc || cand.startsWith(anc);
};

const normPath = (p: string): string => (p.endsWith('/') ? p : `${p}/`);

/**
 * Picks the replacement active org after an organization is deleted: walk up from the deleted org's parent path,
 * hitting the first ancestor that is still a membership of the current user; if none hits, take any remaining org.
 * Returns null when no orgs remain — the caller must not log out based on this.
 */
export const pickFallbackOrg = <T extends PathedOrg>(
  deleted: { id: string; path?: string | null },
  remaining: readonly T[],
): T | null => {
  const others = remaining.filter((o) => o.id !== deleted.id);
  if (others.length === 0) return null;
  if (!deleted.path) return others[0] ?? null;
  let ancestorPath = parentPathOf(deleted.path);
  while (ancestorPath) {
    const hit = others.find((o) => !!o.path && normPath(o.path) === ancestorPath);
    if (hit) return hit;
    ancestorPath = parentPathOf(ancestorPath);
  }
  return others[0] ?? null;
};

export interface OrgRoleMembership {
  isManager?: boolean;
  path?: string | null;
}

/**
 * Effective manager along the ancestor chain (aligned with the backend isEffectiveManager):
 * row-level manager of the active org, or the path of any manager org is an ancestor of the active org.
 * The membership path set is derived locally, equivalent to JWT managerOrgPaths.
 */
export const isEffectiveManagerOf = (
  active: OrgRoleMembership | undefined,
  memberships: readonly OrgRoleMembership[],
): boolean => {
  if (!active) return false;
  if (active.isManager) return true;
  if (!active.path) return false;
  return memberships.some(
    (m) => m.isManager && !!m.path && isPathInSubtree(active.path!, m.path),
  );
};

/**
 * Target org authorization (aligned with the backend isManagerOfOrg): targetOrgPath falls inside the subtree of any manager org's path.
 * An empty path counts as unreachable.
 */
export const isManagerOfOrgPath = (
  memberships: readonly OrgRoleMembership[],
  targetOrgPath: string | null | undefined,
): boolean => {
  if (!targetOrgPath) return false;
  return memberships.some(
    (m) => m.isManager && !!m.path && isPathInSubtree(targetOrgPath, m.path),
  );
};
