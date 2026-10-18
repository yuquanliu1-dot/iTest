/**
 * S1 常驻指令（assistant_guides）加载与渲染。
 * 加载点 = buildSpaceSystemPrompt 第三参 → 每轮 builderSystemPrompt 重算 → DB 改动对新线程热生效。
 */
import { and, eq, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantGuides } from '../../db/schema.js';
import { aiLangFrom, type AiLang } from '../../agent/langDirective.js';

export type AssistantGuideRow = typeof assistantGuides.$inferSelect;

/** 会话 lang → guide lang 匹配值；en-US → 'en'，其余（含 zh-CN/无）→ 'zh'。 */
export function guideLangOf(lang?: AiLang): 'zh' | 'en' {
  return aiLangFrom(lang ?? null) === 'en-US' ? 'en' : 'zh';
}

const SCOPE_RANK: Record<string, number> = { version: 0, project: 1, global: 2 };

/** 加载当前 (lang, projectId, versionId) 的启用 guides，按 scope 优先级 + sort 稳定排序。
 *  scope 优先级：version > project > global（同 scope 按 sort，再按 createdAt 保序）。
 *  同一 kind 可叠加（无互斥去重，由运营侧负责语义）。 */
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

/** 渲染 guides 为 system prompt 尾部两节：flow → # 流程指令，reference → # 知识参考。无则返回空串。 */
export function buildGuidesSection(guides: Array<Pick<AssistantGuideRow, 'kind' | 'body'>>): string {
  const flow = guides.filter((g) => g.kind === 'flow').map((g) => g.body).join('\n\n');
  const ref = guides.filter((g) => g.kind === 'reference').map((g) => g.body).join('\n\n');
  const parts: string[] = [];
  if (flow) parts.push(`# 流程指令\n\n${flow}`);
  if (ref) parts.push(`# 知识参考\n\n${ref}`);
  return parts.join('\n\n');
}