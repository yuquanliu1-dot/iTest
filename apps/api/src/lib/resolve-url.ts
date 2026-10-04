import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, testEnvironments } from '../db/schema.js';

/** 默认域名解析链：用例.url → 分组.default_url → [envBaseUrl] → [项目默认环境.base_url]。
 *  执行链（runCase）传 envBaseUrl=已解析环境 URL，不额外兜底；录制/展示链传
 *  defaultEnvFallback=true，兜底到项目默认环境（项目级 default_url 已删，0026）。 */
export async function resolveCaseUrl(
  caseRow: { url: string | null; groupId: string },
  o: { envBaseUrl?: string | null; defaultEnvFallback?: boolean } = {},
): Promise<string | null> {
  if (caseRow.url) return caseRow.url;
  const g = (await db.select().from(groups).where(eq(groups.id, caseRow.groupId)))[0];
  if (!g) return null;
  if (g.defaultUrl) return g.defaultUrl;
  if (o.envBaseUrl) return o.envBaseUrl;
  if (o.defaultEnvFallback) {
    const e = (
      await db
        .select()
        .from(testEnvironments)
        .where(and(eq(testEnvironments.projectId, g.projectId), eq(testEnvironments.isDefault, true)))
    )[0];
    return e?.baseUrl ?? null;
  }
  return null;
}
