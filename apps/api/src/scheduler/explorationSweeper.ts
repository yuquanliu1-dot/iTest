/**
 * 探索会话看门狗：把「执行器已死、状态却还停在 running」的僵死会话判死。
 *
 * 场景（2026-11-11 发版实证的问题）：发版重建 api 容器 → 执行器进程被杀 →
 * exec worker 的 catch 只写日志不写状态（execWorker.ts）→ 会话永远 running →
 * 删除永远 409（routes/explorations.ts），用户既删不掉也看不到原因。
 *
 * 判据 = 心跳超时。心跳由 runner 每轮对话前刷新（exploration.ts 的 heartbeat()），
 * 窗口必须宽于单轮最坏耗时（LLM 慢调用），否则会把活会话误判死。
 * 多副本同时扫无害：UPDATE 条件含 status='running'，判过的不再命中。
 */
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { explorationSessions } from '../db/schema.js';
import { logger } from '../logger.js';

/** 心跳窗口：5 分钟无心跳判死（单轮 LLM 调用最坏 1~2 分钟，允许连续 2~3 轮慢调用不误杀）。 */
export const EXPLORATION_STALE_MS = 5 * 60_000;

/** 判死僵死的 running 会话，返回被判死的条数。 */
export async function sweepStaleExplorations(): Promise<number> {
  const cutoff = new Date(Date.now() - EXPLORATION_STALE_MS);
  const stale = await db
    .update(explorationSessions)
    .set({
      status: 'failed',
      error: '执行器中断（心跳超时，会话未正常收尾）——可按同一章程重跑',
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(explorationSessions.status, 'running'),
        or(isNull(explorationSessions.heartbeatAt), lt(explorationSessions.heartbeatAt, cutoff)),
      ),
    )
    .returning({ id: explorationSessions.id });
  if (stale.length > 0) {
    logger.warn({ count: stale.length, cutoff: cutoff.toISOString() }, 'exploration stale sweep marked sessions failed');
  }
  return stale.length;
}

/** 启动时扫一次 + 之后每分钟扫一次。unref：不拖住进程退出。 */
export async function startExplorationSweeper(): Promise<void> {
  try {
    await sweepStaleExplorations();
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'exploration stale sweep failed');
  }
  const timer = setInterval(() => {
    void sweepStaleExplorations().catch((e) => logger.warn({ err: (e as Error).message }, 'exploration stale sweep failed'));
  }, 60_000);
  timer.unref?.();
}
