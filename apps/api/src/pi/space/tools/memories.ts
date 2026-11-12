/**
 * Short-term memory tool pair: save_memory (written by the model itself, with gating baked into the description) + read_memory (fetch body + hit instrumentation).
 * Registered on chat / rca threads alike (gotchas found by rca are worth recording too; provenance relies on source_thread_id).
 * Gating shares semantics with Claude Code auto-memory: only product-line-level long-term experience;
 * unverified attributions require provenance=ai_inferred and a hook starting with 「未验证：」; read before write, updates take priority over creating new.
 */
import { Type } from '@earendil-works/pi-ai';
import { eq, sql } from 'drizzle-orm';
import type { ToolExecutor } from '../../tools.js';
import { db } from '../../../db/client.js';
import { assistantMemories } from '../../../db/schema.js';
import type { SpaceToolsContext } from './context.js';
import { findMemoriesByTitle, loadActiveMemories, resolveProductLineId, upsertMemory } from '../memories.js';

export function buildSaveMemoryTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'save_memory',
    description: '把对当前产品线长期有价值的经验写入共享短期记忆（同线所有后续会话的提示词可见索引行）。该记：用户显式说「记住 X」；verify_case/执行结果证实的踩坑结论；产品线环境事实（账号怪癖、环境特殊行为）。不该记：能从代码/DB/guides 推导的信息；会话临时状态（当前进度）；未经验证的归因——确要记必须 provenance=ai_inferred 且 hook 以「未验证：」开头。同 title 已存在时自动更新（先读后写，更新优先于新建）。scope=global 会注入所有产品线的提示词，仅限跨线普适的平台级事实且用户明确要求时使用，默认留空。',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 120 }),
      hook: Type.String({ minLength: 1, maxLength: 200 }),
      body: Type.Optional(Type.String()),
      provenance: Type.Union([Type.Literal('user_stated'), Type.Literal('ai_inferred')]),
      scope: Type.Optional(Type.Union([Type.Literal('product_line'), Type.Literal('global')])),
    }),
    execute: async (input) => {
      const p = input as {
        title: string; hook: string; body?: string;
        provenance: 'user_stated' | 'ai_inferred';
        scope?: 'product_line' | 'global';
      };
      const scope = p.scope ?? 'product_line';
      let lineId: string | null = null;
      if (scope === 'product_line') {
        lineId = await resolveProductLineId(ctx.projectId);
        if (!lineId) return { ok: false, error: `无法解析当前项目的产品线（projectId=${ctx.projectId}），本次未写入` };
      }
      const result = await upsertMemory({
        scope,
        productLineId: lineId,
        title: p.title.trim(),
        hook: p.hook.trim(),
        body: p.body?.trim() || null,
        provenance: p.provenance,
        sourceThreadId: ctx.threadId,
        createdByUserId: ctx.createdByUserId,
      });
      return { ok: true, data: result === 'created' ? `已新建记忆「${p.title.trim()}」` : `已更新已有记忆「${p.title.trim()}」` };
    },
  };
}

export function buildReadMemoryTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'read_memory',
    description: '按标题模糊读取当前产品线可见的记忆完整内容（含 global）。提示词的「产品线记忆」索引段只有一行 hook；需要 body、provenance、更新时间等完整信息时用本工具。',
    parameters: Type.Object({ title: Type.String({ minLength: 1 }) }),
    execute: async (input) => {
      const { title } = input as { title: string };
      const lineId = await resolveProductLineId(ctx.projectId);
      if (!lineId) return { ok: false, error: `无法解析当前项目的产品线（projectId=${ctx.projectId}）` };
      const hits = await findMemoriesByTitle(lineId, title.trim());
      if (hits.length === 0) {
        const all = await loadActiveMemories(lineId);
        const names = all.map((m) => m.title).join('、') || '（无）';
        return { ok: false, error: `没有匹配「${title}」的记忆。可用标题：${names}` };
      }
      // On multiple hits take the newest updatedAt (findMemoriesByTitle already sorts descending); R5 instrumentation: hit count.
      // Increment via a SQL expression instead of read-modify-write: three replicas reading the same row concurrently won't lose updates.
      const hit = hits[0]!;
      await db.update(assistantMemories)
        .set({ hitCount: sql`${assistantMemories.hitCount} + 1`, lastHitAt: new Date() })
        .where(eq(assistantMemories.id, hit.id));
      return {
        ok: true,
        data: JSON.stringify({
          title: hit.title, hook: hit.hook, body: hit.body,
          provenance: hit.provenance, updatedAt: hit.updatedAt,
        }),
      };
    },
  };
}

export function buildMemoryTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [buildSaveMemoryTool(ctx), buildReadMemoryTool(ctx)];
}
