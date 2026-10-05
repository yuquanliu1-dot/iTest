/**
 * 用例/分组领域服务:HTTP 路由与空间 AI 工具共用。
 * 这里只做数据完整性与归属校验(实体 ∈ project/version/org);
 * 用户可见性(assertProjectVisible 等)由调用方(HTTP 边界)负责。
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { caseTags, groups, projects, scenarios, tags, testCases, testSteps } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { resolveEnvironmentProjectId, resolveVersionProjectId } from './projectAccess.js';
import { migrateAssertion, sanitizeAssertion } from '../lib/step-migration.js';

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const STATUSES = ['draft', 'review', 'ready', 'deprecated'];

export async function groupProjectId(groupId: string): Promise<string | null> {
  const row = (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, groupId)).limit(1))[0];
  return row?.projectId ?? null;
}

/** 校验 tagIds 都属于 projectId 所属组织;缺失 404,跨组织 400。 */
export async function assertTagsBelongToOrg(tagIds: string[], projectId: string): Promise<void> {
  if (tagIds.length === 0) return;
  const [proj] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
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
  windowStrategy?: string;
  windowWidth?: number | null;
  windowHeight?: number | null;
  incognito?: boolean;
  requirementId?: string | null;
  scenarioId?: string | null;
  tagIds?: string[];
  expectedOutcome?: string | null;
}

export async function createCase(input: CreateCaseInput) {
  const pid = await groupProjectId(input.groupId);
  if (!pid) throw new HttpError(404, 'not_found', 'group not found');
  const vp = await resolveVersionProjectId(input.versionId);
  if (!vp) throw new HttpError(404, 'not_found', 'version not found');
  if (vp !== pid) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
  if (input.priority !== undefined) assertEnum('priority', input.priority, PRIORITIES);
  assertWindowCustom(input);
  if (input.tagIds?.length) await assertTagsBelongToOrg(input.tagIds, pid);
  const { tagIds, ...values } = input;
  const created = (await db.insert(testCases).values(values).returning())[0]!;
  if (tagIds?.length) {
    await db.insert(caseTags).values(tagIds.map((tagId) => ({ caseId: created.id, tagId })));
  }
  const tagsByCase = await tagsForCases([created.id]);
  return { ...created, tags: tagsByCase.get(created.id) ?? [] };
}

export interface AiTaskInput {
  instruction: string;
  assertion?: string | null;
}

/** 创建用例并写 AI 智能步骤（aiTask 单步，回放期由 LLM 多轮执行）。 */
export async function createCaseWithSteps(input: CreateCaseInput & { steps?: AiTaskInput[] }) {
  const created = await createCase(input);
  if (input.steps?.length) {
    const stepRows = input.steps.map((s) => {
      const name = (s.instruction.split(/[，。！？,.!?\n]/, 1)[0]?.trim() ?? '').slice(0, 200) || s.instruction.slice(0, 200);
      const action: Record<string, unknown> = { kind: 'aiTask', instruction: s.instruction };
      return {
        source: 'agent' as const,
        name,
        action: action as object,
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
        name: r.name,
        action: r.action,
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
  groupId?: string;
  scenarioId?: string | null;
  defaultEnvId?: string | null;
  windowStrategy?: string;
  windowWidth?: number | null;
  windowHeight?: number | null;
  incognito?: boolean;
  tagIds?: string[];
  expectedOutcome?: string | null;
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
  if (patch.tagIds !== undefined) await assertTagsBelongToOrg(patch.tagIds, targetPid);
  const { tagIds, ...rest } = patch;
  const updated = (await db.update(testCases).set({ ...rest, updatedAt: new Date() }).where(eq(testCases.id, caseId)).returning())[0]!;
  if (tagIds !== undefined) {
    await db.delete(caseTags).where(eq(caseTags.caseId, caseId));
    if (tagIds.length > 0) {
      await db.insert(caseTags).values(tagIds.map((tagId) => ({ caseId, tagId })));
    }
  }
  const tagsByCase = await tagsForCases([caseId]);
  return { ...updated, tags: tagsByCase.get(caseId) ?? [] };
}

export async function deleteCase(caseId: string): Promise<void> {
  const deleted = await db.delete(testCases).where(eq(testCases.id, caseId)).returning({ id: testCases.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'case not found');
}

/** 详情:步骤脱敏(去 secret 三元组列)+ 解析后的入口 URL + tags。不存在返回 null。 */
export async function getCaseDetail(caseId: string) {
  const row = (await db.select().from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!row) return null;
  const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
  const sanitizedSteps = steps.map(({ secretCiphertext: _sc, secretIv: _si, secretTag: _st, ...rest }) => rest);
  const resolvedUrl = await resolveCaseUrl(row, { defaultEnvFallback: true });
  const tagsByCase = await tagsForCases([caseId]);
  return { ...row, steps: sanitizedSteps, resolvedUrl, tags: tagsByCase.get(caseId) ?? [] };
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
      updatedAt: testCases.updatedAt,
    })
    .from(testCases)
    .where(eq(testCases.versionId, versionId))
    .orderBy(asc(testCases.createdAt));
  let out = rows;
  if (o.groupId) out = out.filter((r) => r.groupId === o.groupId);
  const kw = o.keyword?.trim().toLowerCase();
  if (kw) out = out.filter((r) => r.title.toLowerCase().includes(kw));
  return out.slice(0, o.limit ?? 50);
}

export async function createGroup(projectId: string, input: { name: string; defaultUrl?: string | null }) {
  const p = (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!p) throw new HttpError(404, 'not_found', 'project not found');
  return (await db
    .insert(groups)
    .values({ projectId, name: input.name, ...(input.defaultUrl !== undefined ? { defaultUrl: input.defaultUrl } : {}) })
    .returning())[0]!;
}
