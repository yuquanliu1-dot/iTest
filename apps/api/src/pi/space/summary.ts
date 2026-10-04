/**
 * 版本空间上下文摘要:随线程首条用户消息注入,让 AI 免查直答"有哪些环境/分组/需求"。
 * 上限防 prompt 膨胀;密钥只计数量,绝不进摘要。
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { executionPlans, groups, projectVersions, projects, requirements, testCases, testEnvironments } from '../../db/schema.js';

export interface SpaceSummary {
  projectId: string;
  text: string;
}

const MAX_ENVS = 20;
const MAX_GROUPS = 40;
const MAX_REQS = 20;

export async function buildSpaceSummary(versionId: string): Promise<SpaceSummary> {
  const v = (await db
    .select({
      versionName: projectVersions.name,
      ref: projectVersions.ref,
      refKind: projectVersions.refKind,
      projectId: projectVersions.projectId,
      projectName: projects.name,
    })
    .from(projectVersions)
    .innerJoin(projects, eq(projectVersions.projectId, projects.id))
    .where(eq(projectVersions.id, versionId))
    .limit(1))[0];
  if (!v) throw new Error('version not found');

  const lines: string[] = [];
  const refText = v.ref ? `(${v.refKind === 'tag' ? 'tag' : 'branch'} ${v.ref})` : '';
  lines.push(`项目:${v.projectName} / 版本:${v.versionName}${refText}`);

  const envs = await db
    .select({ name: testEnvironments.name, baseUrl: testEnvironments.baseUrl, isDefault: testEnvironments.isDefault })
    .from(testEnvironments)
    .where(eq(testEnvironments.projectId, v.projectId))
    .limit(MAX_ENVS + 1);
  if (envs.length === 0) {
    lines.push('环境:无');
  } else {
    const parts = envs.slice(0, MAX_ENVS).map((e) => `${e.name}${e.baseUrl ? `(${e.baseUrl})` : ''}${e.isDefault ? '[默认]' : ''}`);
    lines.push(`环境:${parts.join('、')}${envs.length > MAX_ENVS ? ' …' : ''}`);
  }

  const gs = await db
    .select({ name: groups.name })
    .from(groups)
    .where(eq(groups.projectId, v.projectId))
    .limit(MAX_GROUPS + 1);
  if (gs.length > 0) {
    lines.push(`用例分组:${gs.slice(0, MAX_GROUPS).map((g) => g.name).join('、')}${gs.length > MAX_GROUPS ? ' …' : ''}`);
  }

  // 场景从属需求(scenarios.requirement_id 非空),AI 操作场景前需要能对上需求 id
  const reqs = await db
    .select({ id: requirements.id, title: requirements.title })
    .from(requirements)
    .where(eq(requirements.projectId, v.projectId))
    .limit(MAX_REQS + 1);
  if (reqs.length > 0) {
    lines.push(`需求(操作场景时引用其 id):${reqs.slice(0, MAX_REQS).map((r) => `${r.title}=${r.id}`).join('、')}${reqs.length > MAX_REQS ? ' …' : ''}`);
  }

  const caseCount = (await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.versionId, versionId))).length;
  const planCount = (await db.select({ id: executionPlans.id }).from(executionPlans).where(eq(executionPlans.versionId, versionId))).length;
  lines.push(`统计:本版本用例 ${caseCount} 条,执行计划 ${planCount} 个。`);

  return { projectId: v.projectId, text: lines.join('\n') };
}
