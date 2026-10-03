/**
 * iTest 前端的组织物化路径工具（与后端 services/orgTree.ts / org-path.ts 同源）。
 * 仅做前端派生计算：子树判定、深度、排序、回退组织选择等。后端仍以
 * path 字段为唯一真相，前端不能依赖本模块做权威判定。
 */

export interface PathedOrg {
  id: string;
  path?: string | null;
}

/** 物化路径深度：/a/ → 1，/a/b/ → 2；空 path 兜底为 0。 */
export const orgDepth = (path?: string | null): number =>
  path ? path.split('/').filter(Boolean).length : 0;

/** 由物化路径推出直接父节点的路径：'/a/b/c/' → '/a/b/'；顶级节点返回 null。 */
export const parentPathOf = (path: string): string | null => {
  const segs = path.split('/').filter(Boolean);
  if (segs.length <= 1) return null;
  return `/${segs.slice(0, -1).join('/')}/`;
};

/** 按物化路径排序形成树形（父前子后），返回新数组；无 path 兜底排最前。 */
export const sortByPath = <T extends PathedOrg>(orgs: readonly T[]): T[] =>
  [...orgs].sort((a, b) => (a.path || '').localeCompare(b.path || ''));

/** candidate 是否位于 ancestor 子树内（含自身）；与后端 isPathInSubtree 同源。 */
export const isPathInSubtree = (candidatePath: string, ancestorPath: string): boolean => {
  const cand = candidatePath.endsWith('/') ? candidatePath : candidatePath + '/';
  const anc = ancestorPath.endsWith('/') ? ancestorPath : ancestorPath + '/';
  return cand === anc || cand.startsWith(anc);
};

const normPath = (p: string): string => (p.endsWith('/') ? p : `${p}/`);

/**
 * 组织被删除后挑选接替的激活组织：从被删组织的父路径逐级上溯，命中第一个仍是
 * 本人成员关系的祖先；都不命中则取任一剩余组织。
 * 无剩余组织时返回 null —— 调用方不得据此登出。
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
 * 祖先链有效 manager（与后端 isEffectiveManager 对齐）：
 * 激活组织行级 manager，或任一 manager 组织的 path 是激活组织的祖先。
 * membership path 集合本地推导，等价于 JWT managerOrgPaths。
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
 * 目标组织授权（与后端 isManagerOfOrg 对齐）：targetOrgPath 落在任一 manager 组织 path 的子树内。
 * 空 path 视为不可达。
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
