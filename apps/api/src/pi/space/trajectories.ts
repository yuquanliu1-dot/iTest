/**
 * Trajectory store (product-line level) core service: load / index rendering / scored retrieval / idempotent insert.
 * Design: docs/superpowers/specs/2026-10-31-assistant-trajectory-store-design.md
 * Injection goes through buildSpaceSystemPrompt's trajectory-index section (snapshotted at thread cold build; fresh in-session
 * trajectories go through search_trajectories real-time DB queries).
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantTrajectories } from '../../db/schema.js';

export type TrajectoryRow = typeof assistantTrajectories.$inferSelect;

/** Injection budget (hardcoded constant; bloat governance belongs to the R3 retirement mechanism). */
export const TRAJECTORY_MAX_LISTED = 10;
export const TRAJECTORY_SECTION_MAX_CHARS = 1_500;
/** Retrieval scan cap: a safety net for in-line trajectory volume. */
const SEARCH_SCAN_LIMIT = 200;
export const SEARCH_TOP_K = 3;

/** Load a product line's active trajectories, updatedAt descending. */
export async function loadActiveTrajectories(productLineId: string): Promise<TrajectoryRow[]> {
  return db.select().from(assistantTrajectories)
    .where(and(eq(assistantTrajectories.productLineId, productLineId), eq(assistantTrajectories.status, 'active')))
    .orderBy(desc(assistantTrajectories.updatedAt))
    .limit(TRAJECTORY_MAX_LISTED);
}

/** Render the trajectory-index section: one guidance line + a `- task_title（用例：case_title）` list + footer; empty → ''. */
export function buildTrajectoriesSection(rows: Array<Pick<TrajectoryRow, 'taskTitle' | 'caseTitle'>>): string {
  if (rows.length === 0) return '';
  const header = '# 成功用例轨迹';
  const intro = '本产品线已沉淀同类任务的成功生成轨迹（按时间倒序）。开始设计用例前，先用任务关键词调用 search_trajectories 检索相似轨迹参考。';
  const footer = '参考轨迹取其决策思路与用例形态；锚点、URL、账号等线内事实必须以当前应用实测为准，禁止照抄。';
  const kept: string[] = [];
  for (const r of rows) {
    const line = `- ${r.taskTitle}（用例：${r.caseTitle}）`;
    const size = header.length + intro.length + footer.length + [...kept, line].join('\n').length + 3;
    if (kept.length > 0 && size > TRAJECTORY_SECTION_MAX_CHARS) break;
    kept.push(line);
  }
  return `${header}\n${intro}\n${kept.join('\n')}\n${footer}`;
}

/** Scoring: split the query on whitespace, each term case-insensitively contains-matches taskTitle/taskKeywords/caseTitle,
 *  score = number of matching fields. Pure function (unit-tested directly). */
export function scoreTrajectory(
  row: Pick<TrajectoryRow, 'taskTitle' | 'taskKeywords' | 'caseTitle'>,
  query: string,
): number {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const fields = [row.taskTitle, row.taskKeywords, row.caseTitle].map((s) => s.toLowerCase());
  let score = 0;
  for (const f of fields) if (terms.some((t) => f.includes(t))) score += 1;
  return score;
}

/** Retrieval: score the line's active rows in full (≤SCAN_LIMIT), take top-k; hit rows get hit_count/last_hit_at atomically incremented via SQL.
 *  Returns { hits, all } — on miss, all feeds the tool layer's available-titles listing (read_memory pattern). */
export async function searchTrajectoriesByQuery(
  productLineId: string,
  query: string,
): Promise<{ hits: TrajectoryRow[]; all: TrajectoryRow[] }> {
  const all = await db.select().from(assistantTrajectories)
    .where(and(eq(assistantTrajectories.productLineId, productLineId), eq(assistantTrajectories.status, 'active')))
    .orderBy(desc(assistantTrajectories.updatedAt))
    .limit(SEARCH_SCAN_LIMIT);
  const scored = all
    .map((r) => ({ r, s: scoreTrajectory(r, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.r.updatedAt.getTime() - a.r.updatedAt.getTime());
  const hits = scored.slice(0, SEARCH_TOP_K).map((x) => x.r);
  if (hits.length > 0) {
    // SQL-expression increment: three-replica concurrency doesn't lose updates (same as R1 read_memory).
    await db.update(assistantTrajectories)
      .set({ hitCount: sql`${assistantTrajectories.hitCount} + 1`, lastHitAt: new Date() })
      .where(inArray(assistantTrajectories.id, hits.map((h) => h.id)));
  }
  return { hits, all };
}

/** Idempotent insert: ON CONFLICT DO NOTHING (partial unique source_case_id where active).
 *  Single intake-sanitization chokepoint: strip \n/\r from taskTitle/taskKeywords (guards newline-forged system-prompt section structure);
 *  taskTitle≤200 (column width) / taskKeywords≤500 / digest≤8000 truncation. Returns whether a row was truly inserted. */
export async function insertTrajectory(
  input: typeof assistantTrajectories.$inferInsert,
): Promise<boolean> {
  const clean = {
    ...input,
    taskTitle: input.taskTitle.replace(/[\r\n]/g, ' ').slice(0, 200),
    taskKeywords: input.taskKeywords.replace(/[\r\n]/g, ' ').slice(0, 500),
    digest: input.digest.slice(0, 8_000),
  };
  const rows = await db.insert(assistantTrajectories).values(clean).onConflictDoNothing().returning({ id: assistantTrajectories.id });
  return rows.length > 0;
}
