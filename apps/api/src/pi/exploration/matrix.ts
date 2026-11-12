/**
 * Persona matrix (C3) and cross-session intersection (S2).
 *
 * C3: N persona sessions run in parallel from the same charter (grouped by the same matrix_id). **No new table** —
 * the matrix_id (group key) / matrix_label (display name) / matrix_role (role=persona) columns hang off
 * exploration_sessions; the matrix view just aggregates by matrix_id.
 *
 * S2: when the matrix wraps up, cross-session intersections are computed by "same origin + near-identical title" →
 * written to findings.cross_session_count. The intersection is only an **annotation** (≥2 = found together from multiple
 * perspectives); it never changes findings.status — human review is the authority.
 *
 * Reused rules: near-duplicate detection uses isNearDuplicate (the same copy as in-session dedup: Dice 0.72 + matching
 * position/subject words), title normalization uses normalizeTitle (the same copy) — drift between the two would make the
 * "found together from multiple perspectives" numbers disagree with in-session dedup results.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { explorationFindings, explorationSessions } from '../../db/schema.js';
import { isNearDuplicate, normalizeTitle } from '../../execute/explorationPrompt.js';
import { originOf } from '../../execute/gates.js';
import { logger } from '../../logger.js';

/** Cross-session same-source grouping key: an explicit start-origin takes precedence; with no start origin, same version + same environment → treated as same source.
 *  Different origins are never compared — same-named defects on two different sites are not "found together from multiple perspectives". */
export function matrixOriginKey(session: { startUrl: string | null; versionId: string }): string {
  const origin = session.startUrl ? originOf(session.startUrl) : null;
  return origin ?? `version:${session.versionId}`;
}

/**
 * Recomputes cross-session hit counts for findings in the matrix (one finding = how many sessions reported the same defect).
 * Idempotent: recompute the whole matrix, then write back by delta. Never throws — the wrap-up chain must not blow up because of it.
 */
export async function recomputeMatrixIntersection(matrixId: string): Promise<void> {
  try {
    const sessions = await db
      .select({ id: explorationSessions.id, startUrl: explorationSessions.startUrl, versionId: explorationSessions.versionId })
      .from(explorationSessions)
      .where(eq(explorationSessions.matrixId, matrixId));
    if (sessions.length < 2) return; // A single session has no "cross-session"
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
