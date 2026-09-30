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
  requirements: {
    list: () => request<Requirement[]>('/requirements'),
    create: (body: { title: string; content: string }) =>
      request<Requirement>('/requirements', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<Requirement>(`/requirements/${id}`),
  },
  cases: {
    list: (priority?: string) =>
      request<TestCase[]>(`/cases${priority ? `?priority=${priority}` : ''}`),
    create: (body: { title: string; priority?: string; requirementId?: string }) =>
      request<TestCase>('/cases', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<TestCaseDetail>(`/cases/${id}`),
    patch: (id: string, body: Partial<{ title: string; priority: string; description: string }>) =>
      request<TestCase>(`/cases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    appendSteps: (id: string, steps: Array<{ order: number; source: string; action: unknown }>) =>
      request<{ count: number }>(`/cases/${id}/steps`, {
        method: 'POST',
        body: JSON.stringify({ steps }),
      }),
    reorderSteps: (id: string, stepIds: string[]) =>
      request<{ steps: TestStep[] }>(`/cases/${id}/steps/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ stepIds }),
      }),
    deleteStep: (id: string, stepId: string) =>
      request<{ ok: boolean }>(`/cases/${id}/steps/${stepId}`, { method: 'DELETE' }),
    execute: (id: string) =>
      request<{ reportId: string }>(`/cases/${id}/execute`, { method: 'POST' }),
  },
  reports: {
    list: () => request<Report[]>('/reports'),
    get: (id: string) => request<Report>(`/reports/${id}`),
  },
  agentRuns: {
    create: (body: { targetType: string; targetId: string; prompt: string }) =>
      request<AgentRun>('/agent-runs', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<AgentRun>(`/agent-runs/${id}`),
    eventsUrl: (id: string) => `${BASE}/agent-runs/${id}/events`,
  },
  recorder: {
    createSession: (caseId: string) =>
      request<{ sessionId: string; wsUrl: string; wsToken: string }>('/recorder/sessions', {
        method: 'POST',
        body: JSON.stringify({ caseId }),
      }),
    finish: (sessionId: string) =>
      request<{ inserted: number }>(`/recorder/sessions/${sessionId}/finish`, { method: 'POST' }),
  },
};

export interface Requirement {
  id: string;
  title: string;
  content: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}
export interface TestCase {
  id: string;
  title: string;
  priority: string;
  status: string;
  requirementId?: string;
}
export interface TestStep {
  id: string;
  order: number;
  source: string;
  action: unknown;
}
export interface TestCaseDetail extends TestCase {
  description?: string;
  steps: TestStep[];
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