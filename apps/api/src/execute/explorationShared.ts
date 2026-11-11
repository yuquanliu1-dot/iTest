/**
 * 探索式测试会话的共享底座：认领 / 心跳 / 收尾 / 证据路径 / 超时竞速。
 *
 * 抽自 execute/exploration.ts——探索执行核心换 pi 工具链后（pi/exploration/runner.ts），
 * 这几个与运行时无关的编排件必须两链路共用同一份：认领幂等、心跳窗口、
 * 「先落留痕再置终态」的收尾语义一旦漂移，取消/看门狗/详情页时序会在两条链路上表现不一致。
 */
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { explorationSessions } from '../db/schema.js';
import { recomputeMatrixIntersection } from '../pi/exploration/matrix.js';
import { logger } from '../logger.js';

/** 轮次预算默认值（用户可在创建会话时覆盖，4~60；null=用这里）：超界走 shouldAbort 优雅收尾
 *  （findings 全保留）。runAiTask 硬闸 = 预算 +16 仅 runaway 兜底——硬闸随预算放大，
 *  否则用户配大轮次会被固定硬闸先拦，可配置形同虚设。 */
export const EXPLORATION_MAX_TURNS = 24;
/** 探索墙钟：轮数预算放大时不随之放大（防单轮卡死，与探索深度无关）。legacy/pi 两链路共用。 */
export const EXPLORATION_WALL_CLOCK_MS = 15 * 60_000;

/** 等待侧超时：竞速到点即抛错。底层 promise 迟到 settle 不会变 unhandledRejection
 *  （Promise.race 对两个 promise 都挂了处理器）。 */
export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function screenshotDiskPath(sessionId: string, order: number): string {
  return join(process.cwd(), 'screenshots', sessionId, `finding-${order}.png`);
}

/** 会话总结补「模型报 N 条 / 落库 M 条」——避免摘要说几条、库里 0 条的自相矛盾。 */
export function withFindingCounts(summary: string | null | undefined, modelReported: number, savedCount: number): string | null {
  const base = (summary ?? '').trim();
  if (modelReported === 0) return base || null;
  const note = `模型报告 ${modelReported} 条，落库 ${savedCount} 条`;
  return base ? `${base}（${note}）` : `（${note}）`;
}

/**
 * 每轮心跳：刷新 heartbeat_at（看门狗据此判死僵死会话——发版重建容器 → 进程被杀 →
 * status 永远 running → 删除永远 409），顺带读取消标志（同一句 SQL 省一次往返）。
 */
export async function heartbeat(sessionId: string): Promise<boolean> {
  const row = (await db
    .update(explorationSessions)
    .set({ heartbeatAt: new Date(), updatedAt: new Date() })
    .where(eq(explorationSessions.id, sessionId))
    .returning({ cancelRequested: explorationSessions.cancelRequested }))[0];
  return row?.cancelRequested ?? false;
}

/** 幂等认领：pending → running（原子条件更新），输家（重复 job/已删）直接 bail。 */
export async function claimSession(sessionId: string): Promise<boolean> {
  const now = new Date();
  const claimed = await db
    .update(explorationSessions)
    .set({ status: 'running', startedAt: now, heartbeatAt: now, updatedAt: now })
    .where(and(eq(explorationSessions.id, sessionId), eq(explorationSessions.status, 'pending')))
    .returning({ id: explorationSessions.id });
  return claimed.length > 0;
}

export async function finishSession(
  sessionId: string,
  patch: { status: string; summary?: string | null; error?: string | null; turnsUsed: number; usage: unknown },
): Promise<void> {
  await db
    .update(explorationSessions)
    .set({
      status: patch.status,
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      turnsUsed: patch.turnsUsed,
      usage: patch.usage as object,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(explorationSessions.id, sessionId));
  // S2 跨会话交集：矩阵会话置终态后重算（fire-and-forget，best-effort；recompute 自身永不抛错）。
  // 单会话 matrixId 为 null → 一次轻查询后返回。两链路共用这一处：交集随任一成员收尾即刻更新。
  const mid = (
    await db
      .select({ matrixId: explorationSessions.matrixId })
      .from(explorationSessions)
      .where(eq(explorationSessions.id, sessionId))
  )[0]?.matrixId;
  if (mid) void recomputeMatrixIntersection(mid).catch((e) => logger.warn({ err: e, matrixId: mid }, 'matrix recompute failed'));
}
