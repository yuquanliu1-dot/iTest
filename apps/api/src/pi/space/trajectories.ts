/**
 * 轨迹库（产品线级）核心服务：加载/索引渲染/打分检索/幂等插入。
 * 设计：docs/superpowers/specs/2026-10-31-assistant-trajectory-store-design.md
 * 注入走 buildSpaceSystemPrompt 轨迹索引段（线程冷构建时快照；会话内新鲜轨迹走
 * search_trajectories 实时查库）。
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantTrajectories } from '../../db/schema.js';

export type TrajectoryRow = typeof assistantTrajectories.$inferSelect;

/** 注入预算（硬编码常量；膨胀治理归 R3 退役机制）。 */
export const TRAJECTORY_MAX_LISTED = 10;
export const TRAJECTORY_SECTION_MAX_CHARS = 1_500;
/** 检索加载上限：线内轨迹量级安全网。 */
const SEARCH_SCAN_LIMIT = 200;
export const SEARCH_TOP_K = 3;

/** 加载某产品线 active 轨迹，updatedAt 降序。 */
export async function loadActiveTrajectories(productLineId: string): Promise<TrajectoryRow[]> {
  return db.select().from(assistantTrajectories)
    .where(and(eq(assistantTrajectories.productLineId, productLineId), eq(assistantTrajectories.status, 'active')))
    .orderBy(desc(assistantTrajectories.updatedAt))
    .limit(TRAJECTORY_MAX_LISTED);
}

/** 渲染轨迹索引段：一行指引 + `- task_title（用例：case_title）` 清单 + 脚注；空 → ''。 */
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

/** 打分：query 按空白切词，term 对 taskTitle/taskKeywords/caseTitle 三字段做大小写不敏感包含，
 *  命中字段数为分。纯函数（测试直测）。 */
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

/** 检索：线内 active 全量（≤SCAN_LIMIT）打分，top-k；命中行 hit_count/last_hit_at SQL 原子自增。
 *  返回 { hits, all }——miss 时 all 供工具层给可用标题清单（read_memory 模式）。 */
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
    // SQL 表达式自增：三副本并发不丢更新（R1 read_memory 同款）。
    await db.update(assistantTrajectories)
      .set({ hitCount: sql`${assistantTrajectories.hitCount} + 1`, lastHitAt: new Date() })
      .where(inArray(assistantTrajectories.id, hits.map((h) => h.id)));
  }
  return { hits, all };
}

/** 幂等插入：ON CONFLICT DO NOTHING（partial unique source_case_id where active）。
 *  返回是否真正插入。 */
export async function insertTrajectory(
  input: typeof assistantTrajectories.$inferInsert,
): Promise<boolean> {
  const rows = await db.insert(assistantTrajectories).values(input).onConflictDoNothing().returning({ id: assistantTrajectories.id });
  return rows.length > 0;
}
