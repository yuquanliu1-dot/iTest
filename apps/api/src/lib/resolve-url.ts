import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, projects } from '../db/schema.js';

/** 默认域名解析链：用例.url → 分组.default_url → [环境.base_url] → 项目.default_url。
 *  envBaseUrl 仅执行期由调用方传入（envCtx.baseUrl）；录制/详情链不传。 */
export async function resolveCaseUrl(
  caseRow: { url: string | null; groupId: string },
  envBaseUrl?: string | null,
): Promise<string | null> {
  if (caseRow.url) return caseRow.url;
  const g = (await db.select().from(groups).where(eq(groups.id, caseRow.groupId)))[0];
  if (!g) return null;
  if (g.defaultUrl) return g.defaultUrl;
  if (envBaseUrl) return envBaseUrl;
  const p = (await db.select().from(projects).where(eq(projects.id, g.projectId)))[0];
  return p?.defaultUrl ?? null;
}
