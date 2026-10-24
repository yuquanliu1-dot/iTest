/**
 * 版本空间上下文摘要:经 system prompt 注入(线程创建时),让 AI 免查直答"有哪些环境/分组/需求"。
 * 上限防 prompt 膨胀;密钥只计数量,绝不进摘要。
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { datasets, deviceTargets, environmentObjects, executionPlans, groups, productLines, projectVersions, projects, requirements, testCases, testEnvironments } from '../../db/schema.js';
import { webEntriesOf } from '../../lib/resolve-url.js';

export interface SpaceSummary {
  projectId: string;
  text: string;
}

const MAX_ENVS = 20;
const MAX_GROUPS = 40;
const MAX_REQS = 20;
const MAX_DEVICES = 10;
const MAX_DATASETS = 20;

/** 摘要单字段预算:项目描述超 100 字截断。 */
function clip100(s: string): string {
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
}

export async function buildSpaceSummary(versionId: string): Promise<SpaceSummary> {
  const v = (await db
    .select({
      versionName: projectVersions.name,
      ref: projectVersions.ref,
      refKind: projectVersions.refKind,
      projectId: projectVersions.projectId,
      projectName: projects.name,
      projectDescription: projects.description,
      productLineName: productLines.name,
    })
    .from(projectVersions)
    .innerJoin(projects, eq(projectVersions.projectId, projects.id))
    .innerJoin(productLines, eq(projects.productLineId, productLines.id))
    .where(eq(projectVersions.id, versionId))
    .limit(1))[0];
  if (!v) throw new Error('version not found');

  const lines: string[] = [];
  const refText = v.ref ? `(${v.refKind === 'tag' ? 'tag' : 'branch'} ${v.ref})` : '';
  lines.push(`产品线:${v.productLineName} / 项目:${v.projectName} / 版本:${v.versionName}${refText}`);
  if (v.projectDescription) lines.push(`项目描述:${clip100(v.projectDescription)}`);

  const envs = await db
    .select({ id: testEnvironments.id, name: testEnvironments.name, isDefault: testEnvironments.isDefault })
    .from(testEnvironments)
    .where(eq(testEnvironments.projectId, v.projectId))
    .limit(MAX_ENVS + 1);
  const shownEnvs = envs.slice(0, MAX_ENVS);
  const webObjs = shownEnvs.length
    ? await db.select({ environmentId: environmentObjects.environmentId, label: environmentObjects.label, isDefault: environmentObjects.isDefault, payload: environmentObjects.payload })
        .from(environmentObjects)
        .where(and(eq(environmentObjects.objectType, 'web'), inArray(environmentObjects.environmentId, shownEnvs.map((e) => e.id))))
    : [];
  const webByEnv = new Map<string, Array<{ name: string | null; origin: string; isDefault: boolean }>>();
  for (const o of webObjs) {
    const list = webByEnv.get(o.environmentId) ?? [];
    for (const w of webEntriesOf([o])) list.push({ name: w.name, origin: w.origin, isDefault: w.isDefault });
    webByEnv.set(o.environmentId, list);
  }
  if (envs.length === 0) {
    lines.push('环境:无');
  } else {
    const parts = shownEnvs.map((e) => `${e.name}${e.isDefault ? '[默认]' : ''}`);
    lines.push(`环境:${parts.join('、')}${envs.length > MAX_ENVS ? ' …' : ''}`);
    for (const e of shownEnvs) {
      const webServices = webByEnv.get(e.id) ?? [];
      if (webServices.length) lines.push(`web 服务:${webServices.map((w) => `${w.name ?? (w.isDefault ? '(默认)' : '(未命名)')}=${w.origin}`).join(', ')}`);
    }
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

  const devices = await db
    .select({ name: deviceTargets.name, mobileOs: deviceTargets.mobileOs })
    .from(deviceTargets)
    .where(eq(deviceTargets.projectId, v.projectId))
    .limit(MAX_DEVICES + 1);
  if (devices.length > 0) {
    lines.push(`设备目标(移动用例):${devices.slice(0, MAX_DEVICES).map((d) => `${d.name}(${d.mobileOs})`).join('、')}${devices.length > MAX_DEVICES ? ' …' : ''}`);
  }

  const dss = await db
    .select({ name: datasets.name, rowCount: datasets.rows })
    .from(datasets)
    .where(eq(datasets.projectId, v.projectId))
    .limit(MAX_DATASETS + 1);
  if (dss.length > 0) {
    lines.push(`数据集:${dss.slice(0, MAX_DATASETS).map((d) => `${d.name}(${(d.rowCount as unknown[]).length}行)`).join('、')}${dss.length > MAX_DATASETS ? ' …' : ''}`);
  }

  const caseCount = (await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.versionId, versionId))).length;
  const planCount = (await db.select({ id: executionPlans.id }).from(executionPlans).where(eq(executionPlans.versionId, versionId))).length;
  lines.push(`统计:本版本用例 ${caseCount} 条,执行计划 ${planCount} 个。`);

  return { projectId: v.projectId, text: lines.join('\n') };
}
