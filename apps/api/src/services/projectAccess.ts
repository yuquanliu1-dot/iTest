import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { datasets, deviceTargets, groups, productLines, projects, projectVersions, reports, testCases, testEnvironments, planRuns } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import type { AuthUser } from './auth.service.js';
import { visibleOrgIdsFor } from './orgTree.js';

/**
 * Resolve project → owning org id (via product_lines); returns null when the project doesn't exist or has no product line.
 * Projects no longer have their own org column; "which org the project belongs to" is always "which org its product line belongs to".
 */
async function projectOrgId(projectId: string): Promise<string | null> {
  const rows = await db
    .select({ organizationId: productLines.organizationId })
    .from(projects)
    .innerJoin(productLines, eq(productLines.id, projects.productLineId))
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0]?.organizationId ?? null;
}

/**
 * Project visibility assertion: missing and invisible both 404, no existence leakage.
 * Every entry point that accesses a project or its sub-resources by id must pass this check first.
 */
export async function assertProjectVisible(projectId: string, user: AuthUser): Promise<void> {
  const orgId = await projectOrgId(projectId);
  if (!orgId) throw new HttpError(404, 'not_found', 'project not found');
  const visible = await visibleOrgIdsFor(user);
  if (!visible.has(orgId)) throw new HttpError(404, 'not_found', 'project not found');
}

/** Resolve the case's owning project id (case → group → project); returns null when the chain is missing. */
export async function resolveCaseProjectId(caseId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: groups.projectId })
    .from(testCases)
    .innerJoin(groups, eq(testCases.groupId, groups.id))
    .where(eq(testCases.id, caseId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** case visibility assertion: judged via the owning project; the 404 wording doesn't distinguish "missing" from "invisible". */
export async function assertCaseVisible(caseId: string, user: AuthUser): Promise<void> {
  const projectId = await resolveCaseProjectId(caseId);
  if (!projectId) throw new HttpError(404, 'not_found', 'case not found');
  // Org judgment is already folded into assertProjectVisible; no need to query the org again here.
  await assertProjectVisible(projectId, user);
}

/** report visibility assertion: judged via the case → group → project chain; the 404 wording doesn't distinguish "missing" from "invisible". */
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

/** plan run visibility assertion: plan_runs.projectId lands directly on projects; the chain check covers it. */
export async function assertPlanRunVisible(planRunId: string, user: AuthUser): Promise<void> {
  const rows = await db.select({ projectId: planRuns.projectId }).from(planRuns).where(eq(planRuns.id, planRunId)).limit(1);
  const projectId = rows[0]?.projectId;
  if (!projectId) throw new HttpError(404, 'not_found', 'plan run not found');
  await assertProjectVisible(projectId, user);
}

/** All project ids visible to the user (for list endpoints with no org-dimension filter parameter). */
export async function visibleProjectIds(user: AuthUser): Promise<string[]> {
  const visibleOrgs = await visibleOrgIdsFor(user);
  if (visibleOrgs.size === 0) return [];
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(productLines, eq(productLines.id, projects.productLineId))
    .where(inArray(productLines.organizationId, [...visibleOrgs]));
  return rows.map((r) => r.id);
}

/** Resolve the environment's owning project id (env → project); returns null when the chain is missing. */
export async function resolveEnvironmentProjectId(envId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: testEnvironments.projectId })
    .from(testEnvironments)
    .where(eq(testEnvironments.id, envId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** environment visibility assertion: judged via the owning project; the 404 wording doesn't distinguish "missing" from "invisible". */
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

/** Resolve the dataset's owning project id (dataset → project); returns null when the chain is missing. */
export async function resolveDatasetProjectId(datasetId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: datasets.projectId })
    .from(datasets)
    .where(eq(datasets.id, datasetId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** dataset visibility assertion: judged via the owning project; the 404 wording doesn't distinguish "missing" from "invisible". */
export async function assertDatasetVisible(datasetId: string, user: AuthUser): Promise<{ projectId: string }> {
  const projectId = await resolveDatasetProjectId(datasetId);
  if (!projectId) throw new HttpError(404, 'not_found', 'dataset not found');
  await assertProjectVisible(projectId, user);
  return { projectId };
}

/** Resolve the version's owning project id (version → project); returns null when the chain is missing. */
export async function resolveVersionProjectId(versionId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: projectVersions.projectId })
    .from(projectVersions)
    .where(eq(projectVersions.id, versionId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** version visibility assertion: judged via the version → project chain; the 404 wording doesn't distinguish "missing" from "invisible". */
export async function assertVersionVisible(versionId: string, user: AuthUser): Promise<{ projectId: string }> {
  const projectId = await resolveVersionProjectId(versionId);
  if (!projectId) throw new HttpError(404, 'not_found', 'version not found');
  await assertProjectVisible(projectId, user);
  return { projectId };
}

/** Resolve the device target's owning project id (device_target → project); returns null when the chain is missing. */
export async function resolveDeviceTargetProjectId(deviceTargetId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: deviceTargets.projectId })
    .from(deviceTargets)
    .where(eq(deviceTargets.id, deviceTargetId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** device target visibility assertion: judged via the owning project; the 404 wording doesn't distinguish "missing" from "invisible". */
export async function assertDeviceTargetVisible(deviceTargetId: string, user: AuthUser): Promise<{ projectId: string }> {
  const projectId = await resolveDeviceTargetProjectId(deviceTargetId);
  if (!projectId) throw new HttpError(404, 'not_found', 'device target not found');
  await assertProjectVisible(projectId, user);
  return { projectId };
}

/**
 * Product line visibility assertion: product lines hang under orgs, so visibility goes straight through visibleOrgIdsFor (isomorphic to assertProjectVisible);
 * missing and invisible both 404, no existence leakage.
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

/** All product line ids visible to the user (filtered by visible orgs). */
export async function visibleProductLineIds(user: AuthUser): Promise<string[]> {
  const visibleOrgs = await visibleOrgIdsFor(user);
  if (visibleOrgs.size === 0) return [];
  const rows = await db
    .select({ id: productLines.id })
    .from(productLines)
    .where(inArray(productLines.organizationId, [...visibleOrgs]));
  return rows.map((r) => r.id);
}

/** All project ids under a product line; returns null when the product line is missing (caller decides the 404). */
export async function productLineProjectIds(productLineId: string): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.productLineId, productLineId));
  return rows.map((r) => r.id);
}
