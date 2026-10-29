/**
 * 用例/分组领域服务:HTTP 路由与空间 AI 工具共用。
 * 这里只做数据完整性与归属校验(实体 ∈ project/version/org);
 * 用户可见性(assertProjectVisible 等)由调用方(HTTP 边界)负责。
 */
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { caseTags, datasets, groups, planCases, planCaseGroups, productLines, projects, projectVersions, scenarios, tags, testCases, testSteps } from '../db/schema.js';
import type { AppRef } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { resolveDatasetProjectId, resolveDeviceTargetProjectId, resolveEnvironmentProjectId, resolveVersionProjectId } from './projectAccess.js';
import { assertDatasetRowIndexes } from './datasets.service.js';
import { migrateAssertion, sanitizeAssertion } from '../lib/step-migration.js';
import { attachCreator } from '../lib/creator.js';
import { cache } from '../lib/cache.js';
import { casesForProjectKey } from '../lib/cache-keys.js';

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const STATUSES = ['draft', 'review', 'ready', 'deprecated'];

export async function groupProjectId(groupId: string): Promise<string | null> {
  const row = (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, groupId)).limit(1))[0];
  return row?.projectId ?? null;
}

/** 用例列表缓存(GET /cases?projectId=)失效入口。projectId 为空静默跳过(实体已不存在)。 */
export async function invalidateCasesCache(projectId: string | null | undefined): Promise<void> {
  if (!projectId) return;
  await cache.del(casesForProjectKey(projectId));
}

/** 按 caseId 解析所属项目后失效列表缓存;case 不存在静默跳过。 */
export async function invalidateCasesCacheForCase(caseId: string): Promise<void> {
  const row = (await db.select({ groupId: testCases.groupId }).from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!row) return;
  await invalidateCasesCache(await groupProjectId(row.groupId));
}

/** 校验 tagIds 都属于 projectId 所属组织;缺失 404,跨组织 400。 */
export async function assertTagsBelongToOrg(tagIds: string[], projectId: string): Promise<void> {
  if (tagIds.length === 0) return;
  // 项目的组织由产品线推导（projects 已无 organization_id 列）。
  const [proj] = await db
    .select({ organizationId: productLines.organizationId })
    .from(projects)
    .innerJoin(productLines, eq(productLines.id, projects.productLineId))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!proj) throw new HttpError(404, 'not_found', 'project not found');
  const rows = await db.select({ id: tags.id, organizationId: tags.organizationId }).from(tags).where(inArray(tags.id, tagIds));
  const found = new Set(rows.map((r) => r.id));
  for (const id of tagIds) {
    if (!found.has(id)) throw new HttpError(404, 'not_found', `tag ${id} not found`);
  }
  const wrong = rows.filter((t) => t.organizationId !== proj.organizationId);
  if (wrong.length > 0) throw new HttpError(400, 'tag_org_mismatch', 'tag belongs to another organization');
}

/** 批量取出 caseIds 关联的所有 tag,按 caseId 分组。空集合返回空 Map。 */
export async function tagsForCases(caseIds: string[]): Promise<Map<string, Array<{ id: string; name: string; color: string }>>> {
  const map = new Map<string, Array<{ id: string; name: string; color: string }>>();
  if (caseIds.length === 0) return map;
  const rows = await db
    .select({ caseId: caseTags.caseId, id: tags.id, name: tags.name, color: tags.color })
    .from(caseTags)
    .innerJoin(tags, eq(tags.id, caseTags.tagId))
    .where(inArray(caseTags.caseId, caseIds));
  for (const r of rows) {
    const arr = map.get(r.caseId) ?? [];
    arr.push({ id: r.id, name: r.name, color: r.color });
    map.set(r.caseId, arr);
  }
  return map;
}

function assertWindowCustom(v: { windowStrategy?: string; windowWidth?: number | null; windowHeight?: number | null }): void {
  if (v.windowStrategy === 'custom' && (!v.windowWidth || !v.windowHeight)) {
    throw new HttpError(400, 'window_required', 'windowWidth and windowHeight are required when windowStrategy is custom');
  }
}

function assertEnum(name: 'priority' | 'status', value: string, allowed: string[]): void {
  if (!allowed.includes(value)) throw new HttpError(400, `bad_${name}`, `invalid ${name}: ${value}`);
}

export interface CreateCaseInput {
  groupId: string;
  versionId: string;
  title: string;
  description?: string | null;
  priority?: string;
  url?: string | null;
  webServiceRef?: string | null;
  windowStrategy?: string;
  windowWidth?: number | null;
  windowHeight?: number | null;
  incognito?: boolean;
  requirementId?: string | null;
  /** 需求编号（外部编号自由文本，非 requirements FK）。AI 生成路径由 stage_case 带下来。 */
  requirementNo?: string | null;
  scenarioId?: string | null;
  tagIds?: string[];
  expectedOutcome?: string | null;
  /** 本条覆盖的测试类型（COVERAGE_TYPE_KEYS 子集）；AI 生成路径由 stage_case 带下来。 */
  coverageTypes?: string[];
  /** 绑定数据集（space-assistant stage 保存路径：数据集先落库再回填）。 */
  datasetId?: string | null;
  /** 创建人（对齐 plan_schedules.created_by_user_id 约定）；caller 未传则 null。 */
  createdByUserId?: string | null;
}

export async function createCase(input: CreateCaseInput) {
  const pid = await groupProjectId(input.groupId);
  if (!pid) throw new HttpError(404, 'not_found', 'group not found');
  const vp = await resolveVersionProjectId(input.versionId);
  if (!vp) throw new HttpError(404, 'not_found', 'version not found');
  if (vp !== pid) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
  if (input.datasetId !== undefined && input.datasetId !== null) {
    const dsPid = await resolveDatasetProjectId(input.datasetId);
    if (!dsPid) throw new HttpError(404, 'not_found', 'dataset not found');
    if (dsPid !== pid) throw new HttpError(400, 'dataset_project_mismatch', 'dataset does not belong to this project');
  }
  if (input.priority !== undefined) assertEnum('priority', input.priority, PRIORITIES);
  assertWindowCustom(input);
  if (input.tagIds?.length) await assertTagsBelongToOrg(input.tagIds, pid);
  const { tagIds, ...values } = input;
  const created = (await db.insert(testCases).values(values).returning())[0]!;
  if (tagIds?.length) {
    await db.insert(caseTags).values(tagIds.map((tagId) => ({ caseId: created.id, tagId })));
  }
  await invalidateCasesCache(pid);
  const tagsByCase = await tagsForCases([created.id]);
  return { ...created, tags: tagsByCase.get(created.id) ?? [] };
}

export interface AiTaskInput {
  instruction: string;
  assertion?: string | null;
  /** 已编译 DSL;缺失/null 视作未编译,dispatcher 阻塞执行。 */
  compiled?: unknown[] | null;
}

/** 创建用例并写步骤。
 *  - 每条 step 的 instruction 来自 input.instruction(自然语言);
 *  - compiled 原样落库：缺失/null 即「未编译」，dispatcher 抛 compile-missing、UI 阻塞执行。
 *    视觉模式必须由调用方显式给 [{kind:'aiTask',instruction}]——服务端不做 null→aiTask 兜底，
 *    否则「已放弃/漏编译」会被悄悄变成可执行的 AI 步骤，掩盖缺失（与 stage-tools 的 null 语义一致）。
 *  - 老 action 列已于 0030 迁移 DROP,新代码不再写。 */
export async function createCaseWithSteps(input: CreateCaseInput & { steps?: AiTaskInput[] }) {
  const created = await createCase(input);
  if (input.steps?.length) {
    const stepRows = input.steps.map((s) => {
      const compiled = (Array.isArray(s.compiled) ? s.compiled : null) as unknown[] | null;
      return {
        source: 'agent' as const,
        instruction: s.instruction,
        compiled,
        // 先 sanitize：描述性断言（"登录表单正常展示"等）→ null，回放阶段跳过断言。
        // 再 migrate：把 `{kind,text}` 老形态规整为 dispatch 认识的 `{equals,target,match,locator}`。
        assertion: (() => {
          const clean = sanitizeAssertion(s.assertion);
          if (clean === null) return null;
          return migrateAssertion({ kind: 'assertText', text: clean }) as object;
        })(),
        sensitive: false,
      };
    });
    await db.insert(testSteps).values(
      stepRows.map((r, i) => ({
        caseId: created.id,
        order: i,
        source: r.source,
        instruction: r.instruction,
        compiled: r.compiled as unknown[] | null,
        assertion: r.assertion,
        sensitive: r.sensitive,
      })),
    );
  }
  return created;
}

export interface UpdateCasePatch {
  title?: string;
  description?: string | null;
  priority?: string;
  status?: string;
  url?: string | null;
  webServiceRef?: string | null;
  groupId?: string;
  scenarioId?: string | null;
  defaultEnvId?: string | null;
  datasetId?: string | null;
  /** 数据集行选择：启用行下标数组。[] = 所有启用行；null = 清空选择（等价 []）。 */
  datasetRowIndexes?: number[] | null;
  windowStrategy?: string;
  windowWidth?: number | null;
  windowHeight?: number | null;
  incognito?: boolean;
  tagIds?: string[];
  expectedOutcome?: string | null;
  requirementNo?: string | null;
  // 2026-10-07: 移动端支持
  platform?: 'web' | 'mobile';
  mobileOs?: 'ios' | 'android' | null;
  mobileDeviceTargetId?: string | null;
  appRef?: AppRef | null;
}

export async function updateCase(caseId: string, patch: UpdateCasePatch) {
  const existing = (await db.select().from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'case not found');
  // 用例现属项目始终以其分组为准;移动分组时目标分组必须仍在同一项目
  const currentPid = await groupProjectId(existing.groupId);
  if (!currentPid) throw new HttpError(404, 'not_found', 'group not found');
  let targetPid = currentPid;
  if (patch.groupId !== undefined) {
    const nextPid = await groupProjectId(patch.groupId);
    if (!nextPid) throw new HttpError(404, 'not_found', 'group not found');
    if (nextPid !== currentPid) throw new HttpError(400, 'cross_project_move', 'cannot move a case to a group in another project');
    targetPid = nextPid;
  }
  if (patch.priority !== undefined) assertEnum('priority', patch.priority, PRIORITIES);
  if (patch.status !== undefined) assertEnum('status', patch.status, STATUSES);
  assertWindowCustom(patch);
  if (patch.scenarioId !== undefined && patch.scenarioId !== null) {
    const sc = (
      await db.select({ requirementId: scenarios.requirementId }).from(scenarios).where(eq(scenarios.id, patch.scenarioId)).limit(1)
    )[0];
    if (!sc) throw new HttpError(404, 'not_found', 'scenario not found');
    if (existing.requirementId !== sc.requirementId) {
      throw new HttpError(400, 'scenario_mismatch', "scenario does not belong to this case's requirement");
    }
  }
  if (patch.defaultEnvId !== undefined && patch.defaultEnvId !== null) {
    const envPid = await resolveEnvironmentProjectId(patch.defaultEnvId);
    if (!envPid) throw new HttpError(404, 'not_found', 'environment not found');
    if (envPid !== targetPid) throw new HttpError(400, 'env_project_mismatch', 'environment does not belong to this project');
  }
  if (patch.datasetId !== undefined && patch.datasetId !== null) {
    const dsPid = await resolveDatasetProjectId(patch.datasetId);
    if (!dsPid) throw new HttpError(404, 'not_found', 'dataset not found');
    if (dsPid !== targetPid) throw new HttpError(400, 'dataset_project_mismatch', 'dataset does not belong to this project');
  }
  // 数据集行选择与 datasetId 联动：
  //  - 显式带了选择 → 以请求为准（前端「先换数据集再选行、一次保存」要能落库）
  //  - 没带选择且换了数据集（含解绑）→ 清空（下标空间属于旧数据集）
  //  - 选择下标必须落在目标数据集的启用行范围内
  //  null = 清空（归一为 []）；undefined = 不动。
  let datasetRowIndexes = patch.datasetRowIndexes;
  if (datasetRowIndexes === undefined) {
    if (patch.datasetId !== undefined && patch.datasetId !== existing.datasetId) {
      datasetRowIndexes = [];
    }
  } else if (datasetRowIndexes === null) {
    datasetRowIndexes = [];
  }
  if (datasetRowIndexes && datasetRowIndexes.length > 0) {
    await assertDatasetRowIndexes(patch.datasetId ?? existing.datasetId, datasetRowIndexes);
  }
  // 2026-10-07: 移动端 device target 跨项目断言（service 兜底）
  if (patch.mobileDeviceTargetId !== undefined && patch.mobileDeviceTargetId !== null) {
    const dtPid = await resolveDeviceTargetProjectId(patch.mobileDeviceTargetId);
    if (!dtPid) throw new HttpError(404, 'not_found', 'device target not found');
    if (dtPid !== targetPid) throw new HttpError(400, 'device_target_project_mismatch', 'device target does not belong to this project');
  }
  if (patch.tagIds !== undefined) await assertTagsBelongToOrg(patch.tagIds, targetPid);
  // 换数据集/解绑：该用例在所有计划里的行级覆盖一并清空（下标空间属于旧数据集）。
  // 计划级置 null（跟随用例级），与用例级清空同触发；用例删除无需处理（plan_cases.caseId 外键 CASCADE）。
  // 该用例被组登录准备引用时，login_dataset_row_indexes 同口径清空。
  if (patch.datasetId !== undefined && patch.datasetId !== existing.datasetId) {
    await db.update(planCases).set({ datasetRowIndexes: null }).where(eq(planCases.caseId, caseId));
    await db.update(planCaseGroups).set({ loginDatasetRowIndexes: null }).where(eq(planCaseGroups.loginCaseId, caseId));
  }
  const { tagIds, datasetRowIndexes: _ignored, ...rest } = patch;
  const updated = (await db.update(testCases).set({
    ...rest,
    ...(datasetRowIndexes !== undefined ? { datasetRowIndexes } : {}),
    updatedAt: new Date(),
  }).where(eq(testCases.id, caseId)).returning())[0]!;
  if (tagIds !== undefined) {
    await db.delete(caseTags).where(eq(caseTags.caseId, caseId));
    if (tagIds.length > 0) {
      await db.insert(caseTags).values(tagIds.map((tagId) => ({ caseId, tagId })));
    }
  }
  const tagsByCase = await tagsForCases([caseId]);
  await invalidateCasesCache(targetPid);
  return { ...updated, tags: tagsByCase.get(caseId) ?? [] };
}

export async function deleteCase(caseId: string): Promise<void> {
  // 项目归属必须在删除前解析:行没了之后 group 链路断,失效无从谈起
  const existing = (await db.select({ groupId: testCases.groupId }).from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  const deleted = await db.delete(testCases).where(eq(testCases.id, caseId)).returning({ id: testCases.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  await invalidateCasesCache(existing ? await groupProjectId(existing.groupId) : null);
}

/** 单步骤补丁:AI 编译助手回流落库通道。
 *  - 只允许 instruction / compiled;其它列(敏感值/source/order/tab_ref)走既有写路径,
 *    避免绕过 tools 注册表的边界。
 *  - 落库后回行 + 旧 instruction 拼短 instruction(若新 instruction 为空,保留旧值)。 */
export async function updateCaseStep(stepId: string, patch: { compiled?: unknown[] | null; instruction?: string }) {
  const row = (await db.select().from(testSteps).where(eq(testSteps.id, stepId)).limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found', 'step not found');
  const set: Partial<{ compiled: unknown[] | null; instruction: string }> = {};
  if (patch.compiled !== undefined) set.compiled = patch.compiled === null ? null : patch.compiled;
  if (patch.instruction !== undefined) set.instruction = patch.instruction;
  if (Object.keys(set).length === 0) return row;
  const [updated] = await db.update(testSteps).set(set).where(eq(testSteps.id, stepId)).returning();
  await invalidateCasesCacheForCase(row.caseId);
  return updated ?? row;
}

/** 单步骤插入(AI 助手 + 后续重排):插在 afterOrder 之后(若提供),否则追加到末尾。
 *  复用 testSteps 表的 order 列连续紧凑语义,落库后把 afterOrder 之后的步骤 order +1。 */
export async function insertCaseStep(
  caseId: string,
  body: { instruction: string; compiled?: unknown[] | null; afterOrder?: number; source?: string },
) {
  const rows = await db
    .select({ id: testSteps.id, order: testSteps.order })
    .from(testSteps)
    .where(eq(testSteps.caseId, caseId))
    .orderBy(asc(testSteps.order));
  const maxOrder = rows.length > 0 ? Math.max(...rows.map((r) => r.order)) : 0;
  const targetOrder = body.afterOrder !== undefined ? body.afterOrder + 1 : maxOrder + 1;
  const [inserted] = await db
    .insert(testSteps)
    .values({
      caseId,
      order: targetOrder,
      source: body.source ?? 'agent',
      instruction: body.instruction,
      compiled: body.compiled ?? null,
    })
    .returning();
  // 后续步骤 order 紧凑化(把 targetOrder 起所有行 +1)
  const after = rows.filter((r) => r.order >= targetOrder);
  for (let i = 0; i < after.length; i++) {
    await db.update(testSteps).set({ order: targetOrder + 1 + i }).where(eq(testSteps.id, after[i]!.id));
  }
  await invalidateCasesCacheForCase(caseId);
  return inserted!;
}

/** 详情:步骤脱敏(去 secret 三元组列)+ 解析后的入口 URL + tags。不存在返回 null。 */
export async function getCaseDetail(caseId: string) {
  const row = (await db.select().from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!row) return null;
  const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
  const sanitizedSteps = steps.map(({ secretCiphertext: _sc, secretIv: _si, secretTag: _st, ...rest }) => rest);
  const resolvedUrl = await resolveCaseUrl(row, { defaultEnvFallback: true });
  const tagsByCase = await tagsForCases([caseId]);
  return attachCreator({ ...row, steps: sanitizedSteps, resolvedUrl, tags: tagsByCase.get(caseId) ?? [] });
}

export async function searchCasesInVersion(versionId: string, o: { keyword?: string; groupId?: string; limit?: number } = {}) {
  const rows = await db
    .select({
      id: testCases.id,
      title: testCases.title,
      priority: testCases.priority,
      status: testCases.status,
      groupId: testCases.groupId,
      scenarioId: testCases.scenarioId,
      url: testCases.url,
      webServiceRef: testCases.webServiceRef,
      defaultEnvId: testCases.defaultEnvId,
      updatedAt: testCases.updatedAt,
    })
    .from(testCases)
    .where(eq(testCases.versionId, versionId))
    .orderBy(asc(testCases.createdAt));
  let out = rows;
  if (o.groupId) out = out.filter((r) => r.groupId === o.groupId);
  const kw = o.keyword?.trim().toLowerCase();
  if (kw) out = out.filter((r) => r.title.toLowerCase().includes(kw));
  const limited = out.slice(0, o.limit ?? 50);
  return await Promise.all(
    limited.map(async (r) => ({
      ...r,
      webServiceRef: r.webServiceRef ?? null,
      resolvedUrl: await resolveCaseUrl(r, { defaultEnvFallback: true }),
    })),
  );
}

export async function createGroup(projectId: string, input: { name: string }) {
  const p = (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!p) throw new HttpError(404, 'not_found', 'project not found');
  return (await db
    .insert(groups)
    .values({ projectId, name: input.name })
    .returning())[0]!;
}

export async function getGroup(groupId: string) {
  return (await db.select().from(groups).where(eq(groups.id, groupId)).limit(1))[0] ?? null;
}

export async function updateGroup(groupId: string, patch: { name: string }) {
  return (await db.update(groups).set({ name: patch.name, updatedAt: new Date() }).where(eq(groups.id, groupId)).returning())[0]!;
}

/** 分组下用例数(删除前 not_empty 闸门,对齐 web 409 语义)。 */
export async function countGroupCases(groupId: string): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)` }).from(testCases).where(eq(testCases.groupId, groupId));
  return Number(rows[0]?.count ?? 0);
}

export async function deleteGroup(groupId: string): Promise<void> {
  const deleted = await db.delete(groups).where(eq(groups.id, groupId)).returning({ id: groups.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'group not found');
}

export async function listVersionsForProject(projectId: string) {
  return db
    .select({ id: projectVersions.id, name: projectVersions.name, ref: projectVersions.ref, refKind: projectVersions.refKind })
    .from(projectVersions)
    .where(eq(projectVersions.projectId, projectId))
    .orderBy(asc(projectVersions.createdAt));
}

function nextCopyTitle(base: string, existing: string[]): string {
  const taken = new Set(existing);
  const first = `${base} 副本`;
  if (!taken.has(first)) return first;
  let n = 1;
  while (taken.has(`${base} 副本${n}`)) n++;
  return `${base} 副本${n}`;
}

export interface CopyCaseInput {
  caseId: string;
  targetGroupId: string;
  /** null = 沿用源用例所在版本（同版本复制）。 */
  targetVersionId: string | null;
}

/** 复制用例到目标分组（可跨版本）：克隆步骤（instruction/compiled/assertion）与标签关联，标题追加「副本 N」。
 *  只做机械复制；源/目标的存在性与可见性由调用方校验（HTTP 边界查 per-user，AI 工具查项目归属）。
 *  createdByUserId = 执行复制操作的用户（副本的创建人）。 */
export async function copyCaseCore({ caseId, targetGroupId, targetVersionId }: CopyCaseInput, createdByUserId?: string | null) {
  const src = (await db.select().from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!src) throw new HttpError(404, 'not_found', 'case not found');
  const siblings = await db.select({ title: testCases.title }).from(testCases).where(eq(testCases.groupId, targetGroupId));
  const title = nextCopyTitle(src.title, siblings.map((s) => s.title));
  // 目标分组所属项目：项目内绑定的对象（数据集/设备/环境）只有落在目标项目里才随拷贝携带。
  const targetGroupRow = (await db
    .select({ projectId: groups.projectId })
    .from(groups)
    .where(eq(groups.id, targetGroupId))
    .limit(1))[0];
  const targetProjectId = targetGroupRow?.projectId ?? null;
  /** 源对象是否属于目标项目；跨项目复制时这些绑定一律置空，避免副本指向别的项目的资源。 */
  const ownedByTarget = async (ownerProjectId: string | null | undefined): Promise<boolean> =>
    !!targetProjectId && !!ownerProjectId && ownerProjectId === targetProjectId;
  // 数据集绑定随拷贝：仅当源数据集与目标分组同项目时携带（跨项目不外带，置空回退单次执行）。
  let datasetId: string | null = null;
  // 行选择随数据集绑定一起携带：同一数据集的下标空间相同，跨项目丢绑定时也一并丢弃。
  let datasetRowIndexes: number[] = [];
  if (src.datasetId) {
    const srcDs = (await db
      .select({ projectId: datasets.projectId })
      .from(datasets)
      .where(eq(datasets.id, src.datasetId))
      .limit(1))[0];
    if (await ownedByTarget(srcDs?.projectId)) {
      datasetId = src.datasetId;
      datasetRowIndexes = [...(src.datasetRowIndexes ?? [])];
    }
  }
  // 默认环境同理：环境属项目内资源，跨项目引用会被执行期「环境与项目不匹配」拦下。
  let defaultEnvId: string | null = null;
  if (src.defaultEnvId) {
    const envPid = await resolveEnvironmentProjectId(src.defaultEnvId);
    if (await ownedByTarget(envPid)) defaultEnvId = src.defaultEnvId;
  }
  // 设备目标同理（移动端）。
  let mobileDeviceTargetId: string | null = null;
  if (src.mobileDeviceTargetId) {
    const dtPid = await resolveDeviceTargetProjectId(src.mobileDeviceTargetId);
    if (await ownedByTarget(dtPid)) mobileDeviceTargetId = src.mobileDeviceTargetId;
  }
  const inserted = await db
    .insert(testCases)
    .values({
      title,
      description: src.description,
      // 需求编号是本条用例自身的描述性属性,随拷贝携带。
      requirementNo: src.requirementNo,
      priority: src.priority,
      groupId: targetGroupId,
      versionId: targetVersionId ?? src.versionId,
      url: src.url,
      datasetId,
      datasetRowIndexes,
      // 用例级语义随拷贝携带：预期结果与覆盖类型是本条用例自身的描述。
      expectedOutcome: src.expectedOutcome,
      coverageTypes: src.coverageTypes,
      // 窗口/隐私模式：执行参数，跨项目同样适用。
      windowStrategy: src.windowStrategy,
      windowWidth: src.windowWidth,
      windowHeight: src.windowHeight,
      incognito: src.incognito,
      // 移动端配置：device target 属项目内资源,只有落在目标项目才携带(否则置空);
      // appRef/bundleId 是应用自身标识,跨项目仍可用。
      platform: src.platform,
      mobileOs: src.mobileOs,
      mobileDeviceTargetId,
      appRef: src.appRef,
      // 环境侧绑定（default env / 命名 web 服务）指向项目内的环境对象：
      // 跨项目复制时置空——否则副本会指向别的项目的环境，执行时报「环境与项目不匹配」。
      defaultEnvId,
      webServiceRef: defaultEnvId ? src.webServiceRef : null,
      ...(createdByUserId ? { createdByUserId } : {}),
    })
    .returning();
  const newCase = inserted[0]!;
  const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
  if (steps.length > 0) {
    await db.insert(testSteps).values(
      steps.map((s) => ({
        caseId: newCase.id,
        order: s.order,
        source: s.source,
        instruction: s.instruction,
        compiled: s.compiled,
        assertion: s.assertion,
        // 敏感步骤的密文三元组一并克隆：否则副本的敏感字段变成「敏感但没值」,录制器取不到密文。
        sensitive: s.sensitive,
        secretCiphertext: s.secretCiphertext,
        secretIv: s.secretIv,
        secretTag: s.secretTag,
        mobileOs: s.mobileOs,
        tabRef: s.tabRef,
        delayMs: s.delayMs,
        componentKind: s.componentKind,
      })),
    );
  }
  const srcTagRows = await db.select({ tagId: caseTags.tagId }).from(caseTags).where(eq(caseTags.caseId, caseId));
  if (srcTagRows.length > 0) {
    await db.insert(caseTags).values(srcTagRows.map((r) => ({ caseId: newCase.id, tagId: r.tagId })));
  }
  // 跨项目复制时源项目列表不变,只需失效目标项目
  await invalidateCasesCache(targetProjectId);
  return newCase;
}
