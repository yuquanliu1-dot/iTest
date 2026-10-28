const BASE = '/api';

/** 带 HTTP 状态码的请求错误；调用方可据此区分 404（不存在/不可见）等确定性失败。 */
export class ApiError extends Error {
  status: number;
  /** 后端稳定错误码(errorHandler 里 HttpError.code / 校验与冲突兜底码)。无码时为 undefined。 */
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
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
    throw new ApiError(res.status, body.message ?? `HTTP ${res.status}`, typeof body?.error === 'string' ? body.error : undefined);
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
    /** versionIds = 当前范围内的版本集合（当前版本范围传 [versionId]，产品线范围传选中的版本），分组计数随之收窄。 */
    groups: (id: string, versionIds: string[] = []) =>
      request<GroupWithCount[]>(
        `/projects/${id}/groups${versionIds.length ? `?versionIds=${versionIds.join(',')}` : ''}`,
      ),
    /** 产品线下的全部分组（跨项目选用例池按分组筛选用；一次请求覆盖线内所有项目）。 */
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
    /** 移动产品线到另一个组织：线内全部项目跟着换组织，标签一并迁移。 */
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
    createGroup: (id: string, body: { name: string; environmentId?: string | null; failFast?: boolean }) =>
      request<PlanCaseGroup>(`/plans/${id}/groups`, { method: 'POST', body: JSON.stringify(body) }),
    patchGroup: (id: string, groupId: string, body: Partial<{ name: string; environmentId: string | null; failFast: boolean; loginPrepare: { enabled: boolean; caseId: string | null; detectionUrl: string | null; successSelector: string | null; unauthorizedKeywords: string[] | null }; targetConfig: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null }>) =>
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
    /** 校验远端 branch/tag 是否存在（ref 弹窗「测试」）。valid=false 时 error 给原因。 */
    verifyRef: (projectId: string, body: { ref: string; kind: 'branch' | 'tag' }) =>
      request<{ valid: boolean; error?: string }>(`/projects/${projectId}/verify-ref`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
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
    list: (params?: {
      projectId?: string;
      /** 产品线执行库：跨项目拉整条线的用例报告 + 计划运行（与 projectId 二选一） */
      productLineId?: string;
      kind?: 'case' | 'plan' | 'all';
      statuses?: string[];
      versionIds?: string[];
      q?: string;
      /** 单用例深链：只看该用例的执行报告 */
      caseId?: string;
      /** 单计划深链：只看该计划的运行历史 */
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
        /** 数据集行选择：启用行下标数组。[] = 所有启用行；null = 清空选择。 */
        datasetRowIndexes?: number[] | null;
        /** 需求编号（外部编号自由文本）。空字符串由调用方转 null。 */
        requirementNo: string | null;
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
    /** 批量后端固化（全未固化用例 NL→DSL + 机械验收）。全部被拒 → 422 {batchId:null, rejected}；
     *  部分被拒 → 200 + rejected 清单（前端 toast）。 */
    batchSolidify: (caseIds: string[]) =>
      request<{ batchId: string | null; accepted: string[]; rejected: Array<{ caseId: string; reason: string }> }>(
        '/cases/batch-solidify',
        { method: 'POST', body: JSON.stringify({ caseIds }) },
      ),
    /** 批量固化进度轮询（行状态 + 读时派生的批量汇总）。 */
    solidifyBatch: (id: string) => request<SolidifyBatchStatus>(`/cases/solidify-batches/${id}`),
    /** 在途批次列表（分组页顶部横幅 + 行内「固化中」徽标的数据源）。 */
    solidifyBatches: (projectId?: string) =>
      request<SolidifyBatchesOverview>(`/cases/solidify-batches${projectId ? `?projectId=${projectId}` : ''}`),
    updateStatusBatch: (caseIds: string[], status: CaseStatus) =>
      request<{ count: number }>('/cases/batch-status', {
        method: 'POST',
        body: JSON.stringify({ caseIds, status }),
      }),
    /** 导出 XMind：fetch → blob（request<T> 走 JSON 解析，二进制单独走 fetch，同 downloadExtensionZip）。 */
    exportXmind: async (caseIds: string[], rootTitle?: string): Promise<{ blob: Blob; filename: string }> => {
      const r = await fetch(`${BASE}/cases/export-xmind`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseIds, ...(rootTitle ? { rootTitle } : {}) }),
      });
      if (!r.ok) {
        if (r.status === 401) throw new ApiError(401, '未登录或会话已过期');
        const body = await r.json().catch(() => ({}));
        throw new ApiError(r.status, body.message ?? `HTTP ${r.status}`);
      }
      const dispo = r.headers.get('Content-Disposition') ?? '';
      const m = dispo.match(/filename\*=UTF-8''([^;]+)/);
      const filename = m ? decodeURIComponent(m[1]!) : 'cases.xmind';
      return { blob: await r.blob(), filename };
    },
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
    /** 当前部署的扩展版本：徽标拿它与「已装版本」对比，检测出可升级更新。 */
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
  /** 浏览器原生下载：fetch → blob → `<a download>`，不走 JSON 解析。
   *  与 request() 不同：401 不会自动跳登录（保持与原始 `<a>` 一致），调用方按需处理。 */
  downloadExtensionZip: async (): Promise<Blob> => {
    const r = await fetch(`${BASE}/recorder/extension.zip`, { credentials: 'same-origin' });
    if (!r.ok) {
      if (r.status === 401) throw new ApiError(401, '未登录或会话已过期');
      const body = await r.json().catch(() => ({}));
      throw new ApiError(r.status, body.message ?? `HTTP ${r.status}`);
    }
    return r.blob();
  },
  /** AI 产出文件下载（artifact 下载卡）：fetch → blob，request<T> 走 JSON 解析故二进制单独走 fetch。 */
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
  /** 某线程的持久产物列表（skill 生成文档等）。切换会话时拉取，把下载卡灌回界面。 */
  listArtifacts: (threadId: string) =>
    request<Array<{ token: string; name: string; mime: string; size: number; count: number | null; createdAt: string }>>(
      `/assistant/threads/${threadId}/artifacts`,
    ),
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
    /** 线程列表(分页):后端按 (updatedAt,id) 全序 keyset 取数并过滤无 session 文件的草稿行,
     *  cursor 回传上一页最后一行的线程 id。左栏分组与 react-pi runtime 的列表都走这份。
     *  workspacePath ≡ versionId(见 SpaceWorkspace 的 Props 注释)。 */
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
    /** 推荐追问:AI 回答落定后按需拉取(POST 触发一次轻量 LLM 调用,返回提示词字符串数组)。 */
    suggestions: (threadId: string) =>
      request<string[]>(`/assistant/threads/${threadId}/suggestions`, { method: 'POST' }),
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
          savedDatasets: number;
          caseIdMap: Record<string, string>;
          datasetIdMap: Record<string, string>;
        }>(`/assistant/threads/${threadId}/stage/save`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
    },
    /** 用户对 AI 回复的反馈（Phase 1 只收集）。messageExcerpt 是回溯的唯一可靠依据，
     *  messageAnchor 只是位置索引线索、会随流式漂移——消费反馈时别把 anchor 当主键。 */
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
      /** 当前用户在该线程下已提交的反馈，用于气泡「已提交」标记。 */
      mine: (threadId: string) =>
        request<Array<{
          id: string;
          messageAnchor: string | null;
          messageIndex: number | null;
          sentiment: 'positive' | 'negative';
          createdAt?: string;
        }>>(`/assistant/feedback${qs({ threadId })}`),
      /** 管理端全量列表（requireManager）。messageExcerpt 是回溯的唯一可靠依据。 */
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
      /** 筛选用的候选项目（与列表同可见性口径）。 */
      listProjects: () =>
        request<Array<{ id: string; name: string }>>('/assistant/feedback/projects'),
    },
    /** 系统设置：全局共享 MCP server（scope 固定 global）。 */
    mcpServers: {
      list: () => request<AssistantMcpServer[]>('/assistant/mcp-servers'),
      create: (body: { name: string; kind: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; exposure?: string; enabled?: boolean }) =>
        request<AssistantMcpServer>('/assistant/mcp-servers', { method: 'POST', body: JSON.stringify(body) }),
      patch: (id: string, body: Partial<{ name: string; command: string; args: string[]; url: string; exposure: string; enabled: boolean }>) =>
        request<AssistantMcpServer>(`/assistant/mcp-servers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
      remove: (id: string) =>
        request<void>(`/assistant/mcp-servers/${id}`, { method: 'DELETE' }),
    },
    /** 系统设置：全局共享 AI 技能。DB 存 name/description/enabled；内容在服务端目录树。
     *  所有文件接口都以 skill id 定位（顶层路径段由服务端从 DB 行解析），且一律走服务端
     *  resolveInSkill 守卫——客户端不传目录名，越界/软链在服务端拒。 */
    skills: {
      list: () => request<AssistantSkill[]>('/assistant/skills'),
      create: (body: { name: string; description: string; enabled?: boolean }) =>
        request<AssistantSkill>('/assistant/skills', { method: 'POST', body: JSON.stringify(body) }),
      patch: (id: string, body: Partial<{ name: string; description: string; enabled: boolean }>) =>
        request<AssistantSkill>(`/assistant/skills/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
      remove: (id: string) =>
        request<void>(`/assistant/skills/${id}`, { method: 'DELETE' }),
      /** 删磁盘孤儿目录（id=null 的行够不着 :id 系列接口，只能按 name 删）。
       *  已登记的技能走这条会 409——要删它们请用 remove(id)。 */
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
      /** 上传到【已存在】的目录 dir（传 '' 即技能根）。服务端不递归建目录。 */
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

/** 创建人/执行人摘要：后端各 list/detail 序列化统一追加；历史存量或用户已删时为 null。 */
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
  /** db: { host, port, dbName, user, password?, secret? }；syslog: { host, user, sshPort, filePath, privateKey?, secret? }；
   *  web: { name?, scheme, host, port?, user?, loginUrl?, password?, secret? }（0041 起 web 内嵌应用登录凭据）。
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
  /** 归属产品线（可空 = 未归线）。产品线内项目之间可跨项目共享用例。 */
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
  /** 运行结束后对失败用例自动做 AI 根因分析 */
  rcaEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: Creator | null;
}
export interface PlanWithCount extends ExecutionPlan {
  caseCount: number;
}
/** 计划分组：每组独立配置环境/登录准备/failFast/浏览器上下文，组内用例有序。 */
export interface PlanCaseGroup {
  id: string;
  name: string;
  order: number;
  environmentId: string | null;
  loginPrepareEnabled: boolean;
  loginCaseId: string | null;
  detectionUrl: string | null;
  loginSuccessSelector: string | null;
  loginUnauthorizedKeywords: string[] | null;
  failFast: boolean;
  targetConfig: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null;
  cases: Array<{ planCaseId: string; id: string; order: number; title: string; url: string | null; versionId: string | null; versionName: string | null; projectId: string | null; projectName: string | null }>;
}
export interface PlanDetail extends ExecutionPlan {
  /** 平铺口径：按组序拼接（order=组内序、globalOrder=全局 1..N），供计数与跨组去重标显示。 */
  cases: Array<{ planCaseId: string; id: string; order: number; globalOrder: number; title: string; url: string | null; versionId: string | null; versionName: string | null; projectId: string | null; projectName: string | null }>;
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
    /** 所属计划分组（老运行为 null）。 */
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
    /** AI 根因分析结果（仅失败行有值） */
    rca?: RcaResult | null;
    /** 最后断言结论：vision 判定 reason 或失败步 error；无报告/未断言为 null。 */
    lastAssertion?: string | null;
  }>;
  /** 触发人（=计划运行的执行人）。 */
  triggeredBy?: Creator | null;
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
      /** 最后断言信息：vision 判定 reason 或失败步 error；无断言为 null。 */
      lastAssertion?: string | null;
      /** 自愈通过标记：passed 且 aiTask 缓存分叉后 AI 自愈成功。 */
      healed?: boolean;
      /** 数据集批次 id（同一次数据集执行的全部行共用）；非数据集执行为 null。 */
      datasetBatchId?: string | null;
      /** 本条记录代表的批内成员数（非数据集执行 = 1）。 */
      batchSize?: number;
      /** 批内通过 / 失败成员数（按全批真实值算，不受筛选影响）。 */
      batchPassed?: number;
      batchFailed?: number;
      /** 批内全部成员报告 id（批量删除时展开成 N 条 report 删除）。 */
      memberReportIds?: string[];
      createdAt: string;
      /** 执行人（报告创建人 = 触发执行者）。 */
      createdBy?: Creator | null;
    }
  | {
      kind: 'plan';
      id: string;
      planId: string;
      /** 所属计划名（计划被删后 innerJoin 落空不会出现该行，理论非空）。 */
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
  /** 需求编号（外部编号自由文本，非 requirements FK）。 */
  requirementNo?: string | null;
  scenarioId?: string | null;
  scenarioTitle?: string | null;
  tags?: Tag[];
  versionId?: string;
  versionName?: string;
  /** 所属项目（列表接口按产品线跨项目拉齐时回带，供「跨项目」徽标与按项目筛选）。 */
  projectId?: string | null;
  projectName?: string | null;
  createdAt?: string;
  updatedAt?: string;
  windowStrategy?: string;
  windowWidth?: number | null;
  windowHeight?: number | null;
  incognito?: boolean;
  defaultEnvId?: string | null;
  /** 环境 web 服务对象名（payload.name）；空 → 用环境默认 web 服务拼相对 URL。 */
  webServiceRef?: string | null;
  datasetId?: string | null;
  /** 数据集行选择：启用行下标数组（0 基，剔除禁用行后重新编号）。
   *  [] = 所有启用行（= 服务端 test_cases.dataset_row_indexes 同语义）。 */
  datasetRowIndexes?: number[];
  /** Track 1：用例级预期描述（自然语言）。回放结束后由 vision LLM 拿最终截图判定。 */
  expectedOutcome?: string | null;
  platform?: 'web' | 'mobile';
  mobileOs?: 'ios' | 'android' | null;
  mobileDeviceTargetId?: string | null;
  appRef?: { bundleId: string; appPath?: string; launchArgs?: string[] } | null;
  createdBy?: Creator | null;
  /** 步骤固化进度（列表接口回填）：total=步骤数，compiled=已固化步骤数。 */
  stepsTotal?: number;
  stepsCompiled?: number;
}
/** 批量固化批次进度（GET /cases/solidify-batches/:id）。status 读时派生：
 *  有 running 行 = running；否则全过 = passed、全败 = failed、混合 = partial。 */
export interface SolidifyBatchStatus {
  batchId: string;
  status: 'running' | 'passed' | 'failed' | 'partial';
  total: number;
  passed: number;
  failed: number;
  running: number;
  cases: Array<{ caseId: string; title: string; status: string; error: string | null }>;
}
/** 在途批量固化批次（GET /cases/solidify-batches）：只返回还有 running 行的批次。
 *  批次全部出终态后自动从列表消失（横幅消失、徽标变回 n/N）。 */
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
/** 系统设置里管理的全局共享 MCP server（平台级，scope=global）。 */
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
/** 系统设置里管理的全局共享 AI 技能（assistant_skills 表）。
 *  2026-10-19 存储翻转：DB 只留元数据，内容在服务端目录树 SKILLS_ROOT/<name>/，
 *  由下方 tree/readFile/writeFile/deleteFile/uploadFiles 操作。 */
export interface AssistantSkill {
  /** 孤儿目录（磁盘有目录但 DB 无行）没有 id，仅供展示/删除，不允许改元数据。 */
  id: string | null;
  name: string;
  description: string;
  enabled: boolean;
  /** 磁盘统计（递归树数出来的文件数与字节数）。 */
  fileCount: number;
  totalBytes: number;
  onDisk: boolean;
  /** true = 磁盘孤儿目录：未登记、无 description，入不了 catalog。 */
  unregistered: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}
/** 文件树节点（相对技能根，posix 分隔）。 */
export interface AssistantSkillFileNode {
  path: string;
  kind: 'file' | 'dir';
  size: number;
  runtime?: string;
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
  /** 配套数据集 localId（同批 stage_dataset 生成；保存时数据集先落库并自动绑定）。 */
  datasetLocalId: string | null;
  /** 本条声明覆盖的测试类型（COVERAGE_TYPE_KEYS 子集）；暂存区用来一眼看覆盖分布。 */
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
/** AI 生成的数据集草稿：rows 为明文（敏感列落库时才加密），预览对用户可见。 */
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
  /** 数据集批次 id：同一次执行的 N 行共用；老报告为 null（行切换器不渲染）。 */
  datasetBatchId?: string | null;
  platform?: 'web' | 'mobile';
  mobileOs?: 'ios' | 'android' | null;
  deviceName?: string | null;
  deviceTargetId?: string | null;
  /** 自愈通过标记：passed 且 aiTask 缓存分叉后 AI 自愈成功；failed 恒 false。 */
  healed?: boolean;
  /** 真实执行阶段起止时刻（老报告为 null）。startedAt = 开始跑步骤的时刻，与 durationMs 同基线。 */
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  /** 计划运行成员报告：附带来源（后端从 plan_run_cases 查得）。返回按钮据此切到「返回计划运行」 */
  planRunId?: string | null;
  planId?: string | null;
  /** AI 根因分析结果（属于 plan_run_cases 且已分析时有值） */
  rca?: RcaResult | null;
  /** 执行人 = 报告创建人（触发执行者）。 */
  createdBy?: Creator | null;
}
/** 数据集批次：同批兄弟行摘要（行切换器轮询用，不含步骤明细）。 */
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
  createdBy?: Creator | null;
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

// ---------- 认证与组织 ----------

/** 脱敏后的当前用户（不含 passwordHash）。 */
export interface SafeUser {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  /** UI 语言偏好;PATCH /users/:id 可写,当前 /auth/me 尚未返回时为 undefined。 */
  languagePreference?: 'zh-CN' | 'en-US' | null;
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

/** 组织视图下的产品线：产品线已完全替代「组织下的项目」这个位置。 */
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
