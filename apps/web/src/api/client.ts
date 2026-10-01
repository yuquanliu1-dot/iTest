const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
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
      body: Partial<{ title: string; priority: string; description: string; groupId: string; url: string }>,
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
  secrets: {
    fetch: (caseId: string, stepId: string, token: string) =>
      request<{ plaintext: string }>(
        `/cases/${caseId}/steps/secrets/${stepId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
  },
};

export interface Project {
  id: string;
  name: string;
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
