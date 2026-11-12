/**
 * S1 resident guides (assistant_guides) loading and rendering.
 * Load point = buildSpaceSystemPrompt's third argument → builderSystemPrompt recomputed every turn → DB changes take hot effect on new threads.
 */
import { and, eq, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantGuides } from '../../db/schema.js';
import { aiLangFrom, type AiLang } from '../../agent/langDirective.js';

export type AssistantGuideRow = typeof assistantGuides.$inferSelect;

/** Session lang → guide lang match value; en-US → 'en', everything else (including zh-CN/none) → 'zh'. */
export function guideLangOf(lang?: AiLang): 'zh' | 'en' {
  return aiLangFrom(lang ?? null) === 'en-US' ? 'en' : 'zh';
}

const SCOPE_RANK: Record<string, number> = { version: 0, project: 1, global: 2 };

/** Loads the enabled guides for the current (lang, projectId, versionId), stably sorted by scope priority + sort.
 *  Scope priority: version > project > global (within the same scope, by sort, then createdAt for stable order).
 *  Same kind can stack (no mutual exclusion/dedup — semantics are operations' responsibility). */
export async function loadActiveGuides(opts: { projectId: string; versionId: string; lang?: AiLang }): Promise<AssistantGuideRow[]> {
  const rows = await db
    .select()
    .from(assistantGuides)
    .where(and(
      eq(assistantGuides.enabled, true),
      or(
        eq(assistantGuides.lang, 'any'),
        eq(assistantGuides.lang, guideLangOf(opts.lang)),
      ),
      or(
        eq(assistantGuides.scope, 'global'),
        and(eq(assistantGuides.scope, 'project'), eq(assistantGuides.projectId, opts.projectId)),
        and(eq(assistantGuides.scope, 'version'), eq(assistantGuides.versionId, opts.versionId)),
      ),
    ));
  return rows.sort((a, b) =>
    SCOPE_RANK[a.scope]! - SCOPE_RANK[b.scope]!
    || a.sort - b.sort
    || a.createdAt.getTime() - b.createdAt.getTime());
}

/** Renders guides as the system prompt's trailing two sections: flow → the `# 流程指令` heading, reference → the `# 知识参考` heading. Returns '' when none. */
export function buildGuidesSection(guides: Array<Pick<AssistantGuideRow, 'kind' | 'body'>>): string {
  const flow = guides.filter((g) => g.kind === 'flow').map((g) => g.body).join('\n\n');
  const ref = guides.filter((g) => g.kind === 'reference').map((g) => g.body).join('\n\n');
  const parts: string[] = [];
  if (flow) parts.push(`# 流程指令\n\n${flow}`);
  if (ref) parts.push(`# 知识参考\n\n${ref}`);
  return parts.join('\n\n');
}