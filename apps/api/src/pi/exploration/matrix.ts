/**
 * 人格矩阵（C3）与跨会话交集（S2）。
 *
 * C3：同一章程起 N 个人格会话并行跑（同一 matrix_id 分组）。**不新建表**——
 * matrix_id（分组键）/ matrix_label（展示名）/ matrix_role（角色=persona）三列挂在
 * exploration_sessions 上；矩阵视图按 matrix_id 聚合即可。
 *
 * S2：矩阵收尾时按「同一 origin + 标题近义」算跨会话交集 → 写 findings.cross_session_count。
 * 交集只是**标注**（≥2 = 多视角共同发现），绝不改 findings.status——人工审阅才是权威。
 *
 * 口径复用：近义判定用 isNearDuplicate（与会话内去重同一份，Dice 0.72 + 位置/主体词一致），
 * 标题归一用 normalizeTitle（同一份）——两处漂移会让「多视角共同发现」的数字对不上会话内去重结果。
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { explorationFindings, explorationSessions } from '../../db/schema.js';
import { isNearDuplicate, normalizeTitle } from '../../execute/explorationPrompt.js';
import { originOf } from '../../execute/gates.js';
import { logger } from '../../logger.js';

/** 跨会话同源分组键：显式起点 origin 优先；没填起点时同版本同环境 → 视作同源。
 *  跨 origin 不比——两个不同站点的同名缺陷不是「多视角共同发现」。 */
export function matrixOriginKey(session: { startUrl: string | null; versionId: string }): string {
  const origin = session.startUrl ? originOf(session.startUrl) : null;
  return origin ?? `version:${session.versionId}`;
}

/**
 * 重算矩阵内 findings 的跨会话命中数（一条 finding = 几个会话报了同一缺陷）。
 * 幂等：整矩阵重算后按差量回写。永不抛错——收尾链路不能因它炸掉。
 */
export async function recomputeMatrixIntersection(matrixId: string): Promise<void> {
  try {
    const sessions = await db
      .select({ id: explorationSessions.id, startUrl: explorationSessions.startUrl, versionId: explorationSessions.versionId })
      .from(explorationSessions)
      .where(eq(explorationSessions.matrixId, matrixId));
    if (sessions.length < 2) return; // 单会话没有「跨会话」
    const byOrigin = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const key = matrixOriginKey(s);
      const arr = byOrigin.get(key) ?? [];
      arr.push(s);
      byOrigin.set(key, arr);
    }
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const findings = await db
      .select({
        id: explorationFindings.id,
        sessionId: explorationFindings.sessionId,
        title: explorationFindings.title,
        crossSessionCount: explorationFindings.crossSessionCount,
      })
      .from(explorationFindings)
      .where(inArray(explorationFindings.sessionId, sessions.map((s) => s.id)));
    for (const f of findings) {
      const owner = byId.get(f.sessionId);
      if (!owner) continue;
      const group = byOrigin.get(matrixOriginKey(owner)) ?? [];
      const myTitle = normalizeTitle(f.title);
      let count = 1;
      for (const other of group) {
        if (other.id === f.sessionId) continue;
        const hit = findings.some(
          (x) => x.sessionId === other.id && isNearDuplicate(myTitle, normalizeTitle(x.title)),
        );
        if (hit) count += 1;
      }
      if (count !== f.crossSessionCount) {
        await db
          .update(explorationFindings)
          .set({ crossSessionCount: count })
          .where(eq(explorationFindings.id, f.id));
      }
    }
  } catch (e) {
    logger.warn({ err: e, matrixId }, 'matrix intersection recompute failed');
  }
}
