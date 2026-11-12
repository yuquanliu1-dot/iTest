/**
 * Scenario domain service: scenarios belong to a requirement (scenarios.requirement_id NOT NULL).
 * Ownership resolution goes through the requirements join; user visibility is the caller's (HTTP boundary) responsibility.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirements, scenarios } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';

export async function requirementProjectId(requirementId: string): Promise<string | null> {
  const row = (await db.select({ projectId: requirements.projectId }).from(requirements).where(eq(requirements.id, requirementId)).limit(1))[0];
  return row?.projectId ?? null;
}

export async function scenarioProjectId(scenarioId: string): Promise<string | null> {
  const row = (
    await db
      .select({ projectId: requirements.projectId })
      .from(scenarios)
      .innerJoin(requirements, eq(scenarios.requirementId, requirements.id))
      .where(eq(scenarios.id, scenarioId))
      .limit(1)
  )[0];
  return row?.projectId ?? null;
}

/** Project-level scenario full set (id/title/description/requirementId), by creation order. */
export async function listScenariosByProject(projectId: string) {
  return db
    .select({ id: scenarios.id, title: scenarios.title, description: scenarios.description, requirementId: scenarios.requirementId })
    .from(scenarios)
    .innerJoin(requirements, eq(scenarios.requirementId, requirements.id))
    .where(eq(requirements.projectId, projectId))
    .orderBy(scenarios.createdAt);
}

/** Project-level requirement list (id/title/status), by creation order. */
export async function listRequirementsByProject(projectId: string) {
  return db
    .select({ id: requirements.id, title: requirements.title, status: requirements.status })
    .from(requirements)
    .where(eq(requirements.projectId, projectId))
    .orderBy(requirements.createdAt);
}

export async function getRequirement(requirementId: string) {
  return (await db.select().from(requirements).where(eq(requirements.id, requirementId)).limit(1))[0] ?? null;
}

export async function getScenario(scenarioId: string) {
  return (await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1))[0] ?? null;
}

export async function createScenario(requirementId: string, input: { title: string; description?: string | null }) {
  const pid = await requirementProjectId(requirementId);
  if (!pid) throw new HttpError(404, 'not_found', 'requirement not found');
  const max = (
    await db.select({ m: sql<number>`coalesce(max("order"), 0)` }).from(scenarios).where(eq(scenarios.requirementId, requirementId))
  )[0]?.m ?? 0;
  return (
    await db
      .insert(scenarios)
      .values({ requirementId, title: input.title, description: input.description, order: Number(max) + 1 })
      .returning()
  )[0]!;
}

export async function updateScenario(scenarioId: string, patch: { title?: string; description?: string | null }) {
  const updated = await db.update(scenarios).set(patch).where(eq(scenarios.id, scenarioId)).returning();
  if (updated.length === 0) throw new HttpError(404, 'not_found', 'scenario not found');
  return updated[0]!;
}

/** FK ON DELETE SET NULL: cases unbind automatically; no 409 needed. */
export async function deleteScenario(scenarioId: string): Promise<void> {
  const deleted = await db.delete(scenarios).where(eq(scenarios.id, scenarioId)).returning({ id: scenarios.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'scenario not found');
}
