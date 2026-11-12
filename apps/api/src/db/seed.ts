/**
 * Startup seed: assistant_guides built-in behaviors (REQ_DESIGN_METHOD + CASE_AUTHORING_FLOW × zh/en + CAPABILITY_BOUNDARY).
 * Fixed-UUID idempotency (ON CONFLICT (id) DO NOTHING); a second startup does not re-insert.
 *
 * ⚠ The "4 rows" claimed in spec §测试 doesn't hold: REQ_DESIGN_METHOD has only one Chinese source text,
 *   so lang='any' (hits both zh/en) keeps behavior unchanged → seed actually has 3 rows; 004 capability boundary is also any → 4 rows total.
 */
import { REQ_DESIGN_METHOD, CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN, CAPABILITY_BOUNDARY } from '../pi/space/reqDesign.js';

const GUIDE_SEED = [
  { id: '00000000-0000-0000-0000-000000000001', kind: 'flow', lang: 'any', body: REQ_DESIGN_METHOD },
  { id: '00000000-0000-0000-0000-000000000002', kind: 'flow', lang: 'zh', body: CASE_AUTHORING_FLOW_ZH },
  { id: '00000000-0000-0000-0000-000000000003', kind: 'flow', lang: 'en', body: CASE_AUTHORING_FLOW_EN },
  { id: '00000000-0000-0000-0000-000000000004', kind: 'flow', lang: 'any', body: CAPABILITY_BOUNDARY },
] as const;

/** Idempotent seed; failures propagate upward → migrate entry catches → process.exit(1) (never let the container start with a partial seed).
 *  Note: these 4 fixed-UUID rows re-seed on every migrate (ON CONFLICT DO NOTHING). To disable a built-in guide,
 *  PATCH enabled=false (or edit the body); never DELETE — deleted rows are re-inserted on the next container startup. */
export async function seedAssistantGuides(client: Pick<import('pg').Client, 'query'>): Promise<void> {
  for (const g of GUIDE_SEED) {
    await client.query(
      `INSERT INTO assistant_guides (id, scope, kind, lang, body, sort, enabled)
       VALUES ($1, 'global', $2, $3, $4, 0, true)
       ON CONFLICT (id) DO NOTHING`,
      [g.id, g.kind, g.lang, g.body],
    );
  }
}
