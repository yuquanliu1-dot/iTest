/**
 * Short-term memory (product-line level) core service: load/render/upsert/fuzzy search.
 * Design: docs/superpowers/specs/2026-10-31-assistant-shortterm-memory-design.md
 * Injection goes through buildSpaceSystemPrompt's memory-index section (snapshotted at thread cold-build;
 * fresh in-session data goes through read_memory's live DB query).
 */
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantMemories, projects } from '../../db/schema.js';

export type AssistantMemoryRow = typeof assistantMemories.$inferSelect;

/** Injection budget (hardcoded constants; bloat governance belongs to R3's retirement mechanism — not a config item). */
export const MEMORY_MAX_ENTRIES = 50;
export const MEMORY_SECTION_MAX_CHARS = 4_000;

/** Project → product line resolution (shared by save_memory and the session factory injection). Projects always belong to a line (structural invariant). */
export async function resolveProductLineId(projectId: string): Promise<string | null> {
  const rows = await db.select({ id: projects.productLineId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  return rows[0]?.id ?? null;
}

/** Loads active memories visible to a product line (global + this line), updatedAt descending, capped by the entry limit. */
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

/** Renders the memory-index section: `- [title] hook` one line per entry + footer; over the char budget it truncates to the last complete line; empty → ''. */
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

/** upsert: when an active row with the same (scope, productLineId, title) exists it is updated, otherwise inserted.
 *  Returns 'created' | 'updated' — the tool reports it back to the model, forming an anti-duplicate-write feedback loop. */
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
    )).orderBy(desc(assistantMemories.updatedAt)).limit(1))[0];
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

/** read_memory's fuzzy search: active + visible scopes (global/this line), ILIKE %title%, updatedAt descending. */
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
