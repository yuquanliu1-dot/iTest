/**
 * 短期记忆工具对：save_memory（模型自写，门禁内置 description）+ read_memory（取正文+埋点）。
 * chat / rca 线程均注册（rca 发现的坑同样值得记，溯源靠 source_thread_id）。
 * 门禁与 Claude Code auto-memory 同语义：只记产品线级长期经验；
 * 未验证归因须 provenance=ai_inferred 且 hook 以「未验证：」开头；先读后写，更新优先于新建。
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
    description: '把对当前产品线长期有价值的经验写入共享短期记忆（同线所有后续会话的提示词可见索引行）。该记：用户显式说「记住 X」；verify_case/执行结果证实的踩坑结论；产品线环境事实（账号怪癖、环境特殊行为）。不该记：能从代码/DB/guides 推导的信息；会话临时状态（当前进度）；未经验证的归因——确要记必须 provenance=ai_inferred 且 hook 以「未验证：」开头。同 title 已存在时自动更新（先读后写，更新优先于新建）。',
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
      // 多命中取 updatedAt 最新一条（findMemoriesByTitle 已降序）；R5 埋点：命中计数。
      // SQL 表达式自增而非读-改-写：三副本并发读同一行不丢更新。
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
