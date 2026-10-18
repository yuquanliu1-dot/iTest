/**
 * 启动 seed：assistant_guides 内置行为（REQ_DESIGN_METHOD + CASE_AUTHORING_FLOW × zh/en）。
 * 固定 UUID 幂等（ON CONFLICT (id) DO NOTHING），二次启动不重复插。
 *
 * ⚠ spec §测试 写的「4 行」不成立：REQ_DESIGN_METHOD 只有一份中文源文本，
 *   用 lang='any'（同时命中 zh/en）保持行为零变化 → seed 实际 3 行。
 */
import { REQ_DESIGN_METHOD, CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN } from '../pi/space/reqDesign.js';

const GUIDE_SEED = [
  { id: '00000000-0000-0000-0000-000000000001', kind: 'flow', lang: 'any', body: REQ_DESIGN_METHOD },
  { id: '00000000-0000-0000-0000-000000000002', kind: 'flow', lang: 'zh', body: CASE_AUTHORING_FLOW_ZH },
  { id: '00000000-0000-0000-0000-000000000003', kind: 'flow', lang: 'en', body: CASE_AUTHORING_FLOW_EN },
] as const;

/** 幂等 seed；失败时向上抛 → migrate 入口 catch → process.exit(1)（不让容器带着残缺 seed 起）。
 *  注意：这 3 行固定 UUID 每次 migrate 都会重 seed（ON CONFLICT DO NOTHING）。若运营想停用某条内置指令，
 *  应 PATCH enabled=false（或改 body），不要 DELETE——删掉的行会在下次容器启动被重新插回。 */
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