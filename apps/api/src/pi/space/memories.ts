/**
 * 短期记忆体（产品线级）核心服务：加载/渲染/upsert/模糊查。
 * 设计：docs/superpowers/specs/2026-10-31-assistant-shortterm-memory-design.md
 * 注入走 buildSpaceSystemPrompt 记忆索引段（guides 同轨，每轮重算热生效）。
 */
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantMemories, projects } from '../../db/schema.js';

export type AssistantMemoryRow = typeof assistantMemories.$inferSelect;

/** 注入预算（硬编码常量；膨胀治理归 R3 退役机制，不做配置项）。 */
export const MEMORY_MAX_ENTRIES = 50;
export const MEMORY_SECTION_MAX_CHARS = 4_000;

/** 项目 → 产品线解析（save_memory 与会话工厂注入共用）。项目必归线（结构不变式）。 */
export async function resolveProductLineId(projectId: string): Promise<string | null> {
  const rows = await db.select({ id: projects.productLineId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  return rows[0]?.id ?? null;
}

/** 加载某产品线可见的 active 记忆（global + 本线），updatedAt 降序，条数上限截断。 */
export async function loadActiveMemories(productLineId: string): Promise<AssistantMemoryRow[]> {
  return db.select().from(assistantMemories)
    .where(and(
      eq(assistantMemories.status, 'active'),
      or(
        eq(assistantMemories.scope, 'global'),
        and(eq(assistantMemories.scope, 'product_line'), eq(assistantMemories.productLineId, productLineId)),
      ),
    ))
    .orderBy(desc(assistantMemories.updatedAt))
    .limit(MEMORY_MAX_ENTRIES);
}

/** 渲染记忆索引段：`- [title] hook` 每条一行 + 脚注；超字符预算截到最近完整行；空 → ''。 */
export function buildMemoriesSection(rows: Array<Pick<AssistantMemoryRow, 'title' | 'hook'>>): string {
  if (rows.length === 0) return '';
  const header = '# 产品线记忆（历史会话沉淀的经验）';
  const footer = '需要完整内容时调用 read_memory；用户要求记住的事实用 save_memory。';
  const kept: string[] = [];
  for (const r of rows) {
    const line = `- [${r.title}] ${r.hook}`;
    const size = header.length + footer.length + [...kept, line].join('\n').length + 2;
    if (kept.length > 0 && size > MEMORY_SECTION_MAX_CHARS) break;
    kept.push(line);
  }
  return `${header}\n${kept.join('\n')}\n${footer}`;
}

/** upsert：同 (scope, productLineId, title) 的 active 行存在则更新，否则插入。
 *  返回 'created' | 'updated'——工具据此告知模型，形成防重复写的反馈回路。 */
export async function upsertMemory(input: {
  scope: 'product_line' | 'global';
  productLineId: string | null;
  title: string;
  hook: string;
  body: string | null;
  provenance: 'user_stated' | 'ai_inferred';
  sourceThreadId: string | null;
  createdByUserId: string | null;
}): Promise<'created' | 'updated'> {
  const existing = (await db.select().from(assistantMemories)
    .where(and(
      eq(assistantMemories.status, 'active'),
      eq(assistantMemories.scope, input.scope),
      input.productLineId
        ? eq(assistantMemories.productLineId, input.productLineId)
        : isNull(assistantMemories.productLineId),
      eq(assistantMemories.title, input.title),
    )).limit(1))[0];
  if (existing) {
    await db.update(assistantMemories)
      .set({ hook: input.hook, body: input.body, provenance: input.provenance, updatedAt: new Date() })
      .where(eq(assistantMemories.id, existing.id));
    return 'updated';
  }
  await db.insert(assistantMemories).values({
    scope: input.scope,
    productLineId: input.productLineId,
    title: input.title,
    hook: input.hook,
    body: input.body,
    provenance: input.provenance,
    sourceThreadId: input.sourceThreadId,
    createdByUserId: input.createdByUserId,
  });
  return 'created';
}

/** read_memory 的模糊查：active + 可见作用域（global/本线）ILIKE %title%，updatedAt 降序。 */
export async function findMemoriesByTitle(productLineId: string, title: string): Promise<AssistantMemoryRow[]> {
  return db.select().from(assistantMemories)
    .where(and(
      eq(assistantMemories.status, 'active'),
      or(
        eq(assistantMemories.scope, 'global'),
        and(eq(assistantMemories.scope, 'product_line'), eq(assistantMemories.productLineId, productLineId)),
      ),
      ilike(assistantMemories.title, `%${title}%`),
    ))
    .orderBy(desc(assistantMemories.updatedAt));
}
