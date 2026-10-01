const BASE = '/api';

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
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
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
    create: (body: { name: string; defaultUrl?: string }) =>
      request<Project>('/projects', { method: 'POST', body: JSON.stringify(body) }),
    patch: (id: string, body: Partial<{ name: string; defaultUrl: string }>) =>
      request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
    groups: (id: string) => request<GroupWithCount[]>(`/projects/${id}/groups`),
    createGroup: (id: string, body: { name: string; defaultUrl?: string }) =>
      request<Group>(`/projects/${id}/groups`, { method: 'POST', body: JSON.stringify(body) }),
    stats: (id: string) => request<ProjectStats>(`/projects/${id}/stats`),
    plans: (id: string) => request<PlanWithCount[]>(`/projects/${id}/plans`),
    createPlan: (id: string, body: { name: string; environment?: string }) =>
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
    list: (params?: string | { priority?: string; groupId?: string; projectId?: string }) => {
      const p = typeof params === 'string' ? { priority: params } : params;
      const qs = new URLSearchParams();
      if (p?.priority) qs.set('priority', p.priority);
      if (p?.groupId) qs.set('groupId', p.groupId);
      if (p?.projectId) qs.set('projectId', p.projectId);
      const s = qs.toString();
      return request<TestCase[]>(`/cases${s ? `?${s}` : ''}`);
    },
    create: (body: { title: string; priority?: string; requirementId?: string; groupId: string; url?: string }) =>
      request<TestCase>('/cases', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<TestCaseDetail>(`/cases/${id}`),
    patch: (
      id: string,
      body: Partial<{
        title: string;
        priority: string;
        description: string;
        groupId: string;
        url: string;
        windowStrategy: string;
        windowWidth: number;
        windowHeight: number;
        incognito: boolean;
      }>,
    ) => request<TestCase>(`/cases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/cases/${id}`, { method: 'DELETE' }),
    copy: (id: string, targetGroupId: string) =>
      request<TestCase>(`/cases/${id}/copy`, { method: 'POST', body: JSON.stringify({ targetGroupId }) }),
    copyBatch: (caseIds: string[], targetGroupId: string) =>
      request<{ count: number }>('/cases/copy', {
        method: 'POST',
        body: JSON.stringify({ caseIds, targetGroupId }),
      }),
    appendSteps: (id: string, steps: Array<{ order: number; source: string; action: unknown }>) =>
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
      steps: Array<{ action: unknown; source: string; name?: string; delayMs?: number }>,
    ) =>
      request<{ steps: TestStep[]; failedAi: number; variableReport?: VariableReport }>(`/cases/${id}/steps`, {
        method: 'PUT',
        body: JSON.stringify({ steps }),
      }),
    recompileStep: (id: string, instruction: string) =>
      request<{ compiled: import('@itest/shared').StepAction[] | null }>(
        `/cases/${id}/steps/recompile`,
        {
          method: 'POST',
          body: JSON.stringify({ instruction }),
        },
      ),
    compileExtract: (caseId: string, body: { description: string; sampleText: string }) =>
      request<{ pattern: string | null; group: number; error?: string }>(
        `/cases/${caseId}/steps/extract/compile`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    execute: (id: string) =>
      request<{ reportId: string }>(`/cases/${id}/execute`, { method: 'POST' }),
  },
  reports: {
    list: (projectId?: string) =>
      request<Report[]>(`/reports${projectId ? `?projectId=${projectId}` : ''}`),
    get: (id: string) => request<Report>(`/reports/${id}`),
  },
  agentRuns: {
    create: (body: { targetType: string; targetId: string; prompt: string; targetGroupId?: string }) =>
      request<AgentRun>('/agent-runs', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<AgentRun>(`/agent-runs/${id}`),
    eventsUrl: (id: string) => `${BASE}/agent-runs/${id}/events`,
  },
  recorder: {
    createSession: (
      caseId: string,
      opts?: { mode?: 'fresh' | 'append' | 'resume' | 'incognito'; incognito?: boolean; resumeFromOrder?: number },
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
    members: (orgId: string) => request<{ items: MemberRow[] }>(`/organizations/${orgId}/members`),
    addMember: (orgId: string, body: { username: string; isManager?: boolean; isUser?: boolean }) =>
      request<{ ok: boolean }>(`/organizations/${orgId}/members`, { method: 'POST', body: JSON.stringify(body) }),
    updateMember: (orgId: string, userId: string, body: { isManager?: boolean; isUser?: boolean }) =>
      request<{ ok: boolean }>(`/organizations/${orgId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    removeMember: (orgId: string, userId: string) =>
      request<{ ok: boolean }>(`/organizations/${orgId}/members/${userId}`, { method: 'DELETE' }),
  },
  aiWorkspace: {
    ensureThread: (requirementId: string) =>
      request<{ threadId: string }>(`/requirements/${requirementId}/ai-thread`, { method: 'POST' }),
    getWorkspace: (requirementId: string) =>
      request<WorkspaceDoc>(`/requirements/${requirementId}/ai-workspace`),
    save: (requirementId: string, body: { groupId: string; scenarioIds: string[]; caseIds: string[] }) =>
      request<{ savedCases: number }>(`/requirements/${requirementId}/ai-workspace/save`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
  secrets: {
    fetch: (caseId: string, stepId: string, token: string) =>
      request<{ plaintext: string }>(
        `/cases/${caseId}/steps/secrets/${stepId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
  },
};

export interface LlmTestResult {
  ok: boolean;
  provider: string;
  latencyMs?: number;
  error?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  organizationId: string;
  defaultUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectWithCount extends Project {
  caseCount: number;
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
  name: string;
  environment: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface PlanWithCount extends ExecutionPlan {
  caseCount: number;
}
export interface PlanDetail extends ExecutionPlan {
  cases: Array<{ id: string; order: number; title: string; url: string | null }>;
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
    reportId: string | null;
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
      status: string;
      durationMs: number | null;
      summary: string | null;
      createdAt: string;
    }
  | {
      kind: 'plan';
      id: string;
      planId: string;
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
export interface TestCase {
  id: string;
  title: string;
  priority: string;
  status: string;
  groupId?: string;
  url?: string | null;
  requirementId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  windowStrategy?: string;
  windowWidth?: number | null;
  windowHeight?: number | null;
  incognito?: boolean;
}
export interface TestStep {
  id: string;
  order: number;
  source: string;
  action: unknown;
  name?: string | null;
  delayMs?: number | null;
  tabRef?: string | null;
  componentKind?: string | null;
  sensitive?: boolean;
}
export interface TestCaseDetail extends TestCase {
  description?: string;
  steps: TestStep[];
  resolvedUrl: string | null;
}
export interface Report {
  id: string;
  caseId: string;
  status: string;
  durationMs: number | null;
  stepResults: unknown;
  summary: string | null;
  createdAt: string;
}
export interface AgentRun {
  id: string;
  targetType: string;
  targetId: string;
  status: string;
  prompt: string;
  result: unknown;
  error: string | null;
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

export interface MemberRow {
  userId: string;
  username: string;
  displayName: string;
  isManager: boolean;
  isUser: boolean;
  joinedAt: string;
}

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export interface StagedStep { name: string; action: string; assertion: string | null; }
export interface StagedCase { id: string; title: string; description: string | null; priority: Priority; steps: StagedStep[]; }
export interface StagedScenario { id: string; title: string; description: string | null; cases: StagedCase[]; }
export interface WorkspaceDoc {
  plan: { scenarios: number; cases: number } | null;
  scenarios: StagedScenario[];
  looseCases: StagedCase[];
}
