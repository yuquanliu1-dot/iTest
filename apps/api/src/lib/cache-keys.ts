/**
 * Centralized cache key management; avoids scattered concatenation.
 * Naming rule: `{domain}:{entity}[:{scope}[:{id}]]`; colons separate segments for easy SCAN filtering.
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

/** scenario cache at project granularity (multiple requirements in the same project share it). */
export function scenariosForProjectKey(projectId: string): string {
  return `scenarios:project:${projectId}`;
}

/** scenario cache at requirement granularity (used by GET /requirements/:rid/scenarios). */
export function scenariosForRequirementKey(requirementId: string): string {
  return `scenarios:requirement:${requirementId}`;
}

/** Plan run detail (only final states cached; running is assembled live). Must be explicitly invalidated when an rca is persisted / the run is deleted. */
export function planRunDetailKey(runId: string): string {
  return `planrun:detail:${runId}`;
}

/** Case list at project granularity (the GET /cases?projectId= branch). Case/step write paths must invalidate explicitly. */
export function casesForProjectKey(projectId: string): string {
  return `cases:project:${projectId}`;
}

/** Dashboard aggregation (window range=7d|30d). TTL-only, no write invalidation; dashboard tolerates 60s staleness. */
export function overviewKey(projectId: string, range: string): string {
  return `overview:${projectId}:${range}`;
}