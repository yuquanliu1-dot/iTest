/**
 * R3 固化管线：审批执行（乐观锁 → 应用 → 源退役）与驳回。
 * 幂等三件套：乐观锁（pending→approved 单胜）/ source_ref partial unique（重放单行）/
 * 退役 active 守卫（不复活/不重复改已退役条目）。skill 修订先写文件再记版本行（重放无害）。
 * 部分失败：apply_error 记原因 + status 回 pending 可重试。
 */
import { and, eq, inArray } from 'drizzle-orm';
import { HttpError } from '../../middleware/errorHandler.js';
import { db } from '../../db/client.js';
import {
  assistantMemories, assistantPromptModuleVersions, assistantSolidifyProposals,
  assistantTrajectories,
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

/** prompt_amendment：当前无值先落 baseline（钉住代码默认），再追加增量；sourceRef 幂等。 */
async function applyPromptAmendment(prop: ProposalRow, userId: string | null): Promise<void> {
  const def = (await listPromptModuleDefs()).find((d) => d.key === prop.target && d.group !== 'skill');
  if (!def) throw new Error(`target 不在注册表：${prop.target}`);
  if (await hasAppliedVersionRow(prop.target, prop.id)) return; // 重试重放：已应用过，跳过
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
  if (seq == null) return; // 并发重放被 unique 吞掉——视为已应用
}

/** skill_revision：首次固化先记 baseline（磁盘现正文）；先写文件（frontmatter 从 DB 重拼）再记版本行。 */
async function applySkillRevision(prop: ProposalRow, userId: string | null): Promise<void> {
  const key = `skill.${prop.target}`;
  const meta = await readSkillMeta(prop.target);
  if (!meta) throw new Error(`skill 不存在或未启用：${prop.target}`);
  if (await hasAppliedVersionRow(key, prop.id)) return; // 重试时若 sourceRef 行已存在则跳过写文件
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

/** 源退役：active 守卫防重复退役/复活已删条目；按 type 分表更新。 */
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

/** 批准并应用：乐观锁（0 行→409）→ 应用 → 退役 → appliedAt；失败回 pending + apply_error。 */
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
    else await applySkillRevision(prop, userId);
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

/** 驳回：同样乐观锁，不碰任何资产。 */
export async function rejectProposal(userId: string | null, proposalId: string): Promise<void> {
  const r = await db.update(assistantSolidifyProposals)
    .set({ status: 'rejected', reviewedBy: userId, reviewedAt: new Date() })
    .where(and(eq(assistantSolidifyProposals.id, proposalId), eq(assistantSolidifyProposals.status, 'pending')))
    .returning({ id: assistantSolidifyProposals.id });
  if (r.length === 0) throw new HttpError(409, 'proposal_not_pending', '提案不在待审批状态');
}
