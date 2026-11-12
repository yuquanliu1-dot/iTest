/**
 * R3 solidification pipeline: approval execution (optimistic lock → apply → source retirement) and rejection.
 * Idempotence triple: optimistic lock (pending→approved single winner) / source_ref partial unique (replay produces a single row) /
 * retirement active guard (no resurrecting / re-modifying already-retired entries). Skill revisions write the file first, then record the version row (replay is harmless).
 * Partial failure: apply_error records the reason + status back to pending for retry.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { HttpError } from '../../middleware/errorHandler.js';
import { db } from '../../db/client.js';
import {
  assistantFailureLessons, assistantMemories, assistantPromptModuleVersions,
  assistantSolidifyProposals, assistantTrajectories,
} from '../../db/schema.js';
import {
  insertPromptModuleVersion, listPromptModuleDefs, loadPromptModuleOverrides,
  readSkillBody, readSkillMeta, writeSkillBodyFromDb,
} from './promptModules.js';

type ProposalRow = typeof assistantSolidifyProposals.$inferSelect;

async function hasAppliedVersionRow(key: string, proposalId: string): Promise<boolean> {
  const r = await db.select({ seq: assistantPromptModuleVersions.seq }).from(assistantPromptModuleVersions)
    .where(and(
      eq(assistantPromptModuleVersions.moduleKey, key),
      eq(assistantPromptModuleVersions.sourceRef, proposalId),
    )).limit(1);
  return r.length > 0;
}

/** prompt_amendment: when there is no current value, first record the baseline (pinning the code default), then append the increment; sourceRef idempotence. */
async function applyPromptAmendment(prop: ProposalRow, userId: string | null): Promise<void> {
  const def = (await listPromptModuleDefs()).find((d) => d.key === prop.target && d.group !== 'skill');
  if (!def) throw new Error(`target 不在注册表：${prop.target}`);
  if (await hasAppliedVersionRow(prop.target, prop.id)) return; // retry replay: already applied, skip
  const current = (await loadPromptModuleOverrides()).get(prop.target);
  if (!current || current.value == null) {
    await insertPromptModuleVersion({
      moduleKey: prop.target, value: await def.defaultValue(), source: 'baseline', createdByUserId: userId,
    });
  }
  const baseText = current?.value ?? await def.defaultValue();
  const seq = await insertPromptModuleVersion({
    moduleKey: prop.target, value: `${baseText}\n\n${prop.body}`,
    source: 'solidify_apply', sourceRef: prop.id, createdByUserId: userId,
  });
  if (seq == null) return; // concurrent replay swallowed by unique — treat as already applied
}

/** skill_revision: the first solidification records the baseline first (the current on-disk body); the file is written first (frontmatter reassembled from DB), then the version row. */
async function applySkillRevision(prop: ProposalRow, userId: string | null): Promise<void> {
  const key = `skill.${prop.target}`;
  const meta = await readSkillMeta(prop.target);
  if (!meta) throw new Error(`skill 不存在或未启用：${prop.target}`);
  if (await hasAppliedVersionRow(key, prop.id)) return; // on retry, skip writing the file when the sourceRef row already exists
  const hasAny = (await db.select({ seq: assistantPromptModuleVersions.seq }).from(assistantPromptModuleVersions)
    .where(eq(assistantPromptModuleVersions.moduleKey, key)).limit(1)).length > 0;
  if (!hasAny) {
    await insertPromptModuleVersion({
      moduleKey: key, value: await readSkillBody(prop.target), source: 'baseline', createdByUserId: userId,
    });
  }
  await writeSkillBodyFromDb(meta.name, meta.description, prop.body);
  await insertPromptModuleVersion({
    moduleKey: key, value: prop.body, source: 'solidify_apply', sourceRef: prop.id, createdByUserId: userId,
  });
}

/** prompt_correction: whole-text overwrite semantics. baseSeq recheck (manually edited after the inventory → reject, back to pending for a human re-inventory). */
async function applyPromptCorrection(prop: ProposalRow, userId: string | null): Promise<void> {
  const def = (await listPromptModuleDefs()).find((d) => d.key === prop.target && d.group !== 'skill');
  if (!def) throw new Error(`target 不在注册表：${prop.target}`);
  if (await hasAppliedVersionRow(prop.target, prop.id)) return; // retry replay: already applied, skip writing the value
  const currentSeq = (await loadPromptModuleOverrides()).get(prop.target)?.seq ?? null;
  if (currentSeq !== (prop.baseSeq ?? null)) {
    throw new Error('模块已被人工修改，请重新盘点');
  }
  const seq = await insertPromptModuleVersion({
    moduleKey: prop.target, value: prop.body, source: 'solidify_apply', sourceRef: prop.id, createdByUserId: userId,
  });
  if (seq == null) return; // concurrent replay was swallowed by the unique constraint — treat as already applied
}

/** Source retirement: the active guard prevents double retirement / resurrecting deleted entries; updated per-type in separate tables. */
async function retireSources(prop: ProposalRow, retireIds: string[]): Promise<void> {
  if (retireIds.length === 0) return;
  const sources = prop.sources;
  const memIds = retireIds.filter((id) => sources.some((s) => s.id === id && s.type === 'memory'));
  const trajIds = retireIds.filter((id) => sources.some((s) => s.id === id && s.type === 'trajectory'));
  if (memIds.length > 0) {
    await db.update(assistantMemories)
      .set({ status: 'retired_solidified', retiredByBatch: prop.batchId, updatedAt: new Date() })
      .where(and(inArray(assistantMemories.id, memIds), eq(assistantMemories.status, 'active')));
  }
  if (trajIds.length > 0) {
    await db.update(assistantTrajectories)
      .set({ status: 'retired_solidified', retiredByBatch: prop.batchId, updatedAt: new Date() })
      .where(and(inArray(assistantTrajectories.id, trajIds), eq(assistantTrajectories.status, 'active')));
  }
}

/** After a correction is applied, the lessons in its sources are automatically set resolved (active guard; never resurrects already retired/resolved ones). */
async function resolveLessons(prop: ProposalRow): Promise<void> {
  const lessonIds = prop.sources.filter((s) => s.type === 'lesson').map((s) => s.id);
  if (lessonIds.length === 0) return;
  await db.update(assistantFailureLessons)
    .set({ status: 'resolved', resolvedByProposal: prop.id, updatedAt: new Date() })
    .where(and(inArray(assistantFailureLessons.id, lessonIds), eq(assistantFailureLessons.status, 'active')));
}

/** Approve and apply: optimistic lock (0 rows → 409) → apply → retire → appliedAt; on failure, back to pending + apply_error. */
export async function approveProposal(userId: string | null, proposalId: string, retireIds: string[]): Promise<void> {
  const prop = (await db.select().from(assistantSolidifyProposals)
    .where(eq(assistantSolidifyProposals.id, proposalId)).limit(1))[0];
  if (!prop) throw new HttpError(404, 'not_found', '提案不存在');
  const sourceIds = new Set(prop.sources.map((s) => s.id));
  if (retireIds.some((id) => !sourceIds.has(id))) {
    throw new HttpError(400, 'retire_source_mismatch', 'retireIds 含本提案 sources 之外的条目');
  }
  const locked = await db.update(assistantSolidifyProposals)
    .set({ status: 'approved', reviewedBy: userId, reviewedAt: new Date(), applyError: null })
    .where(and(eq(assistantSolidifyProposals.id, proposalId), eq(assistantSolidifyProposals.status, 'pending')))
    .returning({ id: assistantSolidifyProposals.id });
  if (locked.length === 0) throw new HttpError(409, 'proposal_not_pending', '提案不在待审批状态');
  try {
    if (prop.kind === 'prompt_amendment') await applyPromptAmendment(prop, userId);
    else if (prop.kind === 'prompt_correction') await applyPromptCorrection(prop, userId);
    else await applySkillRevision(prop, userId);
    await retireSources(prop, retireIds);
    await resolveLessons(prop);
    await retireSources(prop, retireIds);
    await db.update(assistantSolidifyProposals)
      .set({ appliedAt: new Date() })
      .where(eq(assistantSolidifyProposals.id, proposalId));
  } catch (e) {
    await db.update(assistantSolidifyProposals)
      .set({ status: 'pending', applyError: (e as Error).message.slice(0, 2000) })
      .where(eq(assistantSolidifyProposals.id, proposalId));
    throw new HttpError(500, 'solidify_apply_failed', `应用失败：${(e as Error).message}`);
  }
}

/** Reject: same optimistic lock, touches no assets. */
export async function rejectProposal(userId: string | null, proposalId: string): Promise<void> {
  const r = await db.update(assistantSolidifyProposals)
    .set({ status: 'rejected', reviewedBy: userId, reviewedAt: new Date() })
    .where(and(eq(assistantSolidifyProposals.id, proposalId), eq(assistantSolidifyProposals.status, 'pending')))
    .returning({ id: assistantSolidifyProposals.id });
  if (r.length === 0) throw new HttpError(409, 'proposal_not_pending', '提案不在待审批状态');
}
