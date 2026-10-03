import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, projects, projectVersions } from '../db/schema.js';

/** 默认域名解析链：用例.url → 分组.default_url → 版本.default_url → 项目.default_url。 */
export async function resolveCaseUrl(caseRow: { url: string | null; groupId: string; versionId: string | null }): Promise<string | null> {
  if (caseRow.url) return caseRow.url;
  const g = (await db.select().from(groups).where(eq(groups.id, caseRow.groupId)))[0];
  if (!g) return null;
  if (g.defaultUrl) return g.defaultUrl;
  const p = (await db.select().from(projects).where(eq(projects.id, g.projectId)))[0];
  if (caseRow.versionId) {
    const v = (await db.select({ defaultUrl: projectVersions.defaultUrl }).from(projectVersions)
      .where(eq(projectVersions.id, caseRow.versionId)))[0];
    if (v?.defaultUrl) return v.defaultUrl;
  }
  return p?.defaultUrl ?? null;
}
