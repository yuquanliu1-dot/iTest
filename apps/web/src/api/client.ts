const BASE = '/api';

/** 带 HTTP 状态码的请求错误；调用方可据此区分 404（不存在/不可见）等确定性失败。 */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 只拼接有值的参数：undefined / 空串 / false 一律跳过。
 *  空 q 会被后端当成「搜索空字符串」；false 也跳过是因为后端统一用 `=== 'true'`
 *  判定布尔参数，省略与 false 等价。 */
export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// 401 时跳登录页的豁免路径（登录/首登改密本身、/me 探测——这些 401 由调用方自行处理）
const AUTH_EXEMPT_PATHS = new Set(['/auth/login', '/auth/change-password', '/auth/me']);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    if (res.status === 401 && !AUTH_EXEMPT_PATHS.has(path)) {
      // 会话过期：整页跳登录（不 import authStore，避免循环依赖）
      window.location.assign('/login');
    }
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.message ?? `HTTP ${res.status}`);
  }
  // 204 No Content：DELETE 等空响应直接返回 undefined，不尝试解析 JSON。
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
    testConnection: (body: { provider: string; apiKey: string; model: string; baseUrl: string }) =>
      request<LlmTestResult>('/settings/llm/test', { method: 'POST', body: JSON.stringify(body) }),
  },
  projects: {
    list: () => request<ProjectWithCount[]>('/projects'),
    create: (body: { name: string }) =>
      request<Project>('/projects', { method: 'POST', body: JSON.stringify(body) }),
    patch: (id: string, body: Partial<{ name: string }>) =>
      request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
    get: (id: string) => request<Project>(`/projects/${id}`),
    move: (id: string, organizationId: string) =>
      request<Project>(`/projects/${id}/move`, { method: 'POST', body: JSON.stringify({ organizationId }) }),
    verifyRepo: (body: {
      repoUrl: string;
      provider?: 'github' | 'gitee' | 'gitlab';
      patOverride?: string;
      branch?: string;
      projectName?: string;
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
    groups: (id: string) => request<GroupWithCount[]>(`/projects/${id}/groups`),
    createGroup: (id: string, body: { name: string; defaultUrl?: string }) =>
      request<Group>(`/projects/${id}/groups`, { method: 'POST', body: JSON.stringify(body) }),
    stats: (id: string) => request<ProjectStats>(`/projects/${id}/stats`),
    overview: (id: string, range: '7d' | '30d' = '7d') =>
      request<import('../features/overview/api').OverviewResponse>(
        `/projects/${id}/overview?range=${range}`,
      ),
    plans: (id: string) => request<PlanWithCount[]>(`/projects/${id}/plans`),
    createPlan: (id: string, body: { name: string; environment?: string; versionId?: string }) =>
      request<ExecutionPlan>(`/projects/${id}/plans`, { method: 'POST', body: JSON.stringify(body) }),
    requirements: (id: string) => request<Requirement[]>(`/projects/${id}/requirements`),
    createRequirement: (id: string, body: { title: string; content: string }) =>
      request<Requirement>(`/projects/${id}/requirements`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
  groups: {
    patch: (id: string, body: Partial<{ name: string; defaultUrl: string }>) =>
      request<Group>(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/groups/${id}`, { method: 'DELETE' }),
  },
  plans: {
    get: (id: string) => request<PlanDetail>(`/plans/${id}`),
    patch: (
      id: string,
      body: Partial<{
        name: string;
        environment: string;
        environmentId: string | null;
        strategy: 'run_all' | 'fail_fast';
        loginPrepare: {
          enabled: boolean;
          caseId: string | null;
          detectionUrl: string | null;
          successSelector: string | null;
          unauthorizedKeywords: string[] | null;
        };
      }>,
    ) => request<ExecutionPlan>(`/plans/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/plans/${id}`, { method: 'DELETE' }),
    setCases: (id: string, caseIds: string[]) =>
      request<{ ok: boolean }>(`/plans/${id}/cases`, {
        method: 'PUT',
        body: JSON.stringify({ caseIds }),
      }),
    reorderCases: (id: string, caseIds: string[]) =>
      request<{ ok: boolean }>(`/plans/${id}/cases/order`, {
        method: 'PUT',
        body: JSON.stringify({ caseIds }),
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
    eventsUrl: (id: string) => `${BASE}/plan-runs/${id}/events`,
    removeBatch: (ids: string[]) =>
      request<{ count: number }>('/plan-runs/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ planRunIds: ids }),
      }),
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
    /** 写入 ref/refKind（与 patch 分开，避免误改 name/description）。 */
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
        baseUrl?: string;
        objects?: Array<{ objectType: 'db' | 'syslog' | 'login'; label?: string; payload: Record<string, unknown>; isDefault?: boolean }>;
      },
    ) =>
      request<Environment>(`/projects/${projectId}/environments`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    patch: (id: string, body: Partial<{ name: string; baseUrl: string | null; isDefault: boolean }>) =>
      request<Environment>(`/environments/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string, opts?: { confirm?: boolean }) =>
      request<{ ok: boolean; requiresConfirm?: boolean; caseCount?: number; planCount?: number }>(
        `/environments/${id}${opts?.confirm ? '?confirm=true' : ''}`,
        { method: 'DELETE' },
      ),
    createObject: (
      envId: string,
      body: { objectType: 'db' | 'syslog' | 'login'; label?: string; payload: Record<string, unknown>; isDefault?: boolean },
    ) =>
      request<EnvironmentObject>(`/environments/${envId}/objects`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    patchObject: (id: string, body: Partial<{ label: string; payload: Record<string, unknown> }>) =>
      request<EnvironmentObject>(`/environment-objects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    removeObject: (id: string) =>
      request<{ ok: boolean }>(`/environment-objects/${id}`, { method: 'DELETE' }),
    allowedTables: () => request<Record<string, string[]>>('/environments/allowed-tables'),
    testDb: (body: { objectId?: string; dbType?: 'postgres' | 'mysql'; host: string; port?: number; dbName: string; user: string; password?: string }) =>
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
  },
  executions: {
    list: (params?: { projectId?: string; kind?: 'case' | 'plan' | 'all' }) => {
      const qs = new URLSearchParams();
      if (params?.projectId) qs.set('projectId', params.projectId);
      if (params?.kind) qs.set('kind', params.kind);
      const s = qs.toString();
      return request<ExecutionEntry[]>(`/executions${s ? `?${s}` : ''}`);
    },
  },
  requirements: {
    get: (id: string) => request<Requirement>(`/requirements/${id}`),
  },
  cases: {
    list: (params?: string | { priority?: string; groupId?: string; projectId?: string; scenarioId?: string; versionIds?: string[] }) => {
      const p = typeof params === 'string' ? { priority: params } : params;
      const qs = new URLSearchParams();
      if (p?.priority) qs.set('priority', p.priority);
      if (p?.groupId) qs.set('groupId', p.groupId);
      if (p?.projectId) qs.set('projectId', p.projectId);
      if (p?.scenarioId) qs.set('scenarioId', p.scenarioId);
      if (p?.versionIds?.length) qs.set('versionIds', p.versionIds.join(','));
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
        description: string;
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
        datasetId: string | null;
        /** Track 1：用例级预期描述。空字符串由调用方转 null。 */
        expectedOutcome: string | null;
      }>,
    ) => request<TestCase>(`/cases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/cases/${id}`, { method: 'DELETE' }),
    removeBatch: (caseIds: string[]) =>
      request<{ count: number }>('/cases/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ caseIds }),
      }),
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
    /** 把自然语言 instruction 编译成 StepAction[] DSL。
     *  返回 { compiled: null, error } 时表示放弃/失败,UI 应让用户重写 instruction。
     *  轻量 LLM 单点调用,只用于 aiTask 子步抽出(走 inspection 不便的极简场景)。 */
    compileExtract: (caseId: string, body: { description: string; sampleText: string }) =>
      request<{ pattern: string | null; group: number; error?: string }>(
        `/cases/${caseId}/steps/extract/compile`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    execute: (id: string) =>
      request<{ reportId: string; reportIds?: string[] }>(`/cases/${id}/execute`, { method: 'POST' }),
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
  auth: {
    login: (username: string, password: string) =>
      request<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    // 首登强制改密：成功即自动登录（响应同登录 ok 分支并种下新 cookie）
    changePassword: (passwordChangeToken: string, newPassword: string) =>
      request<Extract<LoginResponse, { status: 'ok' }>>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ passwordChangeToken, newPassword }),
      }),
    me: () => request<MeResponse>('/auth/me'),
    // 切换组织：服务端重铸会话 cookie（新 JWT 携带新组织上下文）
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
    projects: (
      orgId: string,
      params?: { q?: string; includeSubtree?: boolean; page?: number; limit?: number },
    ) => request<Paged<OrgProjectSummary>>(`/organizations/${orgId}/projects${qs(params ?? {})}`),
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
  aiWorkspace: {
    ensureThread: (requirementId: string) =>
      request<{ threadId: string }>(`/requirements/${requirementId}/ai-thread`, { method: 'POST' }),
    sendMessage: (
      threadId: string,
      content: string,
      metadata: { contextMode: 'repo' | 'page' | 'auto' } = { contextMode: 'auto' },
    ) =>
      fetch(`${BASE}/pi/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { content }, metadata }),
      }).then((r) => {
        if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
      }),
    getWorkspace: (requirementId: string) =>
      request<WorkspaceDoc>(`/requirements/${requirementId}/ai-workspace`),
    save: (
      requirementId: string,
      body: { groupId: string; scenarioIds: string[]; caseIds: string[]; targetVersionId?: string },
    ) =>
      request<{ savedCases: number }>(`/requirements/${requirementId}/ai-workspace/save`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    setContextMode: (requirementId: string, mode: 'repo' | 'page' | 'auto') =>
      fetch(`${BASE}/requirements/${requirementId}/ai-workspace/context-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      }).then((r) => {
        if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
      }),
  },
  assistant: {
    listThreads: (versionId: string) =>
      request<AssistantThread[]>(`/assistant/threads${qs({ versionId })}`),
    /** 返回 Pi 快照;lastError=建线程时的非阻断警告(repo 不可用等)。 */
    createThread: (versionId: string) =>
      request<{ metadata: { id: string }; lastError?: string }>('/assistant/threads', {
        method: 'POST',
        body: JSON.stringify({ metadata: { versionId } }),
      }),
    confirm: (threadId: string, confirmId: string, approved: boolean) =>
      request<void>(`/assistant/threads/${threadId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ confirmId, approved }),
      }),
    /** 版本空间助手「暂存 → 落库」 */
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
          caseIdMap: Record<string, string>;
        }>(`/assistant/threads/${threadId}/stage/save`, {
          method: 'POST',
          body: JSON.stringify(body),
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
    // 项目下全部场景（跨需求汇总）。供用例页场景过滤下拉——列表不会随选中项收缩。
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
};

export interface LlmTestResult {
  ok: boolean;
  provider: string;
  latencyMs?: number;
  error?: string;
}

export interface EnvironmentObject {
  id: string;
  environmentId: string;
  objectType: 'db' | 'syslog' | 'login';
  label: string;
  /** db: { host, port, dbName, user, password?, secret? }；syslog: { host, user, sshPort, filePath, privateKey?, secret? }；
   *  login: { user, loginUrl?, password?, secret? }。
   *  出参里 secret 为 '••••••••' 掩码；入参传明文 password/privateKey，留空不覆盖旧密文。 */
  payload: Record<string, unknown>;
  /** 后端基于 DB 行加上的标志：原 payload.secret 是否存在；前端用此判定"已配置凭据"，不依赖反向解析被 mask 的 secret。 */
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
  /** 部署入口 URL：执行期导航兜底（用例.url → 分组.defaultUrl → 环境.baseUrl → 项目.defaultUrl） */
  baseUrl: string | null;
  objects: EnvironmentObject[];
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  organizationId: string;
  repoUrl: string | null;
  defaultBranch: string;
  provider: string;
  gitlabUrlOverride: string | null;
  hasPat: boolean;
  createdAt: string;
  updatedAt: string;
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
export interface Group {
  id: string;
  projectId: string;
  name: string;
  defaultUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface GroupWithCount extends Group {
  caseCount: number;
}
export interface ExecutionPlan {
  id: string;
  projectId: string;
  versionId: string | null;
  versionName?: string | null;
  name: string;
  environment: string | null;
  environmentId?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface PlanWithCount extends ExecutionPlan {
  caseCount: number;
}
export interface PlanDetail extends ExecutionPlan {
  cases: Array<{ id: string; order: number; title: string; url: string | null; versionId: string | null }>;
  strategy: 'run_all' | 'fail_fast';
  loginPrepareEnabled: boolean;
  loginCaseId: string | null;
  detectionUrl: string | null;
  loginSuccessSelector: string | null;
  loginUnauthorizedKeywords: string[] | null;
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
    order: number;
    status: string;
    stepKind: 'business' | 'login_prepare';
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    error: string | null;
  }>;
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
      createdAt: string;
    }
  | {
      kind: 'plan';
      id: string;
      planId: string;
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
    };
export interface ProjectStats {
  requirements: number;
  cases: number;
  passes: number;
  failures: number;
  groups: Array<{ id: string; name: string; caseCount: number }>;
  recentRuns: Array<{ id: string; caseId: string; status: string; createdAt: string }>;
}
export interface Requirement {
  id: string;
  title: string;
  content: string;
  status: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
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
  scenarioId?: string | null;
  scenarioTitle?: string | null;
  tags?: Tag[];
  versionId?: string;
  versionName?: string;
  createdAt?: string;
  updatedAt?: string;
  windowStrategy?: string;
  windowWidth?: number | null;
  windowHeight?: number | null;
  incognito?: boolean;
  defaultEnvId?: string | null;
  datasetId?: string | null;
  /** Track 1：用例级预期描述（自然语言）。回放结束后由 vision LLM 拿最终截图判定。 */
  expectedOutcome?: string | null;
}
export interface Scenario {
  id: string;
  requirementId: string;
  title: string;
  description: string | null;
  order: number;
  createdAt: string;
}
export interface AssistantThread {
  id: string;
  title: string | null;
  status: 'running' | 'idle';
  createdAt?: string;
  updatedAt?: string;
}
// 版本空间助手暂存表（thread-scoped）单对象形态
export interface StagedStageCase {
  localId: string;
  title: string;
  description: string | null;
  priority: string | null;
  url: string | null;
  steps: Array<{ action: string; assertion?: string | null; compiled?: unknown[] | null }>;
  defaultEnvId: string | null;
  expectedOutcome: string | null;
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
  objectType: 'db' | 'syslog' | 'login';
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
export interface StageDoc {
  cases: StagedStageCase[];
  scenarios: StagedStageScenario[];
  environments: StagedEnvironment[];
  plans: StagedPlan[];
  caseOps: StageCaseOp[];
}
export interface StageSaveBody {
  cases: Array<{ localId: string; groupId: string }>;
  scenarios: Array<{ localId: string }>;
  environments: Array<{ localId: string }>;
  plans: Array<{ localId: string; groupId: string }>;
  caseOps: Array<{ localId: string }>;
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
  /** 2026-10-06：行级自然语言；人看/给 LLM 起手；回放不读。
   *  2026-10-07：取代旧 name 列(已彻底移除读写),自然语言完整说明都存这里。 */
  instruction?: string | null;
  /** 2026-10-06：可执行 DSL 数组 StepAction[]；回放唯一依据。空数组/null = 未编译。
   *  2026-10-07：老 action 列已 DROP,DSL 只住这里。 */
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
  createdAt: string;
}
export interface DatasetSaveBody {
  name: string;
  description?: string | null;
  columns: Array<{ name: string; sensitive?: boolean }>;
  rows: Array<{ disabled?: boolean; cells: Record<string, unknown> }>;
  /** 列改名声明（旧列名 → 新列名）：让服务端把旧列密文 re-key 到新列名（编辑已有数据集时）。 */
  renames?: Record<string, string>;
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
}
export interface DatasetMaskedCell { __masked: true }
/** 详情/新建/编辑出参：原始行字段 + 掩码 rows（与 Summary 不同，不含 rowCount/enabledRowCount 统计）。 */
export interface DatasetDetail {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  columns: Array<{ name: string; sensitive: boolean }>;
  rows: Array<{ disabled: boolean; cells: Record<string, string | DatasetMaskedCell> }>;
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

// ---------- 认证与组织 ----------

/** 脱敏后的当前用户（不含 passwordHash）。 */
export interface SafeUser {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

/** 登录成功 → 自动已登录；否则进入首登强制改密流程（passwordChangeToken 一次性、5 分钟有效）。 */
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

/** 组织列表项（可见组织：自己加入的 ∪ 管理的子树）。 */
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

/** 分页返回形状，与后端 design-systems / users 等接口一致 */
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

export interface OrgProjectSummary {
  id: string;
  name: string;
  description: string | null;
  organizationId: string;
  repoUrl: string | null;
  assignedCount: number;
}

export interface VerifyRepoResult {
  valid: boolean;
  error?: string;
  branchExists?: boolean;
  defaultBranch?: string;
}

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type CompiledAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; locator: Array<{ strategy: string; value: string }> }
  | { kind: 'fill'; locator: Array<{ strategy: string; value: string }>; value: unknown }
  | { kind: 'waitFor'; locator: Array<{ strategy: string; value: string }> }
  | { kind: 'assertText'; target?: string; equals?: string; contains?: string }
  | { kind: 'assertVisible'; locator: Array<{ strategy: string; value: string }> }
  | { kind: 'check'; locator: Array<{ strategy: string; value: string }>; checked: boolean }
  | { kind: 'select'; locator: Array<{ strategy: string; value: string }>; value: string }
  | { kind: 'hover'; locator: Array<{ strategy: string; value: string }> }
  | { kind: 'screenshot'; name: string }
  | { kind: 'switchTab'; tabRef: string }
  | { kind: 'extract'; varName: string; mode?: string; pattern?: string }
  | { kind: string; [k: string]: unknown };

export interface StagedStep {
  name: string;
  action: string;
  assertion: string | null;
  /** 三态：undefined = 未尝试（保存时由后端兜底编译）；null = AI 已放弃；array = 已编译 */
  compiled?: CompiledAction[] | null;
}
export interface StagedAiCase { id: string; title: string; description: string | null; priority: Priority; steps: StagedStep[]; }
export interface StagedAiScenario { id: string; title: string; description: string | null; cases: StagedAiCase[]; }
export interface StagedStageCase { localId: string; title: string; description: string | null; priority: string | null; url: string | null; steps: Array<{ action: string; assertion?: string | null; compiled?: unknown[] | null }>; defaultEnvId: string | null; expectedOutcome: string | null; stagedAt: string; }
// 兼容旧名（ai-workspace/WorkspacePanel 仍引用 StagedCase/StagedScenario；语义与本页无关）
export type StagedCase = StagedAiCase;
export type StagedScenario = StagedAiScenario;
export interface RepoContext { commit: string; fetchedAt: string; mode: 'repo' | 'auto'; }
export interface WorkspaceDoc {
  plan: { scenarios: number; cases: number } | null;
  contextMode?: 'repo' | 'page' | 'auto';
  pageContext?: { url: string; fetchedAt: string } | null;
  repoContext?: RepoContext | null;
  scenarios: StagedScenario[];
  looseCases: StagedCase[];
}
