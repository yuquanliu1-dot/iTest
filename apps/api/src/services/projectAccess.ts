import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { datasets, deviceTargets, groups, productLines, projects, projectVersions, reports, testCases, testEnvironments, planRuns } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import type { AuthUser } from './auth.service.js';
import { visibleOrgIdsFor } from './orgTree.js';

/**
 * 项目可见性断言：不存在与不可见统一 404，不泄露存在性。
 * 所有按 id 访问项目及其子资源的入口都必须先过这道检查。
 */
export async function assertProjectVisible(projectId: string, user: AuthUser): Promise<void> {
  const rows = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const orgId = rows[0]?.organizationId;
  if (!orgId) throw new HttpError(404, 'not_found', 'project not found');
  const visible = await visibleOrgIdsFor(user);
  if (!visible.has(orgId)) throw new HttpError(404, 'not_found', 'project not found');
}

/** 解析 case 所属项目 id（case → group → project）；链路不存在返回 null。 */
export async function resolveCaseProjectId(caseId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: groups.projectId })
    .from(testCases)
    .innerJoin(groups, eq(testCases.groupId, groups.id))
    .where(eq(testCases.id, caseId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** case 可见性断言：经所属项目判定，404 文案不区分「不存在」与「不可见」。 */
export async function assertCaseVisible(caseId: string, user: AuthUser): Promise<void> {
  const projectId = await resolveCaseProjectId(caseId);
  if (!projectId) throw new HttpError(404, 'not_found', 'case not found');
  const rows = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const orgId = rows[0]?.organizationId;
  if (!orgId) throw new HttpError(404, 'not_found', 'case not found');
  const visible = await visibleOrgIdsFor(user);
  if (!visible.has(orgId)) throw new HttpError(404, 'not_found', 'case not found');
}

/** report 可见性断言：经 case → group → project 链路判定，404 文案不区分「不存在」与「不可见」。 */
export async function assertReportVisible(reportId: string, user: AuthUser): Promise<void> {
  const rows = await db
    .select({ projectId: groups.projectId })
    .from(reports)
    .innerJoin(testCases, eq(testCases.id, reports.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(eq(reports.id, reportId))
    .limit(1);
  const projectId = rows[0]?.projectId;
  if (!projectId) throw new HttpError(404, 'not_found', 'report not found');
  await assertProjectVisible(projectId, user);
}

/** plan run 可见性断言：plan_runs.projectId 直接落在 projects，链路判定后兜底。 */
export async function assertPlanRunVisible(planRunId: string, user: AuthUser): Promise<void> {
  const rows = await db.select({ projectId: planRuns.projectId }).from(planRuns).where(eq(planRuns.id, planRunId)).limit(1);
  const projectId = rows[0]?.projectId;
  if (!projectId) throw new HttpError(404, 'not_found', 'plan run not found');
  await assertProjectVisible(projectId, user);
}

/** 用户可见的全部项目 id（列表接口无组织维度过滤参数时用）。 */
export async function visibleProjectIds(user: AuthUser): Promise<string[]> {
  const visibleOrgs = await visibleOrgIdsFor(user);
  if (visibleOrgs.size === 0) return [];
  const rows = await db.select({ id: projects.id }).from(projects).where(inArray(projects.organizationId, [...visibleOrgs]));
  return rows.map((r) => r.id);
}

/** 解析 environment 所属项目 id（env → project）；链路不存在返回 null。 */
export async function resolveEnvironmentProjectId(envId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: testEnvironments.projectId })
    .from(testEnvironments)
    .where(eq(testEnvironments.id, envId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** environment 可见性断言：经所属项目判定，404 文案不区分「不存在」与「不可见」。 */
export async function assertEnvironmentVisible(envId: string, user: AuthUser): Promise<{ projectId: string }> {
  const rows = await db
    .select({ projectId: testEnvironments.projectId })
    .from(testEnvironments)
    .where(eq(testEnvironments.id, envId))
    .limit(1);
  const projectId = rows[0]?.projectId;
  if (!projectId) throw new HttpError(404, 'not_found', 'environment not found');
  await assertProjectVisible(projectId, user);
  return { projectId };
}

/** 解析 dataset 所属项目 id（dataset → project）；链路不存在返回 null。 */
export async function resolveDatasetProjectId(datasetId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: datasets.projectId })
    .from(datasets)
    .where(eq(datasets.id, datasetId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** dataset 可见性断言：经所属项目判定，404 文案不区分「不存在」与「不可见」。 */
export async function assertDatasetVisible(datasetId: string, user: AuthUser): Promise<{ projectId: string }> {
  const projectId = await resolveDatasetProjectId(datasetId);
  if (!projectId) throw new HttpError(404, 'not_found', 'dataset not found');
  await assertProjectVisible(projectId, user);
  return { projectId };
}

/** 解析 version 所属项目 id（version → project）；链路不存在返回 null。 */
export async function resolveVersionProjectId(versionId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: projectVersions.projectId })
    .from(projectVersions)
    .where(eq(projectVersions.id, versionId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** version 可见性断言：经 version → project 链路判定，404 文案不区分「不存在」与「不可见」。 */
export async function assertVersionVisible(versionId: string, user: AuthUser): Promise<{ projectId: string }> {
  const projectId = await resolveVersionProjectId(versionId);
  if (!projectId) throw new HttpError(404, 'not_found', 'version not found');
  await assertProjectVisible(projectId, user);
  return { projectId };
}

/** 解析 device target 所属项目 id（device_target → project）；链路不存在返回 null。 */
export async function resolveDeviceTargetProjectId(deviceTargetId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: deviceTargets.projectId })
    .from(deviceTargets)
    .where(eq(deviceTargets.id, deviceTargetId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** device target 可见性断言：经所属项目判定，404 文案不区分「不存在」与「不可见」。 */
export async function assertDeviceTargetVisible(deviceTargetId: string, user: AuthUser): Promise<{ projectId: string }> {
  const projectId = await resolveDeviceTargetProjectId(deviceTargetId);
  if (!projectId) throw new HttpError(404, 'not_found', 'device target not found');
  await assertProjectVisible(projectId, user);
  return { projectId };
}

/**
 * 产品线可见性断言：产品线挂在组织下，可见性直接走 visibleOrgIdsFor（与 assertProjectVisible 同构），
 * 不存在与不可见统一 404，不泄露存在性。
 */
export async function assertProductLineVisible(productLineId: string, user: AuthUser): Promise<{ organizationId: string }> {
  const rows = await db
    .select({ organizationId: productLines.organizationId })
    .from(productLines)
    .where(eq(productLines.id, productLineId))
    .limit(1);
  const orgId = rows[0]?.organizationId;
  if (!orgId) throw new HttpError(404, 'not_found', 'product line not found');
  const visible = await visibleOrgIdsFor(user);
  if (!visible.has(orgId)) throw new HttpError(404, 'not_found', 'product line not found');
  return { organizationId: orgId };
}

/** 用户可见的全部产品线 id（按可见组织过滤）。 */
export async function visibleProductLineIds(user: AuthUser): Promise<string[]> {
  const visibleOrgs = await visibleOrgIdsFor(user);
  if (visibleOrgs.size === 0) return [];
  const rows = await db
    .select({ id: productLines.id })
    .from(productLines)
    .where(inArray(productLines.organizationId, [...visibleOrgs]));
  return rows.map((r) => r.id);
}

/** 产品线下的全部项目 id；产品线不存在返回 null（由调用方决定 404）。 */
export async function productLineProjectIds(productLineId: string): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.productLineId, productLineId));
  return rows.map((r) => r.id);
}
