/**
 * 缓存 key 集中管理;避免散落拼接。
 * 命名规则:`{domain}:{entity}[:{scope}[:{id}]]`,冒号分隔便于 SCAN 过滤。
 */

export function meKey(userId: string, tokenVersion: number): string {
  return `me:${userId}:tv${tokenVersion}`;
}

export function membershipsKey(userId: string): string {
  return `memberships:${userId}`;
}

export function tokenVersionKey(userId: string): string {
  return `auth:tokenVersion:${userId}`;
}

export function orgPathKey(orgId: string): string {
  return `org:path:${orgId}`;
}

export function subtreeKey(orgPath: string): string {
  return `org:subtree:${encodeURIComponent(orgPath)}`;
}

export function settingsAllKey(): string {
  return 'settings:all';
}

export function settingKey(key: string): string {
  return `settings:${key}`;
}

export function tagsKey(orgId: string): string {
  return `tags:${orgId}`;
}

/** scenario 缓存以项目为粒度(同项目多 requirement 共享)。 */
export function scenariosForProjectKey(projectId: string): string {
  return `scenarios:project:${projectId}`;
}

/** scenario 缓存按 requirement 粒度(GET /requirements/:rid/scenarios 用)。 */
export function scenariosForRequirementKey(requirementId: string): string {
  return `scenarios:requirement:${requirementId}`;
}

/** 计划运行详情(仅终态缓存;running 实时组装)。rca 落库/运行删除时须显式失效。 */
export function planRunDetailKey(runId: string): string {
  return `planrun:detail:${runId}`;
}