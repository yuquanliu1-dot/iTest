const BASE = '/api';

/** Request error carrying the HTTP status code; callers can use it to distinguish deterministic failures such as 404 (not found / not visible). */
export class ApiError extends Error {
  status: number;
  /** Stable backend error code (HttpError.code in errorHandler / validation and conflict fallback codes). undefined when no code. */
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Only joins params that carry a value: undefined / empty string / false are always skipped.
 *  An empty q would be treated by the backend as "searching for an empty string"; false is skipped too because the backend uniformly uses
 *  `=== 'true'` to decide boolean params, so omitting is equivalent to false. */
export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// Exempt paths that skip the login redirect on 401 (login / first-login password change themselves, /me probing — these 401s are handled by the caller)
const AUTH_EXEMPT_PATHS = new Set(['/auth/login', '/auth/change-password', '/auth/me']);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    if (res.status === 401 && !AUTH_EXEMPT_PATHS.has(path)) {
      // Session expired: full-page redirect to login (no authStore import to avoid a circular dependency)
      window.location.assign('/login');
    }
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.message ?? `HTTP ${res.status}`, typeof body?.error === 'string' ? body.error : undefined);
  }
  // 204 No Content: DELETE and other empty responses return undefined directly; no JSON parsing attempted.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<{ ok: boolean }>('/health'),
  settings: {
    list: () => request<Record<string, unknown>>('/settings'),
    put: (key: string, value: unknown) =>
      request<{ key: string; value: unknown }>('/settings', {
        method: 'PUT',
        body: JSON.stringify({ key, value }),
      }),
    llm: () => request<LlmSettingsView>('/settings/llm'),
    putLlm: (body: LlmSettingsPut) =>
      request<{ ok: boolean }>('/settings/llm', { method: 'PUT', body: JSON.stringify(body) }),
    testConnection: (body: { channelId?: string; provider: string; apiKey?: string; model?: string; baseUrl?: string }) =>
      request<LlmTestResult>('/settings/llm/test', { method: 'POST', body: JSON.stringify(body) }),
  },
  projects: {
    list: () => request<ProjectWithCount[]>('/projects'),
    create: (body: { name: string; productLineId: string }) =>
      request<Project>('/projects', { method: 'POST', body: JSON.stringify(body) }),
    patch: (id: string, body: Partial<{ name: string }>) =>
      request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
    get: (id: string) => request<Project>(`/projects/${id}`),
    verifyRepo: (body: {
      repoUrl: string;
      provider?: 'github' | 'gitee' | 'gitlab';
      patOverride?: string;
      branch?: string;
      projectId?: string;
    }) => request<VerifyRepoResult>(`/projects/verify-repo`, { method: 'POST', body: JSON.stringify(body) }),
    assignments: (id: string, params?: { q?: string; page?: number; limit?: number }) =>
      request<Paged<AssignedUser>>(`/projects/${id}/assignments${qs(params ?? {})}`),
    assignUsers: (id: string, userIds: string[]) =>
      request<{ id: string; projectId: string; userId: string }[]>(`/projects/${id}/assignments`, {
        method: 'POST',
        body: JSON.stringify({ userIds }),
      }),
    unassignUser: (id: string, userId: string) =>
      request<void>(`/projects/${id}/assignments/${userId}`, { method: 'DELETE' }),
    /** versionIds = the set of versions in the current scope (pass [versionId] in current-version scope, selected versions in product-line scope); group counts narrow accordingly. */
    groups: (id: string, versionIds: string[] = []) =>
      request<GroupWithCount[]>(
        `/projects/${id}/groups${versionIds.length ? `?versionIds=${versionIds.join(',')}` : ''}`,
      ),
    /** All groups under a product line (used to filter the cross-project case pool by group; one request covers all projects in the line). */
    groupsByProductLine: (productLineId: string) => request<GroupWithCount[]>(`/product-lines/${productLineId}/groups`),
    versionsByProductLine: (productLineId: string) => request<ProjectVersion[]>(`/product-lines/${productLineId}/versions`),
    createGroup: (id: string, body: { name: string }) =>
      request<Group>(`/projects/${id}/groups`, { method: 'POST', body: JSON.stringify(body) }),
    stats: (id: string) => request<ProjectStats>(`/projects/${id}/stats`),
    overview: (id: string, range: '7d' | '30d' = '7d') =>
      request<import('../features/overview/api').OverviewResponse>(
        `/projects/${id}/overview?range=${range}`,
      ),
    plans: (id: string) => request<PlanWithCount[]>(`/projects/${id}/plans`),
    createPlan: (id: string, body: { name: string; versionId?: string }) =>
      request<ExecutionPlan>(`/projects/${id}/plans`, { method: 'POST', body: JSON.stringify(body) }),
  },
  groups: {
    patch: (id: string, body: Partial<{ name: string }>) =>
      request<Group>(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/groups/${id}`, { method: 'DELETE' }),
  },
  productLines: {
    list: () => request<ProductLine[]>('/product-lines'),
    create: (body: { name: string; description?: string; organizationId?: string }) =>
      request<ProductLine>('/product-lines', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<ProductLineDetail>(`/product-lines/${id}`),
    patch: (id: string, body: Partial<{ name: string; description: string }>) =>
      request<ProductLine>(`/product-lines/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/product-lines/${id}`, { method: 'DELETE' }),
    projects: (id: string) => request<{ id: string; name: string; description: string | null }[]>(
      `/product-lines/${id}/projects`,
    ),
    attachProjects: (id: string, projectIds: string[]) =>
      request<{ ok: boolean; count: number }>(`/product-lines/${id}/projects`, {
        method: 'POST',
        body: JSON.stringify({ projectIds }),
      }),
    /** Move a product line to another organization: all projects in the line switch organization along with it, and labels are migrated too. */
    move: (id: string, organizationId: string) =>
      request<{ ok: boolean; projectCount: number }>(`/product-lines/${id}/move`, {
        method: 'POST',
        body: JSON.stringify({ organizationId }),
      }),
  },
  plans: {
    get: (id: string) => request<PlanDetail>(`/plans/${id}`),
    patch: (
      id: string,
      body: Partial<{
        name: string;
        strategy: 'run_all' | 'fail_fast';
        rcaEnabled: boolean;
      }>,
    ) => request<ExecutionPlan>(`/plans/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/plans/${id}`, { method: 'DELETE' }),
    removeBatch: (planIds: string[]) =>
      request<{ count: number }>(`/plans/batch-delete`, { method: 'POST', body: JSON.stringify({ planIds }) }),
    createGroup: (id: string, body: { name: string; environmentId?: string | null; failFast?: boolean }) =>
      request<PlanCaseGroup>(`/plans/${id}/groups`, { method: 'POST', body: JSON.stringify(body) }),
    patchGroup: (id: string, groupId: string, body: Partial<{ name: string; environmentId: string | null; failFast: boolean; loginPrepare: { enabled: boolean; caseId: string | null; detectionUrl: string | null; successSelector: string | null; unauthorizedKeywords: string[] | null; datasetRowIndexes: number[] | null }; targetConfig: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null }>) =>
      request<PlanCaseGroup>(`/plans/${id}/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteGroup: (id: string, groupId: string) =>
      request<{ ok: boolean }>(`/plans/${id}/groups/${groupId}`, { method: 'DELETE' }),
    reorderGroups: (id: string, groupIds: string[]) =>
      request<{ ok: boolean }>(`/plans/${id}/groups/order`, { method: 'PUT', body: JSON.stringify({ groupIds }) }),
    setGroupCases: (id: string, groupId: string, caseIds: string[]) =>
      request<{ ok: boolean }>(`/plans/${id}/groups/${groupId}/cases`, { method: 'PUT', body: JSON.stringify({ caseIds }) }),
    addCases: (id: string, caseIds: string[], groupId?: string) =>
      request<{ added: number }>(`/plans/${id}/cases`, { method: 'POST', body: JSON.stringify({ caseIds, groupId }) }),
    reorderGroupCases: (id: string, groupId: string, caseIds: string[]) =>
      request<{ ok: boolean }>(`/plans/${id}/cases/order`, { method: 'PUT', body: JSON.stringify({ groupId, caseIds }) }),
    moveCases: (id: string, planCaseIds: string[], toGroupId: string) =>
      request<{ ok: boolean }>(`/plans/${id}/cases/move`, { method: 'PUT', body: JSON.stringify({ planCaseIds, toGroupId }) }),
    /** Plan-level dataset row selection (located by plan_cases.id; duplicate cases across groups have independent rows):
     *  null = follow case-level; [] = all enabled rows; non-empty = subset. */
    patchPlanCase: (id: string, planCaseId: string, body: { datasetRowIndexes: number[] | null }) =>
      request<{ ok: boolean; datasetRowIndexes: number[] | null }>(`/plans/${id}/plan-cases/${planCaseId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    removeCases: (id: string, caseIds: string[]) =>
      request<{ ok: boolean }>(`/plans/${id}/cases`, {
        method: 'DELETE',
        body: JSON.stringify({ caseIds }),
      }),
    loginCases: (id: string, q?: string) =>
      request<Array<{ id: string; title: string; groupId: string }>>(
        `/plans/${id}/login-cases${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      ),
    run: (id: string) =>
      request<{ runId: string }>(`/plans/${id}/run`, { method: 'POST' }),
  },
  planRuns: {
    get: (id: string) => request<PlanRunDetail>(`/plan-runs/${id}`),
    cancel: (id: string) => request<{ ok: boolean }>(`/plan-runs/${id}/cancel`, { method: 'POST' }),
    liveUrl: (id: string) => `${BASE}/plan-runs/${id}/live`,
    replayUrl: (id: string, speed?: number) =>
      speed && speed !== 1 ? `${BASE}/plan-runs/${id}/live?replay=1&speed=${speed}` : `${BASE}/plan-runs/${id}/live?replay=1`,
    replayMetaUrl: (id: string) => `${BASE}/plan-runs/${id}/live?replay=meta`,
    remove: (id: string) => request<{ ok: boolean }>(`/plan-runs/${id}`, { method: 'DELETE' }),
    removeBatch: (ids: string[]) =>
      request<{ count: number }>('/plan-runs/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ planRunIds: ids }),
      }),
  },
  explorations: {
    list: (params: { versionId?: string; projectId?: string; page?: number; limit?: number }) =>
      request<Paged<ExplorationSession>>(`/explorations${qs(params)}`),
    create: (body: {
      versionId: string;
      charter: string;
      persona?: string;
      title?: string;
      startUrl?: string;
      allowDestructive?: boolean;
      allowFaultInjection?: boolean;
      windowWidth?: number;
      windowHeight?: number;
      budgetTurns?: number;
    }) => request<ExplorationSession>('/explorations', { method: 'POST', body: JSON.stringify(body) }),
    /** Persona matrix grouping (C3): N persona sessions run in parallel from one charter (grouped by the same matrix_id). */
    createMatrix: (body: {
      versionId: string;
      charter: string;
      personas: string[];
      label?: string;
      title?: string;
      startUrl?: string;
      allowDestructive?: boolean;
      allowFaultInjection?: boolean;
      windowWidth?: number;
      windowHeight?: number;
      budgetTurns?: number;
    }) => request<ExplorationMatrix>('/explorations/matrix', { method: 'POST', body: JSON.stringify(body) }),
    getMatrix: (matrixId: string) => request<ExplorationMatrix>(`/explorations/matrix/${matrixId}`),
    cancelMatrix: (matrixId: string) =>
      request<{ ok: boolean; cancelled: number }>(`/explorations/matrix/${matrixId}/cancel`, { method: 'POST' }),
    get: (id: string) => request<ExplorationSession>(`/explorations/${id}`),
    cancel: (id: string) => request<{ ok: boolean }>(`/explorations/${id}/cancel`, { method: 'POST' }),
    remove: (id: string) => request<{ ok: boolean }>(`/explorations/${id}`, { method: 'DELETE' }),
    review: (sessionId: string, findingId: string, decision: 'confirmed' | 'dismissed') =>
      request<ExplorationFinding>(`/explorations/${sessionId}/findings/${findingId}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      }),
    promote: (sessionId: string, findingId: string, body: { groupId: string; title?: string; priority?: string }) =>
      request<{ caseId: string; findingId: string }>(`/explorations/${sessionId}/findings/${findingId}/promote`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    liveUrl: (id: string) => `${BASE}/explorations/${id}/live`,
    replayUrl: (id: string, speed?: number) =>
      speed && speed !== 1 ? `${BASE}/explorations/${id}/live?replay=1&speed=${speed}` : `${BASE}/explorations/${id}/live?replay=1`,
    replayMetaUrl: (id: string) => `${BASE}/explorations/${id}/live?replay=meta`,
  },
  planSchedules: {
    list: (planId: string) => request<PlanSchedule[]>(`/plans/${planId}/schedules`),
    create: (planId: string, body: PlanScheduleCreateInput) =>
      request<PlanSchedule>(`/plans/${planId}/schedules`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    patch: (id: string, body: PlanSchedulePatchInput) =>
      request<PlanSchedule>(`/plan-schedules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    remove: (id: string) => request<{ ok: boolean }>(`/plan-schedules/${id}`, { method: 'DELETE' }),
    enable: (id: string) =>
      request<PlanSchedule>(`/plan-schedules/${id}/enable`, { method: 'POST' }),
    disable: (id: string) =>
      request<PlanSchedule>(`/plan-schedules/${id}/disable`, { method: 'POST' }),
  },
  versions: {
    list: (projectId: string) =>
      request<ProjectVersion[]>(`/projects/${projectId}/versions`),
    create: (projectId: string, body: { name: string; description?: string; environmentId?: string | null }) =>
      request<ProjectVersion>(`/projects/${projectId}/versions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    patch: (id: string, body: Partial<{ name: string; description: string | null; environmentId: string | null }>) =>
      request<ProjectVersion>(`/project-versions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (projectId: string, id: string) =>
      request<void>(`/projects/${projectId}/versions/${id}`, { method: 'DELETE' }),
    listRefs: (projectId: string, kind: 'branch' | 'tag') =>
      request<{ kind: 'branch' | 'tag'; refs: string[]; error?: string }>(
        `/projects/${projectId}/refs?kind=${kind}`,
      ),
    /** Check whether a remote branch/tag exists (the "Test" action in the ref dialog). When valid=false, error gives the reason. */
    verifyRef: (projectId: string, body: { ref: string; kind: 'branch' | 'tag' }) =>
      request<{ valid: boolean; error?: string }>(`/projects/${projectId}/verify-ref`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    /** Write ref/refKind (kept separate from patch to avoid accidentally changing name/description). */
    setRef: (id: string, body: { ref: string | null; refKind: 'branch' | 'tag' | null }) =>
      request<ProjectVersion>(`/project-versions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ref: body.ref, refKind: body.refKind }),
      }),
  },
  environments: {
    list: (projectId: string) => request<Environment[]>(`/projects/${projectId}/environments`),
    create: (
      projectId: string,
      body: {
        name: string;
        objects?: Array<{ objectType: 'db' | 'syslog' | 'web'; label?: string; payload: Record<string, unknown>; isDefault?: boolean }>;
      },
    ) =>
      request<Environment>(`/projects/${projectId}/environments`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    patch: (id: string, body: Partial<{ name: string; isDefault: boolean }>) =>
      request<Environment>(`/environments/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string, opts?: { confirm?: boolean }) =>
      request<{ ok: boolean; requiresConfirm?: boolean; caseCount?: number; planCount?: number }>(
        `/environments/${id}${opts?.confirm ? '?confirm=true' : ''}`,
        { method: 'DELETE' },
      ),
    createObject: (
      envId: string,
      body: { objectType: 'db' | 'syslog' | 'web'; label?: string; payload: Record<string, unknown>; isDefault?: boolean },
    ) =>
      request<EnvironmentObject>(`/environments/${envId}/objects`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    patchObject: (id: string, body: Partial<{ label: string; payload: Record<string, unknown> }>) =>
      request<EnvironmentObject>(`/environment-objects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    removeObject: (id: string) =>
      request<{ ok: boolean }>(`/environment-objects/${id}`, { method: 'DELETE' }),
    testDb: (body: { objectId?: string; dbType?: 'postgres' | 'mysql' | 'gauss100'; host: string; port?: number; dbName: string; user: string; password?: string }) =>
      request<{ ok: boolean; latencyMs?: number; error?: string }>('/environments/test-db', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    testSyslog: (body: { objectId?: string; host: string; sshPort?: number; user: string; filePath: string; authType: 'key' | 'password'; privateKey?: string; password?: string }) =>
      request<{ ok: boolean; latencyMs?: number; error?: string }>('/environments/test-syslog', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
  datasets: {
    list: (projectId: string) => request<DatasetSummary[]>(`/projects/${projectId}/datasets`),
    get: (projectId: string, id: string) => request<DatasetDetail>(`/projects/${projectId}/datasets/${id}`),
    create: (projectId: string, body: DatasetSaveBody) =>
      request<DatasetDetail>(`/projects/${projectId}/datasets`, { method: 'POST', body: JSON.stringify(body) }),
    update: (projectId: string, id: string, body: DatasetSaveBody) =>
      request<DatasetDetail>(`/projects/${projectId}/datasets/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    remove: (projectId: string, id: string, opts?: { confirm?: boolean }) =>
      request<{ ok: boolean; requiresConfirm?: boolean; caseCount?: number }>(
        `/projects/${projectId}/datasets/${id}${opts?.confirm ? '?confirm=true' : ''}`,
        { method: 'DELETE' },
      ),
    /** Download the import template (fetch → blob, like downloadExtensionZip no JSON parsing; the caller persists it via a[download]).
     *  columns: pass the current column names when editing an existing dataset so the template header matches the dataset's current columns. */
    downloadTemplate: async (projectId: string, columns?: string[]): Promise<Blob> => {
      const q = columns && columns.length > 0 ? `?columns=${encodeURIComponent(columns.join(','))}` : '';
      const r = await fetch(`${BASE}/projects/${projectId}/datasets/template${q}`, { credentials: 'same-origin' });
      if (!r.ok) {
        if (r.status === 401) throw new ApiError(401, '未登录或会话已过期');
        const body = await r.json().catch(() => ({}));
        throw new ApiError(r.status, body.message ?? `HTTP ${r.status}`);
      }
      return r.blob();
    },
    /** Upload an xlsx and parse it into a draft payload (octet-stream, same as attachments.upload). Parse only; nothing persisted. */
    importFile: async (projectId: string, file: File): Promise<DatasetImportPayload> => {
      const buf = await file.arrayBuffer();
      const r = await fetch(`${BASE}/projects/${projectId}/datasets/import-parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
        body: buf,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { message?: string; code?: string };
        throw new ApiError(r.status, body.message ?? `HTTP ${r.status}`, body.code);
      }
      return r.json() as Promise<DatasetImportPayload>;
    },
  },
  executions: {
    list: (params?: {
      projectId?: string;
      /** Product-line execution library: pull case reports + plan runs across the whole line's projects (choose one of this or projectId) */
      productLineId?: string;
      kind?: 'case' | 'plan' | 'all';
      statuses?: string[];
      versionIds?: string[];
      q?: string;
      /** Single-case deep link: only this case's execution reports */
      caseId?: string;
      /** Single-plan deep link: only this plan's run history */
      planId?: string;
    }) => {
      const qs = new URLSearchParams();
      if (params?.projectId) qs.set('projectId', params.projectId);
      if (params?.productLineId) qs.set('productLineId', params.productLineId);
      if (params?.kind) qs.set('kind', params.kind);
      if (params?.statuses?.length) qs.set('statuses', params.statuses.join(','));
      if (params?.versionIds?.length) qs.set('versionIds', params.versionIds.join(','));
      if (params?.q?.trim()) qs.set('q', params.q.trim());
      if (params?.caseId) qs.set('caseId', params.caseId);
      if (params?.planId) qs.set('planId', params.planId);
      const s = qs.toString();
      return request<ExecutionEntry[]>(`/executions${s ? `?${s}` : ''}`);
    },
  },
  cases: {
    list: (params?: string | { priority?: string; groupId?: string; projectId?: string; productLineId?: string; scenarioId?: string; versionIds?: string[]; solidified?: string }) => {
      const p = typeof params === 'string' ? { priority: params } : params;
      const qs = new URLSearchParams();
      if (p?.priority) qs.set('priority', p.priority);
      if (p?.groupId) qs.set('groupId', p.groupId);
      if (p?.projectId) qs.set('projectId', p.projectId);
      if (p?.productLineId) qs.set('productLineId', p.productLineId);
      if (p?.scenarioId) qs.set('scenarioId', p.scenarioId);
      if (p?.versionIds?.length) qs.set('versionIds', p.versionIds.join(','));
      if (p?.solidified) qs.set('solidified', p.solidified);
      const s = qs.toString();
      return request<TestCase[]>(`/cases${s ? `?${s}` : ''}`);
    },
    create: (body: {
      title: string;
      priority?: string;
      requirementId?: string;
      groupId: string;
      versionId?: string;
      url?: string;
      description?: string;
    }) => request<TestCase>('/cases', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<TestCaseDetail>(`/cases/${id}`),
    patch: (
      id: string,
      body: Partial<{
        title: string;
        priority: string;
        description: string | null;
        groupId: string;
        url: string | null;
        windowStrategy: string;
        windowWidth: number;
        windowHeight: number;
        incognito: boolean;
        scenarioId: string | null;
        status: CaseStatus;
        tagIds: string[];
        defaultEnvId: string | null;
        webServiceRef: string | null;
        datasetId: string | null;
        /** Dataset row selection: array of enabled-row indexes. [] = all enabled rows; null = clear the selection. */
        datasetRowIndexes?: number[] | null;
        /** Requirement number (free-text external number). Empty string is converted to null by the caller. */
        requirementNo: string | null;
        /** Track 1: case-level expected outcome description. Empty string is converted to null by the caller. */
        expectedOutcome: string | null;
      }>,
    ) => request<TestCase>(`/cases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/cases/${id}`, { method: 'DELETE' }),
    removeBatch: (caseIds: string[]) =>
      request<{ count: number }>('/cases/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ caseIds }),
      }),
    /** Batch server-side solidification (all unsolidified cases NL→DSL + mechanical acceptance). All rejected → 422 {batchId:null, rejected};
     *  partially rejected → 200 + rejected list (frontend toast). */
    batchSolidify: (caseIds: string[]) =>
      request<{ batchId: string | null; accepted: string[]; rejected: Array<{ caseId: string; reason: string }> }>(
        '/cases/batch-solidify',
        { method: 'POST', body: JSON.stringify({ caseIds }) },
      ),
    /** Batch solidification progress polling (row statuses + read-time derived batch summary). */
    solidifyBatch: (id: string) => request<SolidifyBatchStatus>(`/cases/solidify-batches/${id}`),
    /** In-flight batch list (data source for the top banner on the groups page and inline "solidifying" badges). */
    solidifyBatches: (projectId?: string) =>
      request<SolidifyBatchesOverview>(`/cases/solidify-batches${projectId ? `?projectId=${projectId}` : ''}`),
    updateStatusBatch: (caseIds: string[], status: CaseStatus) =>
      request<{ count: number }>('/cases/batch-status', {
        method: 'POST',
        body: JSON.stringify({ caseIds, status }),
      }),
    copy: (id: string, targetGroupId: string, targetVersionId?: string) =>
      request<TestCase>(`/cases/${id}/copy`, { method: 'POST', body: JSON.stringify({ targetGroupId, targetVersionId }) }),
    copyBatch: (caseIds: string[], targetGroupId: string, targetVersionId?: string) =>
      request<{ count: number }>('/cases/copy', {
        method: 'POST',
        body: JSON.stringify({ caseIds, targetGroupId, targetVersionId }),
      }),
    appendSteps: (id: string, steps: Array<{ order: number; source: string; action: unknown; instruction?: string; compiled?: unknown[] }>) =>
      request<{ count: number; steps: TestStep[]; failedAi: number; variableReport?: VariableReport }>(
        `/cases/${id}/steps`,
        {
          method: 'POST',
          body: JSON.stringify({ steps }),
        },
      ),
    reorderSteps: (id: string, stepIds: string[]) =>
      request<{ steps: TestStep[] }>(`/cases/${id}/steps/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ stepIds }),
      }),
    deleteStep: (id: string, stepId: string) =>
      request<{ ok: boolean }>(`/cases/${id}/steps/${stepId}`, { method: 'DELETE' }),
    replaceSteps: (
      id: string,
      steps: Array<{ action: unknown; source: string; delayMs?: number; instruction?: string; compiled?: unknown[] }>,
    ) =>
      request<{ steps: TestStep[]; failedAi: number; variableReport?: VariableReport }>(`/cases/${id}/steps`, {
        method: 'PUT',
        body: JSON.stringify({ steps }),
      }),
    /** Compile a natural-language instruction into StepAction[] DSL.
     *  Returning { compiled: null, error } means give-up/failure; the UI should let the user rewrite the instruction.
     *  Single lightweight LLM call, only for extracting aiTask sub-steps (minimal scenarios where inspection is awkward). */
    compileExtract: (caseId: string, body: { description: string; sampleText: string }) =>
      request<{ pattern: string | null; group: number; error?: string }>(
        `/cases/${caseId}/steps/extract/compile`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    execute: (id: string) =>
      request<{ reportId: string; reportIds?: string[] }>(`/cases/${id}/execute`, { method: 'POST' }),
    liveUrl: (id: string) => `/api/cases/${id}/live`,
    replayUrl: (id: string, speed?: number) =>
      speed && speed !== 1 ? `/api/cases/${id}/live?replay=1&speed=${speed}` : `/api/cases/${id}/live?replay=1`,
    replayMetaUrl: (id: string) => `/api/cases/${id}/live?replay=meta`,
  },
  tags: {
    list: (projectId: string) => request<Tag[]>(`/projects/${projectId}/tags`),
    create: (projectId: string, body: { name: string; color: string; description?: string | null }) =>
      request<Tag>(`/projects/${projectId}/tags`, { method: 'POST', body: JSON.stringify(body) }),
    update: (projectId: string, tagId: string, body: { name?: string; color?: string; description?: string | null }) =>
      request<Tag>(`/projects/${projectId}/tags/${tagId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (projectId: string, tagId: string) =>
      request<{ ok: boolean }>(`/projects/${projectId}/tags/${tagId}`, { method: 'DELETE' }),
  },
  reports: {
    list: (projectId?: string) =>
      request<Report[]>(`/reports${projectId ? `?projectId=${projectId}` : ''}`),
    get: (id: string) => request<Report>(`/reports/${id}`),
    datasetBatch: (id: string) => request<DatasetBatch>(`/reports/${id}/dataset-batch`),
    remove: (id: string) => request<{ ok: boolean }>(`/reports/${id}`, { method: 'DELETE' }),
    removeBatch: (ids: string[]) =>
      request<{ count: number }>('/reports/batch-delete', { method: 'POST', body: JSON.stringify({ reportIds: ids }) }),
  },
  recorder: {
    createSession: (
      caseId: string,
      opts?: { mode?: 'fresh' | 'append' | 'resume' | 'incognito'; incognito?: boolean; resumeFromOrder?: number; targetUrl?: string },
    ) =>
      request<{ sessionId: string; wsUrl: string; wsToken: string; resolvedUrl: string | null; mode: string }>(
        '/recorder/sessions',
        { method: 'POST', body: JSON.stringify({ caseId, ...(opts ?? {}) }) },
      ),
    finish: (sessionId: string) =>
      request<{ inserted: number }>(`/recorder/sessions/${sessionId}/finish`, { method: 'POST' }),
    tabEvents: (
      sessionId: string,
      events: Array<{ kind: 'opened' | 'closed'; tabRef: string; title?: string; url?: string }>,
    ) =>
      request<{ count: number }>(`/recorder/sessions/${sessionId}/tab-events`, {
        method: 'POST',
        body: JSON.stringify({ events }),
      }),
    /** Currently deployed extension version: the badge compares it with the "installed version" to detect an available upgrade. */
    extensionVersion: () => request<{ version: string }>('/recorder/extension/version'),
  },
  attachments: {
    upload: async (caseId: string, file: File) => {
      const buf = await file.arrayBuffer();
      const r = await fetch(`${BASE}/cases/${caseId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name },
        body: buf,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<{ id: string; originalName: string; size: number; sha256: string }>;
    },
    list: (caseId: string) =>
      request<Array<{ id: string; originalName: string; size: number; mime: string | null; sha256: string; createdAt: string }>>(
        `/cases/${caseId}/attachments`,
      ),
  },
  assistantAttachments: {
    /** Assistant attachment pre-upload (version-scoped, .docx/.xlsx). X-Filename goes through encodeURIComponent: Chinese filenames
     *  set directly on Headers throw a ByteString error in some browsers (the legacy cases path doesn't handle it; leave old code alone, do it right here). */
    uploadAttachment: async (versionId: string, file: File) => {
      const buf = await file.arrayBuffer();
      const r = await fetch(`${BASE}/assistant/versions/${versionId}/attachments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: buf,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<{
        name: string;
        path: string;
        chars: number | null;
        size: number;
        sha256: string;
        deduped: boolean;
        extracted: boolean;
      }>;
    },
  },
  /** Browser-native download: fetch → blob → `<a download>`; no JSON parsing.
   *  Unlike request(): 401 does not auto-redirect to login (kept consistent with the original `<a>` behavior); the caller handles it as needed. */
  downloadExtensionZip: async (): Promise<Blob> => {
    const r = await fetch(`${BASE}/recorder/extension.zip`, { credentials: 'same-origin' });
    if (!r.ok) {
      if (r.status === 401) throw new ApiError(401, '未登录或会话已过期');
      const body = await r.json().catch(() => ({}));
      throw new ApiError(r.status, body.message ?? `HTTP ${r.status}`);
    }
    return r.blob();
  },
  /** AI artifact file download (artifact download card): fetch → blob; request<T> parses JSON, so binary goes through fetch separately. */
  downloadArtifact: async (threadId: string, token: string): Promise<{ blob: Blob; filename: string }> => {
    const r = await fetch(`${BASE}/assistant/threads/${threadId}/artifacts/${token}`, { credentials: 'same-origin' });
    if (!r.ok) {
      if (r.status === 401) throw new ApiError(401, '未登录或会话已过期');
      const body = await r.json().catch(() => ({}));
      throw new ApiError(r.status, body.message ?? `HTTP ${r.status}`);
    }
    const dispo = r.headers.get('Content-Disposition') ?? '';
    const m = dispo.match(/filename\*=UTF-8''([^;]+)/);
    const filename = m ? decodeURIComponent(m[1]!) : 'artifact';
    return { blob: await r.blob(), filename };
  },
  /** Persistent artifact list for a thread (skill-generated documents etc.). Fetched when switching threads to refill the download cards. */
  listArtifacts: (threadId: string) =>
    request<Array<{ token: string; name: string; mime: string; size: number; count: number | null; createdAt: string }>>(
      `/assistant/threads/${threadId}/artifacts`,
    ),
  auth: {
    login: (username: string, password: string) =>
      request<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    // First-login forced password change: success logs in automatically (same response as the login ok branch and plants the new cookie)
    changePassword: (passwordChangeToken: string, newPassword: string) =>
      request<Extract<LoginResponse, { status: 'ok' }>>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ passwordChangeToken, newPassword }),
      }),
    me: () => request<MeResponse>('/auth/me'),
    // Switch organization: the server re-issues the session cookie (new JWT carries the new org context)
    switchOrg: (organizationId: string) =>
      request<{ organization: { id: string; name: string }; isManager: boolean; isUser: boolean }>('/auth/switch-org', {
        method: 'POST',
        body: JSON.stringify({ organizationId }),
      }),
    logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
    updateMyPassword: (currentPassword: string, newPassword: string) =>
      request<{ status: string }>('/auth/me/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
  },
  orgs: {
    list: () => request<OrgSummary[]>('/organizations'),
    createSubOrg: (name: string, parentId: string) =>
      request<Organization>('/organizations', { method: 'POST', body: JSON.stringify({ name, parentId }) }),
    get: (id: string) => request<OrgDetail>('/organizations/${id}'.replace('${id}', id)),
    update: (id: string, body: { name?: string; description?: string }) =>
      request<OrgDetail>('/organizations/${id}'.replace('${id}', id), { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>('/organizations/${id}'.replace('${id}', id), { method: 'DELETE' }),
    managedSubtree: () =>
      request<OrgManagedNode[]>('/organizations/managed-subtree'),
    members: (
      orgId: string,
      params?: { q?: string; includeSubtree?: boolean; page?: number; limit?: number },
    ) => request<Paged<OrgMemberRow>>(`/organizations/${orgId}/members${qs(params ?? {})}`),
    productLines: (
      orgId: string,
      params?: { q?: string; includeSubtree?: boolean; page?: number; limit?: number },
    ) => request<Paged<OrgProductLineSummary>>(`/organizations/${orgId}/product-lines${qs(params ?? {})}`),
    addMember: (orgId: string, body: { username: string; isManager?: boolean; isUser?: boolean }) =>
      request<{ ok: boolean }>(`/organizations/${orgId}/members`, { method: 'POST', body: JSON.stringify(body) }),
    updateMember: (orgId: string, userId: string, body: { isManager?: boolean; isUser?: boolean }) =>
      request<{ ok: boolean }>(`/organizations/${orgId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    removeMember: (orgId: string, userId: string) =>
      request<{ ok: boolean }>(`/organizations/${orgId}/members/${userId}`, { method: 'DELETE' }),
    lookupUser: (username: string) =>
      request<{ id: string; username: string; displayName: string }>(
        `/organizations/lookup-user?username=${encodeURIComponent(username)}`,
      ),
  },
  users: {
    list: (params?: { q?: string; orgId?: string; includeSubtree?: boolean; excludeOrgId?: string; page?: number; limit?: number }) =>
      request<Paged<UserSummary>>(`/users${qs(params ?? {})}`),
    get: (id: string) => request<UserDetail>(`/users/${id}`),
    getProjects: (id: string, params?: { page?: number; limit?: number }) =>
      request<Paged<UserProjectSummary>>(`/users/${id}/projects${qs(params ?? {})}`),
    update: (
      id: string,
      patch: { displayName?: string; email?: string | null; languagePreference?: 'zh-CN' | 'en-US' },
    ) => request<UserDetail>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: string) => request<void>(`/users/${id}`, { method: 'DELETE' }),
    resetPassword: (id: string) =>
      request<{ temporaryPassword: string }>(`/users/${id}/reset-password`, { method: 'POST' }),
    create: (body: {
      username: string;
      displayName: string;
      email?: string;
      organizationId: string;
    }) =>
      request<{ temporaryPassword: string; user: UserSummary }>(`/auth/register-admin`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
  assistant: {
    /** Thread list (paged): the backend keysets in total order by (updatedAt,id) and filters out draft rows without a session file,
     *  and cursor passes back the last thread id of the previous page. Both the left-rail grouping and the react-pi runtime list use this.
     *  workspacePath ≡ versionId (see the Props comment in SpaceWorkspace). */
    listThreadsPaged: (
      versionId: string,
      opts: { limit: number; cursor?: string },
    ): Promise<{
      threads: { id: string; title: string | null; status: string; createdAt?: string; updatedAt?: string }[];
      hasMore: boolean;
    }> =>
      request(`/assistant/threads${qs({ workspacePath: versionId, limit: opts.limit, cursor: opts.cursor })}`),
    confirm: (threadId: string, confirmId: string, approved: boolean) =>
      request<void>(`/assistant/threads/${threadId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ confirmId, approved }),
      }),
    /** Suggested follow-ups: fetched on demand after an AI answer settles (POST triggers one lightweight LLM call, returns an array of prompt strings). */
    suggestions: (threadId: string) =>
      request<string[]>(`/assistant/threads/${threadId}/suggestions`, { method: 'POST' }),
    /** Version-space assistant "stage → persist" */
    stage: {
      list: (threadId: string) =>
        request<StageDoc>(`/assistant/threads/${threadId}/stage/list`, { method: 'POST' }),
      save: (threadId: string, body: StageSaveBody) =>
        request<{
          savedCases: number;
          savedScenarios: number;
          savedEnvironments: number;
          savedPlans: number;
          savedCaseOps: number;
          savedDatasets: number;
          caseIdMap: Record<string, string>;
          datasetIdMap: Record<string, string>;
        }>(`/assistant/threads/${threadId}/stage/save`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
    },
    /** User feedback on AI replies (Phase 1 only collects). messageExcerpt is the only reliable key for tracing back,
     *  messageAnchor is just a positional index hint that drifts with streaming — don't treat anchor as the primary key when consuming feedback. */
    feedback: {
      create: (body: {
        threadId: string;
        sentiment: 'positive' | 'negative';
        comment?: string;
        messageAnchor?: string;
        messageIndex?: number;
        messageExcerpt?: string;
        messageAt?: string;
      }) =>
        request<void>('/assistant/feedback', { method: 'POST', body: JSON.stringify(body) }),
      /** Feedback the current user has already submitted under this thread, used for the "submitted" marker on bubbles. */
      mine: (threadId: string) =>
        request<Array<{
          id: string;
          messageAnchor: string | null;
          messageIndex: number | null;
          sentiment: 'positive' | 'negative';
          createdAt?: string;
        }>>(`/assistant/feedback${qs({ threadId })}`),
      /** Admin full list (requireManager). messageExcerpt is the only reliable key for tracing back. */
      listAll: (params: { sentiment?: string; projectId?: string; limit?: number; offset?: number }) =>
        request<{
          total: number;
          rows: Array<{
            id: string;
            threadId: string;
            versionId: string;
            projectId: string;
            sentiment: 'positive' | 'negative';
            messageExcerpt: string | null;
            comment: string | null;
            authorName: string | null;
            createdAt?: string;
          }>;
        }>(`/assistant/feedback/all${qs(params)}`),
      /** Candidate projects for filtering (same visibility rules as the list). */
      listProjects: () =>
        request<Array<{ id: string; name: string }>>('/assistant/feedback/projects'),
    },
    /** System settings: assistant short-term memories (read-only + soft delete; the only write entry point is the assistant save_memory tool). Server-side pagination. */
    memories: {
      list: (params?: { productLineId?: string; status?: string; scope?: 'global' | 'product_line'; page?: number; limit?: number }) =>
        request<Paged<AssistantMemory>>(`/assistant/memories${qs(params ?? {})}`),
      remove: (id: string) =>
        request<void>(`/assistant/memories/${id}`, { method: 'DELETE' }),
    },
    /** System settings: assistant trajectories (read-only + soft delete; the only write entry point is the persistence hook → distillation worker). Server-side pagination. */
    trajectories: {
      list: (params?: { productLineId?: string; status?: string; page?: number; limit?: number }) =>
        request<Paged<AssistantTrajectory>>(`/assistant/trajectories${qs(params ?? {})}`),
      remove: (id: string) =>
        request<void>(`/assistant/trajectories/${id}`, { method: 'DELETE' }),
    },
    /** System settings: system prompt modules (R3). No row = code default; the skill group is read-only (only fromSeq rollback). */
    promptModules: {
      list: () => request<PromptModule[]>('/assistant/prompt-modules'),
      versions: (key: string) =>
        request<PromptModuleVersion[]>(`/assistant/prompt-modules/${encodeURIComponent(key)}/versions`),
      setValue: (key: string, body: { value?: string | null; fromSeq?: number }) =>
        request<{ seq: number | null }>(`/assistant/prompt-modules/${encodeURIComponent(key)}/value`, {
          method: 'POST', body: JSON.stringify(body),
        }),
    },
    /** System settings: solidification inventory (R3). The LLM only produces proposals; applying always requires human approval. Batches/proposals are both server-paginated. */
    solidify: {
      scan: () => request<{ id: string }>('/assistant/solidify/scan', { method: 'POST', body: '{}' }),
      batches: (params?: { status?: string; page?: number; limit?: number }) =>
        request<Paged<SolidifyBatch>>(`/assistant/solidify/batches${qs(params ?? {})}`),
      proposals: (params?: { batchId?: string; status?: string; page?: number; limit?: number }) =>
        request<Paged<SolidifyProposal>>(`/assistant/solidify/proposals${qs(params ?? {})}`),
      proposal: (id: string) => request<SolidifyProposal>(`/assistant/solidify/proposals/${id}`),
      approve: (id: string, retireIds: string[]) =>
        request<{ ok: boolean }>(`/assistant/solidify/proposals/${id}/approve`, {
          method: 'POST', body: JSON.stringify({ retireIds }),
        }),
      reject: (id: string) =>
        request<{ ok: boolean }>(`/assistant/solidify/proposals/${id}/reject`, {
          method: 'POST', body: '{}',
        }),
    },
    /** System settings: failure lessons (R3.5). The signals collection table is not exposed. */
    failureLessons: {
      list: (status?: 'active' | 'resolved' | 'retired') =>
        request<FailureLesson[]>(`/assistant/failure-lessons${qs(status ? { status } : {})}`),
      retire: (id: string) =>
        request<{ ok: boolean }>(`/assistant/failure-lessons/${id}/retire`, { method: 'POST', body: '{}' }),
    },
    /** System settings: globally shared MCP servers (scope fixed to global). */
    mcpServers: {
      list: () => request<AssistantMcpServer[]>('/assistant/mcp-servers'),
      create: (body: { name: string; kind: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; exposure?: string; enabled?: boolean }) =>
        request<AssistantMcpServer>('/assistant/mcp-servers', { method: 'POST', body: JSON.stringify(body) }),
      patch: (id: string, body: Partial<{ name: string; command: string; args: string[]; url: string; exposure: string; enabled: boolean }>) =>
        request<AssistantMcpServer>(`/assistant/mcp-servers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
      remove: (id: string) =>
        request<void>(`/assistant/mcp-servers/${id}`, { method: 'DELETE' }),
    },
    /** System settings: globally shared AI skills. The DB stores name/description/enabled; content lives in the server-side directory tree.
     *  Every file API is located by skill id (the top-level path segment is resolved from the DB row by the server), and all go through the server-side
     *  resolveInSkill guard — the client doesn't pass directory names; path escapes/symlinks are rejected server-side. */
    skills: {
      list: () => request<AssistantSkill[]>('/assistant/skills'),
      create: (body: { name: string; description: string; enabled?: boolean }) =>
        request<AssistantSkill>('/assistant/skills', { method: 'POST', body: JSON.stringify(body) }),
      patch: (id: string, body: Partial<{ name: string; description: string; enabled: boolean }>) =>
        request<AssistantSkill>(`/assistant/skills/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
      remove: (id: string) =>
        request<void>(`/assistant/skills/${id}`, { method: 'DELETE' }),
      /** Delete a disk orphan directory (rows with id=null can't reach the :id API family; they can only be deleted by name).
       *  Registered skills get 409 on this route — use remove(id) to delete them. */
      removeOrphan: (name: string) =>
        request<void>(`/assistant/skills/orphan/${encodeURIComponent(name)}`, { method: 'DELETE' }),
      tree: (id: string) => request<AssistantSkillFileNode[]>(`/assistant/skills/${id}/tree`),
      readFile: (id: string, path: string) =>
        request<{ path: string; content: string; truncated: boolean }>(
          `/assistant/skills/${id}/file?path=${encodeURIComponent(path)}`),
      writeFile: (id: string, path: string, content: string) =>
        request<{ ok: boolean; path: string }>(`/assistant/skills/${id}/file`, {
          method: 'PUT', body: JSON.stringify({ path, content }),
        }),
      deleteFile: (id: string, path: string) =>
        request<void>(`/assistant/skills/${id}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
      /** Upload into an [existing] directory dir ('' means the skill root). The server does not create directories recursively. */
      uploadFiles: (id: string, dir: string, files: Array<{ path: string; content: string }>) =>
        request<{ ok: boolean; written: string[] }>(`/assistant/skills/${id}/files`, {
          method: 'POST', body: JSON.stringify({ dir, files }),
        }),
    },
  },
  registerAdmin: (body: { username: string; displayName: string; email?: string; organizationId: string }) =>
    request<{ temporaryPassword: string; user: SafeUser }>('/auth/register-admin', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  secrets: {
    fetch: (caseId: string, stepId: string, token: string) =>
      request<{ plaintext: string }>(
        `/cases/${caseId}/steps/secrets/${stepId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
  },
  scenarios: {
    // All scenarios in a project (aggregated across requirements). Feeds the scenario filter dropdown on the cases page — the list doesn't shrink with the selection.
    listForProject: (projectId: string) =>
      request<Array<{ id: string; title: string; requirementId: string }>>(
        `/scenarios?projectId=${projectId}`,
      ),
    listForRequirement: (requirementId: string) =>
      request<Scenario[]>(`/requirements/${requirementId}/scenarios`),
    create: (requirementId: string, body: { title: string; description?: string }) =>
      request<Scenario>(`/requirements/${requirementId}/scenarios`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    patch: (id: string, body: Partial<{ title: string; description: string }>) =>
      request<Scenario>(`/scenarios/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) =>
      request<{ ok: boolean }>(`/scenarios/${id}`, { method: 'DELETE' }),
  },
  deviceTargets: {
    list: (projectId: string) => request<DeviceTarget[]>(`/projects/${projectId}/device-targets`),
    create: (projectId: string, body: Omit<DeviceTarget, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>) =>
      request<DeviceTarget>(`/projects/${projectId}/device-targets`, { method: 'POST', body: JSON.stringify(body) }),
    update: (projectId: string, id: string, body: Omit<DeviceTarget, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>) =>
      request<DeviceTarget>(`/projects/${projectId}/device-targets/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    remove: (projectId: string, id: string) =>
      request<{ ok: true }>(`/projects/${projectId}/device-targets/${id}`, { method: 'DELETE' }),
  },
};

export interface LlmTestResult {
  ok: boolean;
  provider: string;
  latencyMs?: number;
  error?: string;
}

/** GET /api/settings/llm channel view: apiKey returns a mask only, with a hasApiKey flag (mirrors the environments mask pattern). */
export interface LlmChannelView {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  maxTokens: number | null;
  apiKeyMasked: string;
  hasApiKey: boolean;
}

export interface LlmSettingsView {
  defaultChannelId: string;
  visionChannelId: string | null;
  channels: LlmChannelView[];
}

/** PUT /api/settings/llm: an empty/missing apiKey = the server keeps the stored original value by id. */
export interface LlmSettingsPut {
  defaultChannelId: string;
  visionChannelId?: string | null;
  channels: Array<{
    id?: string;
    name: string;
    provider: string;
    apiKey?: string;
    model: string;
    baseUrl?: string;
    maxTokens?: number | null;
  }>;
}

/** Creator/executor summary: appended uniformly by the backend's list/detail serializations; null for legacy rows or deleted users. */
export interface Creator {
  id: string;
  username: string;
  displayName: string;
}

export interface EnvironmentObject {
  id: string;
  environmentId: string;
  objectType: 'db' | 'syslog' | 'web';
  label: string;
  /** db: { host, port, dbName, user, password?, secret? }; syslog: { host, user, sshPort, filePath, privateKey?, secret? };
   *  web: { name?, scheme, host, port?, user?, loginUrl?, password?, secret? } (since 0041, web embeds the application login credential).
   *  In responses secret is the '••••••••' mask; requests pass plaintext password/privateKey; leaving them empty does not overwrite the stored ciphertext. */
  payload: Record<string, unknown>;
  /** Flag added by the backend from the DB row: whether the original payload.secret exists; the frontend uses it to decide "credentials configured", without reverse-parsing the masked secret. */
  hasSecret: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  isDefault: boolean;
  objects: EnvironmentObject[];
  createdAt: string;
  updatedAt: string;
  createdBy?: Creator | null;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  organizationId: string;
  /** Owning product line (nullable = not assigned to a line). Projects within a product line can share cases across projects. */
  productLineId?: string | null;
  productLineName?: string | null;
  repoUrl: string | null;
  defaultBranch: string;
  provider: string;
  gitlabUrlOverride: string | null;
  hasPat: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: Creator | null;
}

export interface ProjectVersion {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  ref: string | null;
  refKind: 'branch' | 'tag' | null;
  environmentId: string | null;
  createdAt: string;
  updatedAt: string;
  caseCount?: number;
  environmentName?: string | null;
  planCount?: number;
}
export interface ProjectWithCount extends Project {
  caseCount: number;
  versionCount: number;
  environmentCount: number;
}
export interface ProductLine {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ProductLineDetail extends ProductLine {
  projects: { id: string; name: string }[];
}
export interface Group {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
export interface GroupWithCount extends Group {
  caseCount: number;
}
export interface RcaEvidence { file: string; lines?: string; note?: string }
export interface RcaResult {
  status: 'analyzed' | 'skipped' | 'timeout' | 'error';
  category: 'system_defect' | 'case_issue' | 'environment' | 'other';
  confidence?: 'high' | 'medium' | 'low';
  summary: string;
  evidence?: RcaEvidence[];
  suggestion?: string;
  analyzedAt?: string;
  threadId?: string;
}
export interface ExecutionPlan {
  id: string;
  projectId: string;
  versionId: string | null;
  versionName?: string | null;
  name: string;
  /** Automatically run AI root-cause analysis on failed cases after a run finishes */
  rcaEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: Creator | null;
}
export interface PlanWithCount extends ExecutionPlan {
  caseCount: number;
}
/** Plan groups: each group independently configures environment/login preparation/failFast/browser context; cases within a group are ordered. */
export interface PlanCaseGroup {
  id: string;
  name: string;
  order: number;
  environmentId: string | null;
  loginPrepareEnabled: boolean;
  loginCaseId: string | null;
  /** Title of the selected login case (null when none) — used for the select-button echo. */
  loginCaseTitle: string | null;
  /** Dataset bound to the selected login case and the case-level row selection (null/[]/0 when no dataset is bound). */
  loginCaseDatasetId: string | null;
  loginCaseRowIndexes: number[];
  /** Enabled row count of the login case's dataset — the index upper bound for loginCaseRowIndexes. */
  loginCaseEnabledRowCount: number;
  /** Login case row override, three states: null = follow case-level; [] = all rows; non-empty = subset. */
  loginDatasetRowIndexes: number[] | null;
  detectionUrl: string | null;
  loginSuccessSelector: string | null;
  loginUnauthorizedKeywords: string[] | null;
  failFast: boolean;
  targetConfig: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null;
  cases: Array<{
    planCaseId: string; id: string; order: number; title: string; url: string | null;
    versionId: string | null; versionName: string | null; projectId: string | null; projectName: string | null;
    /** Bound dataset (null when unbound) with name/enabled row count/case-level row selection.
     *  When unbound: datasetId=null, datasetName=null, datasetEnabledRowCount=0, caseRowIndexes=[].
     *  caseRowIndexes=[] means "all enabled rows" (also the empty-set fallback when no dataset is bound),
     *  non-empty is a subset of enabled-row indexes (0-based, renumbered over enabled rows). */
    datasetId: string | null;
    datasetName: string | null;
    /** Enabled row count of this dataset (0 when unbound) — the index upper bound for caseRowIndexes. */
    datasetEnabledRowCount: number;
    /** Case-level row selection: [] = all enabled rows; also [] when unbound (datasetEnabledRowCount=0 then). */
    caseRowIndexes: number[];
    /** Plan-level row override, three states: null = follow case-level; [] = all rows; non-empty = subset. */
    planRowIndexes: number[] | null;
  }>;
}
export interface PlanDetail extends ExecutionPlan {
  /** Flattened view: concatenated by group order (order = within-group order, globalOrder = global 1..N), for counting and cross-group dedup badge display.
   *  Fields are the same shape as groups[].cases (the server flatMaps directly from group cases, including the dataset three-state fields) + globalOrder. */
  cases: Array<PlanCaseGroup['cases'][number] & { globalOrder: number }>;
  groups: PlanCaseGroup[];
  strategy: 'run_all' | 'fail_fast';
}
export interface PlanRunDetail {
  id: string;
  planId: string;
  planName: string | null;
  status: string;
  strategy: string;
  loginPrepareEnabled: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  totalCases: number;
  passedCases: number | null;
  failedCases: number | null;
  skippedCases: number | null;
  cases: Array<{
    id: string;
    caseId: string;
    caseTitle: string | null;
    reportId: string | null;
    reportIds?: string[] | null;
    rowStatuses?: string[];
    /** Owning plan group (null on legacy runs). */
    groupId: string | null;
    groupName: string | null;
    groupOrder: number | null;
    order: number;
    status: string;
    stepKind: 'business' | 'login_prepare';
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    error: string | null;
    /** AI root-cause analysis result (present only on failed rows) */
    rca?: RcaResult | null;
    /** Final assertion conclusion: the vision verdict reason or the failed step's error; null when no report/not asserted. */
    lastAssertion?: string | null;
  }>;
  /** Triggered by (= the plan run's executor). */
  triggeredBy?: Creator | null;
}

/** Exploration session state machine: pending → running → completed | failed | cancelled. */
export type ExplorationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
/** Finding review state machine: pending → confirmed | dismissed; confirmed → promoted. */
export type ExplorationFindingStatus = 'pending' | 'confirmed' | 'dismissed' | 'promoted';

/** One action trail entry (ground truth recorded by the platform, not the model's own account). */
export interface ExplorationStep {
  type: string;
  target: string;
  ok: boolean;
  /** Result summary of a sql step (row count + first row). */
  detail?: string;
  /** Result summary of this step (plain language: what was seen / what changed / why it failed) — the body of the "session process" list. */
  outcome?: string;
  /** Input value for fill (placeholder literal or plain text). */
  value?: string;
  /** Milliseconds for wait. */
  ms?: number;
  /** Key name for press. */
  key?: string;
}

/** Code commit scope (parsed from the charter's natural language): commit window + changed files + candidate starting points.
 *  Scope is a focus signal, not a fence — the exploration still crawls the whole site; scope only guides targeting. */
export interface CodeScope {
  kind: 'time_window' | 'commit_range' | 'single_commit';
  /** One-line human-readable label (card title). */
  label: string;
  since?: string;
  until?: string;
  fromSha?: string;
  toSha?: string;
  commitSha?: string;
  headSha?: string;
  commits: Array<{ sha: string; subject: string; date: string }>;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
  /** Candidate starting points (literal path strings starting with / extracted from changed file sources) — heuristic, may be inaccurate. */
  hintUrls: string[];
  confidence: number;
  reason: string;
}

/** Code scope resolution status: pending (parsing) → resolved | none (charter has no commit semantics) | failed (parse failure). */
export type CodeScopeStatus = 'pending' | 'resolved' | 'none' | 'failed';

export interface ExplorationSession {
  id: string;
  projectId: string;
  versionId: string;
  title: string;
  charter: string;
  /** Persona key (qa/novice/power/accessibility); the single source of truth lives in @itest/shared. */
  persona: string;
  startUrl: string | null;
  status: ExplorationStatus;
  cancelRequested: boolean;
  /** Destructive-operation authorization (default false): the exploration may only click irreversible entries like delete/pay/send when checked. */
  allowDestructive: boolean;
  /** Fault-injection authorization (default false): the exploration may only inject offline/slow network/CPU throttling to verify error handling and degradation when checked. */
  allowFaultInjection: boolean;
  /** Browser viewport width/height (two states: null = default 1280×800; a pair = custom, aligned with the case's custom window). */
  windowWidth: number | null;
  windowHeight: number | null;
  /** Turn budget (null = backend default 60): a soft budget; past the limit it wraps up gracefully, and all findings discovered so far are kept. */
  budgetTurns?: number | null;
  /** Negative-result ledger: hypotheses the model declares "ruled out" plus evidence (a minimal slice of externalized memory). */
  excludedLedger?: Array<{ claim: string; evidence: string }> | null;
  /** Coverage ledger (C1): mechanically maintained covered paths / interaction counts / sub-goal completion. */
  coverageLedger?: CoverageLedger | null;
  /** Error signals (D3): console/pageerror/HTTP 4xx-5xx captured during the exploration. */
  errorSignals?: Array<{ at: string; kind: 'console' | 'pageerror' | 'http'; text: string; url?: string }> | null;
  /** Independent review (A3) status: pending (not reviewed) | done | failed | skipped (no findings). */
  judgeStatus?: 'pending' | 'done' | 'failed' | 'skipped';
  /** Review summary (A3): verdict + confidence per finding. The review only annotates; it does not change findings.status. */
  judgeResult?: {
    judgedAt: string;
    summary?: string;
    error?: string;
    findings: Array<{ id: string; verdict: 'confirmed' | 'dismissed' | 'unclear'; reason: string; confidence: number }>;
  } | null;
  /** Persona matrix (C3): sessions grouped and displayed by the same matrix_id. */
  matrixId?: string | null;
  matrixLabel?: string | null;
  matrixRole?: string | null;
  /** Code commit scope (parsed by the runner in the background, visible via frontend polling; carried by both detail and list APIs). */
  codeScope?: CodeScope | null;
  codeScopeStatus?: CodeScopeStatus | null;
  summary: string | null;
  error: string | null;
  turnsUsed: number;
  usage: { calls?: number; promptTokens?: number; completionTokens?: number; durationMs?: number; model?: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy?: Creator | null;
  /** Defect candidate count: the list API groups stats by session and attaches it (used for card badges); the detail API doesn't carry this field. */
  findingsCount?: number;
  /** Carried by the detail API only (not the list API). */
  findings?: ExplorationFinding[];
  /** Detail API only: session process — every step action recorded by the platform (legacy sessions merge it from each finding's action trail). */
  steps?: ExplorationStep[];
}

/** Coverage ledger snapshot (C1): path dedup + interaction counts + sub-goal completion (the platform doesn't guess "did it actually happen"). */
export interface CoverageLedger {
  paths: string[];
  interactions: Array<{ kind: string; count: number }>;
  goals: Array<{ id: string; text: string; done: boolean }>;
}

/** Matrix view (C3/S2): all sessions in the matrix + their findings (findings carry crossSessionCount). */
export interface ExplorationMatrix {
  matrixId: string;
  label: string | null;
  sessions: ExplorationSession[];
  findings: ExplorationFinding[];
}

export interface ExplorationFinding {
  id: string;
  sessionId: string;
  order: number;
  title: string;
  description: string;
  /** Reuses the case priority vocabulary P0-P3. */
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  /** Repro steps given by the model (may be hallucinated); when empty the backend falls back to textualized actionsTrail. */
  reproSteps: Array<{ action: string; expected?: string }>;
  /** Actual action trail recorded by the platform (ground truth). */
  actionsTrail: Array<{ type: string; target: string; ok: boolean; detail?: string }> | null;
  /** /screenshots/<sessionId>/finding-<order>.png (served by express.static). */
  screenshotPath: string | null;
  pageUrl: string | null;
  /** Decision frame metadata (A1): the page state pinned after the finding report tool screenshotted "at the moment of decision". */
  evidenceFrame?: {
    url: string;
    viewport: { width: number; height: number } | null;
    capturedAt: string;
    trailIndex: number;
    screenshotPath?: string;
  } | null;
  /** Cross-session intersection (S2): how many sessions reported the same defect; ≥2 = jointly discovered from multiple perspectives. */
  crossSessionCount: number;
  /** Independent review verdict (A3): annotation only, status unchanged — human review is the authority. */
  judge?: {
    verdict: 'confirmed' | 'dismissed' | 'unclear';
    reason: string;
    confidence: number;
    model?: string;
    judgedAt: string;
  } | null;
  status: ExplorationFindingStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  promotedCaseId: string | null;
  createdAt: string;
}
export interface PlanSchedule {
  id: string;
  planId: string;
  enabled: boolean;
  cronExpr: string;
  timezone: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface PlanScheduleCreateInput {
  cronExpr: string;
  timezone?: string;
  enabled?: boolean;
}
export interface PlanSchedulePatchInput {
  cronExpr?: string;
  timezone?: string;
  enabled?: boolean;
}
export type ExecutionEntry =
  | {
      kind: 'case';
      id: string;
      caseId: string;
      caseTitle: string | null;
      versionId: string | null;
      versionName: string | null;
      status: string;
      durationMs: number | null;
      summary: string | null;
      /** Final assertion info: the vision verdict reason or the failed step's error; null when nothing was asserted. */
      lastAssertion?: string | null;
      /** Self-heal passed flag: passed and the AI self-heal succeeded after the aiTask cache diverged. */
      healed?: boolean;
      /** Dataset batch id (shared by all rows of one dataset execution); null for non-dataset executions. */
      datasetBatchId?: string | null;
      /** Number of batch members this record stands for (1 for non-dataset executions). */
      batchSize?: number;
      /** Passed / failed members within the batch (computed from true full-batch values, unaffected by filtering). */
      batchPassed?: number;
      batchFailed?: number;
      /** Report ids of all members in the batch (expanded into N report deletions on batch delete). */
      memberReportIds?: string[];
      createdAt: string;
      /** Executor (report creator = the one who triggered the run). */
      createdBy?: Creator | null;
    }
  | {
      kind: 'plan';
      id: string;
      planId: string;
      /** Owning plan name (the innerJoin misses once the plan is deleted so the row can't appear; theoretically non-null). */
      planName: string | null;
      versionId: string | null;
      versionName: string | null;
      status: string;
      summary: string | null;
      totalCases: number;
      passedCases: number | null;
      failedCases: number | null;
      skippedCases: number | null;
      durationMs: number | null;
      createdAt: string;
      createdBy?: Creator | null;
    };
export interface ProjectStats {
  requirements: number;
  cases: number;
  passes: number;
  failures: number;
  groups: Array<{ id: string; name: string; caseCount: number }>;
  recentRuns: Array<{ id: string; caseId: string; status: string; createdAt: string }>;
}
export type CaseStatus = 'draft' | 'review' | 'ready' | 'deprecated';
export interface TestCase {
  id: string;
  title: string;
  priority: string;
  status: string;
  groupId?: string;
  url?: string | null;
  requirementId?: string | null;
  /** Requirement number (free-text external number, not a requirements FK). */
  requirementNo?: string | null;
  scenarioId?: string | null;
  scenarioTitle?: string | null;
  tags?: Tag[];
  versionId?: string;
  versionName?: string;
  /** Owning project (attached when the list API pulls across projects under a product line; feeds the "cross-project" badge and per-project filtering). */
  projectId?: string | null;
  projectName?: string | null;
  createdAt?: string;
  updatedAt?: string;
  windowStrategy?: string;
  windowWidth?: number | null;
  windowHeight?: number | null;
  incognito?: boolean;
  defaultEnvId?: string | null;
  /** Environment web service object name (payload.name); empty → build a relative URL from the environment's default web service. */
  webServiceRef?: string | null;
  datasetId?: string | null;
  /** Dataset row selection: array of enabled-row indexes (0-based, renumbered after removing disabled rows).
   *  [] = all enabled rows (same semantics as the server's test_cases.dataset_row_indexes). */
  datasetRowIndexes?: number[];
  /** Track 1: case-level expected outcome description (natural language). After replay finishes, the vision LLM judges it against the final screenshot. */
  expectedOutcome?: string | null;
  platform?: 'web' | 'mobile';
  mobileOs?: 'ios' | 'android' | null;
  mobileDeviceTargetId?: string | null;
  appRef?: { bundleId: string; appPath?: string; launchArgs?: string[] } | null;
  createdBy?: Creator | null;
  /** Step solidification progress (backfilled by the list API): total = step count, compiled = solidified step count. */
  stepsTotal?: number;
  stepsCompiled?: number;
}
/** Batch solidification progress (GET /cases/solidify-batches/:id). status is derived at read time:
 *  any running row = running; otherwise all passed = passed, all failed = failed, mixed = partial. */
export interface SolidifyBatchStatus {
  batchId: string;
  status: 'running' | 'passed' | 'failed' | 'partial';
  total: number;
  passed: number;
  failed: number;
  running: number;
  cases: Array<{ caseId: string; title: string; status: string; error: string | null }>;
}
/** In-flight batch solidification batches (GET /cases/solidify-batches): only batches that still have running rows are returned.
 *  Once a batch fully reaches terminal states it disappears from the list automatically (banner gone, badge back to n/N). */
export interface SolidifyBatchesOverview {
  batches: Array<{
    batchId: string;
    projectId: string;
    createdAt: string;
    status: 'running' | 'passed' | 'failed' | 'partial';
    total: number;
    passed: number;
    failed: number;
    running: number;
    cases: Array<{ caseId: string; title: string; status: string; error: string | null }>;
  }>;
}
export interface Scenario {
  id: string;
  requirementId: string;
  title: string;
  description: string | null;
  order: number;
  createdAt: string;
}
/** Globally shared MCP servers managed in system settings (platform-level, scope=global). */
export interface AssistantMcpServer {
  id: string;
  name: string;
  kind: 'stdio' | 'http';
  command: string | null;
  args: string[] | null;
  url: string | null;
  env: Record<string, string> | null;
  exposure: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
/** Assistant short-term memory row (GET /assistant/memories; productLineName comes from the route's join). */
export interface AssistantMemory {
  id: string;
  scope: 'product_line' | 'global';
  productLineId: string | null;
  productLineName: string | null;
  title: string;
  hook: string;
  body: string | null;
  provenance: 'user_stated' | 'ai_inferred';
  status: string;
  hitCount: number;
  lastHitAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Assistant trajectory row (GET /assistant/trajectories; productLineName comes from the route's join). */
export interface AssistantTrajectory {
  id: string;
  productLineId: string;
  productLineName: string | null;
  taskTitle: string;
  taskKeywords: string;
  digest: string;
  caseTitle: string;
  status: string;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Coverage value baseline drift: after code defaults evolve, an override row still rests on the old baseline (drift) or has no fingerprint (unknown). */
export interface PromptDrift {
  key: string;
  label: string;
  group: 'main' | 'tool' | 'skill';
  seq: number;
  source: string;
  writtenAt: string;
  status: 'drift' | 'unknown';
  baseHash: string | null;
  currentHash: string;
}

/** R3 prompt module (settings-page system prompts). isDefault=true means the code default is currently in use. */
export interface PromptModule {
  key: string;
  group: 'main' | 'tool' | 'skill';
  label: string;
  readonly: boolean;
  hasRow: boolean;
  seq: number | null;
  source: string | null;
  value: string | null;
  isDefault: boolean;
  text: string;
  drift: PromptDrift | null;
}

export interface PromptModuleVersion {
  seq: number;
  moduleKey: string;
  value: string | null;
  source: string;
  sourceRef: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface SolidifyBatch {
  id: string;
  status: 'running' | 'done' | 'failed';
  inputSummary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SolidifyProposalSource {
  type: 'memory' | 'trajectory' | 'lesson';
  id: string;
  title: string;
  /** Source line name (frozen at creation, 'global'=global memory). Empty string for lesson sources. */
  lineName: string;
  retireRecommended: boolean;
  /** lesson only: snapshot of attribution and signal count (shown in the approval detail). */
  attribution?: 'prompt' | 'step_description';
  signalCount?: number;
}

export interface SolidifyProposal {
  id: string;
  batchId: string;
  kind: 'prompt_amendment' | 'skill_revision' | 'prompt_correction';
  target: string;
  title: string;
  body: string;
  rationale: string;
  sources: SolidifyProposalSource[];
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy: string | null;
  reviewedAt: string | null;
  appliedAt: string | null;
  applyError: string | null;
  distillModel: string;
  /** prompt_correction only: version chain head at inventory time (re-checked on apply; manually changed → reject). */
  baseSeq: number | null;
  createdAt: string;
}

/** System settings: failure lessons (R3.5). The signals collection table is not exposed. */
export interface FailureLesson {
  id: string;
  status: 'active' | 'resolved' | 'retired';
  attribution: 'prompt' | 'step_description' | 'platform' | 'sut';
  title: string;
  lesson: string;
  signals: Array<{ type: string; refId: string; excerpt: string }>;
  resolvedByProposal: string | null;
  distillModel: string;
  createdAt: string;
  updatedAt: string;
}
/** Globally shared AI skills managed in system settings (assistant_skills table).
 *  2026-10-19 storage flip: the DB keeps only metadata; content lives in the server-side directory tree SKILLS_ROOT/<name>/,
 *  operated via tree/readFile/writeFile/deleteFile/uploadFiles below. */
export interface AssistantSkill {
  /** Orphan directories (on disk but with no DB row) have no id; display/delete only, metadata changes not allowed. */
  id: string | null;
  name: string;
  description: string;
  enabled: boolean;
  /** Disk stats (file count and byte count counted by walking the tree recursively). */
  fileCount: number;
  totalBytes: number;
  onDisk: boolean;
  /** true = disk orphan directory: unregistered, no description, can't enter the catalog. */
  unregistered: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}
/** File tree node (relative to the skill root, posix separators). */
export interface AssistantSkillFileNode {
  path: string;
  kind: 'file' | 'dir';
  size: number;
  runtime?: string;
}
// Single-object form of the version-space assistant staging tables (thread-scoped)
export interface StagedStageCase {
  localId: string;
  title: string;
  description: string | null;
  priority: string | null;
  url: string | null;
  steps: Array<{ action: string; assertion?: string | null; compiled?: unknown[] | null }>;
  defaultEnvId: string | null;
  expectedOutcome: string | null;
  /** Companion dataset localId (generated by the same stage_dataset batch; on save the dataset is persisted first and auto-bound). */
  datasetLocalId: string | null;
  /** Test types this entry claims to cover (a subset of COVERAGE_TYPE_KEYS); the staging area uses it to see coverage distribution at a glance. */
  coverageTypes: string[];
  stagedAt: string;
}
export interface StagedStageScenario {
  localId: string;
  requirementId: string;
  title: string;
  description: string | null;
  caseLocalIds: string[];
  stagedAt: string;
}
export interface StagedEnvironmentObject {
  objectType: 'db' | 'syslog' | 'web';
  label?: string;
  payload: Record<string, unknown>;
  isDefault?: boolean;
}
export interface StagedEnvironment {
  localId: string;
  name: string;
  baseUrl: string | null;
  objects: StagedEnvironmentObject[];
  stagedAt: string;
}
export interface StagedPlan {
  localId: string;
  name: string;
  environmentId: string | null;
  caseLocalIds: string[];
  stagedAt: string;
}
export interface StageCaseOp {
  localId: string;
  caseId: string;
  op:
    | 'update_case'
    | 'delete_case'
    | 'move_case'
    | 'update_step'
    | 'insert_step'
    | 'delete_step'
    | 'move_step';
  payload: unknown;
  summary: string;
  diff?: string;
  stagedAt: string;
}
/** AI-generated dataset draft: rows are plaintext (sensitive columns are encrypted only when persisted); the preview is visible to users. */
export interface StagedDataset {
  localId: string;
  name: string;
  description: string | null;
  columns: Array<{ name: string; sensitive?: boolean }>;
  rows: Array<{ disabled?: boolean; cells: Record<string, string> }>;
  stagedAt: string;
}
export interface StageDoc {
  cases: StagedStageCase[];
  scenarios: StagedStageScenario[];
  environments: StagedEnvironment[];
  plans: StagedPlan[];
  caseOps: StageCaseOp[];
  datasets: StagedDataset[];
}
export interface StageSaveBody {
  cases: Array<{ localId: string; groupId: string }>;
  scenarios: Array<{ localId: string }>;
  environments: Array<{ localId: string }>;
  plans: Array<{ localId: string }>;
  caseOps: Array<{ localId: string }>;
  datasets: Array<{ localId: string }>;
}
export interface Tag {
  id: string;
  organizationId: string;
  name: string;
  color: string;
  description: string | null;
  createdAt?: string;
  updatedAt?: string;
}
export interface TestStep {
  id: string;
  order: number;
  source: string;
  delayMs?: number | null;
  tabRef?: string | null;
  componentKind?: string | null;
  sensitive?: boolean;
  /** 2026-10-06: row-level natural language; for humans / as the LLM's starting point; replay doesn't read it.
   *  2026-10-07: replaced the old name column (read/write fully removed); the complete natural-language description lives here. */
  instruction?: string | null;
  /** 2026-10-06: executable DSL array StepAction[]; the sole basis for replay. Empty array/null = not compiled.
   *  2026-10-07: the old action column was DROPped; the DSL lives only here. */
  compiled?: unknown[] | null;
}
export interface TestCaseDetail extends TestCase {
  description?: string;
  steps: TestStep[];
  resolvedUrl: string | null;
}export interface Report {
  id: string;
  caseId: string;
  caseTitle: string | null;
  status: string;
  durationMs: number | null;
  stepResults: unknown;
  summary: string | null;
  datasetRowIndex?: number | null;
  datasetSnapshot?: { rowIndex: number; totalRows: number; values: Record<string, string> } | null;
  /** Dataset batch id: shared by the N rows of one execution; null on legacy reports (row switcher not rendered). */
  datasetBatchId?: string | null;
  platform?: 'web' | 'mobile';
  mobileOs?: 'ios' | 'android' | null;
  deviceName?: string | null;
  deviceTargetId?: string | null;
  /** Self-heal passed flag: passed and the AI self-heal succeeded after the aiTask cache diverged; always false for failed. */
  healed?: boolean;
  /** Start/end times of the actual execution phase (null on legacy reports). startedAt = the moment steps started running, on the same baseline as durationMs. */
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  /** Plan run member report: attached source (queried by the backend from plan_run_cases). The back button switches to "back to plan run" based on it */
  planRunId?: string | null;
  planId?: string | null;
  /** AI root-cause analysis result (present when the report belongs to plan_run_cases and has been analyzed) */
  rca?: RcaResult | null;
  /** Executor = report creator (the one who triggered the run). */
  createdBy?: Creator | null;
}
/** Dataset batch: sibling row summaries of the same batch (used by the row switcher's polling; no step details). */
export interface DatasetBatch {
  batchId: string | null;
  rows: Array<{
    id: string;
    datasetRowIndex: number | null;
    status: string;
    durationMs: number | null;
    datasetSnapshot: { rowIndex: number; totalRows: number; values: Record<string, string> } | null;
  }>;
}
export interface DatasetSaveBody {
  name: string;
  description?: string | null;
  columns: Array<{ name: string; sensitive?: boolean }>;
  rows: Array<{ disabled?: boolean; cells: Record<string, unknown> }>;
  /** Column rename declaration (old name → new name): makes the server re-key the old column's ciphertext to the new name (when editing an existing dataset). */
  renames?: Record<string, string>;
}
/** xlsx import parse output (import-parse): new columns are always non-sensitive and rows never disabled; after merging into the draft it still goes through the normal save. */
export interface DatasetImportPayload {
  columns: Array<{ name: string; sensitive: false }>;
  rows: Array<{ disabled: false; cells: Record<string, string> }>;
}
export interface DatasetSummary {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  columns: Array<{ name: string; sensitive: boolean }>;
  rowCount: number;
  enabledRowCount: number;
  updatedAt: string;
  createdBy?: Creator | null;
}
export interface DatasetMaskedCell { __masked: true }
/** Detail/create/edit output: original row fields + masked rows (unlike Summary, it omits rowCount/enabledRowCount stats). */
export interface DatasetDetail {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  columns: Array<{ name: string; sensitive: boolean }>;
  rows: Array<{ disabled: boolean; cells: Record<string, string | DatasetMaskedCell> }>;
  createdAt: string;
  updatedAt: string;
  createdBy?: Creator | null;
}
export interface DeviceTarget {
  id: string;
  projectId: string;
  name: string;
  mobileOs: 'ios' | 'android';
  deviceRef: string;
  appBundleId: string | null;
  appPath: string | null;
  launchArgs: string[];
  createdAt: string;
  updatedAt: string;
}
export interface VariableReport {
  undefined: Array<{ stepOrder: number; field: string; name: string }>;
  duplicates: Array<{ name: string; definedAt: number[] }>;
  forwardRefs: Array<{ stepOrder: number; field: string; name: string }>;
  regexIssues: Array<{ stepOrder: number; reason: string }>;
  invalidNames: Array<{ stepOrder: number; field: string; name: string; reason: string }>;
}

// ---------- Auth & organizations ----------

/** Current user with sensitive fields redacted (no passwordHash). */
export interface SafeUser {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  /** UI language preference; writable via PATCH /users/:id, undefined when /auth/me doesn't return it yet. */
  languagePreference?: 'zh-CN' | 'en-US' | null;
}

/** Login success → automatically logged in; otherwise enters the first-login forced password change flow (passwordChangeToken is single-use and valid for 5 minutes). */
export type LoginResponse =
  | { status: 'ok'; user: SafeUser; organization: { id: string; name: string; isManager: boolean; isUser: boolean } }
  | { status: 'password_change_required'; passwordChangeToken: string; username: string };

export interface OrgMembership {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  isManager: boolean;
  isUser: boolean;
}

export interface MeResponse {
  user: SafeUser;
  activeOrganizationId: string;
  organizations: OrgMembership[];
}

/** Organization list item (visible orgs: those you joined ∪ subtrees you manage). */
export interface OrgSummary extends OrgMembership {
  description: string | null;
  memberCount: number;
}

export interface Organization {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Paged response shape, consistent with the backend's design-systems / users and similar APIs */
export interface Paged<T> { items: T[]; total: number; page: number; limit: number }

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
}

export interface UserOrgMembership {
  organizationId: string;
  organizationName: string;
  organizationPath: string;
  isManager: boolean;
  isUser: boolean;
}

export interface UserDetail extends UserSummary {
  createdAt: string;
  disabledAt: string | null;
  organizations: UserOrgMembership[];
  projectCount: number;
}

export interface UserProjectSummary {
  id: string;
  name: string;
  description: string | null;
  organizationId: string | null;
}

export interface AssignedUser {
  userId: string;
  username: string;
  displayName: string | null;
}

export interface OrgDetail extends OrgSummary {
  createdAt: string;
  updatedAt: string;
}

export interface OrgManagedNode {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  description: string | null;
  memberCount: number;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrgMemberRow {
  id: string;
  userId: string;
  organizationId: string;
  organizationName: string | null;
  username: string;
  displayName: string;
  email: string | null;
  isManager: boolean;
  isUser: boolean;
  joinedAt: string;
}

/** Product lines in the org view: product lines have fully replaced the "projects under an organization" position. */
export interface OrgProductLineSummary {
  id: string;
  name: string;
  description: string | null;
  organizationId: string;
  projectCount: number;
}

export interface VerifyRepoResult {
  valid: boolean;
  error?: string;
  branchExists?: boolean;
  defaultBranch?: string;
}
