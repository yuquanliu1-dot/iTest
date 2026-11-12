import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

describe('cases.service', () => {
  it('createCase:同项目分组+版本创建成功并带 tags;version 跨项目 → version_mismatch', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const other = await seedProject(pool); // a second project
    const svc = await import('../src/services/cases.service.js');
    const created = await svc.createCase({ groupId, versionId, title: '登录-正常' });
    expect(created.title).toBe('登录-正常');
    expect(created.versionId).toBe(versionId);

    await expect(svc.createCase({ groupId, versionId: other.versionId, title: 'x' }))
      .rejects.toMatchObject({ status: 400, code: 'version_mismatch' });
    await expect(svc.createCase({ groupId: other.groupId, versionId, title: 'x' }))
      .rejects.toMatchObject({ status: 400, code: 'version_mismatch' });
  }, 30_000);

  it('createCaseWithSteps:无 compiled 的步骤落 null（未编译、不自动兜底 aiTask），断言原样规整', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    const c = await svc.createCaseWithSteps({
      groupId, versionId, title: '下单流程',
      steps: [
        { instruction: '打开首页' },
        { instruction: '点击下单按钮', assertion: '下单成功' },
        { instruction: '看结果', assertion: '登录表单正常展示' },
        // Visual mode: the caller supplies aiTask explicitly; persisted as-is
        { instruction: '让 AI 临场做', compiled: [{ kind: 'aiTask', instruction: '让 AI 临场做' }] },
      ],
    });
    const rows = (await pool.query(`SELECT "order", compiled, assertion FROM test_steps WHERE case_id=$1 ORDER BY "order"`, [c.id])).rows as Array<{
      order: number; compiled: Array<Record<string, unknown>> | null; assertion: Record<string, unknown> | null;
    }>;
    // Missing compiled is persisted as null = not compiled (the dispatcher blocks execution); the server does no aiTask fallback
    expect(rows).toHaveLength(4);
    for (const r of rows.slice(0, 3)) expect(r.compiled).toBeNull();
    // Explicit aiTask is preserved as-is
    expect(rows[3]!.compiled).toEqual([{ kind: 'aiTask', instruction: '让 AI 临场做' }]);
    expect((rows[1]!.assertion as { kind: string }).kind).toBe('assertText');
    expect((rows[1]!.assertion as { equals: string }).equals).toBe('下单成功');
    // Descriptive phrases are persisted as usual too -- wording judgment is left to verify_case's LLM (assertionJudge);
    // the write path no longer silently drops a user's assertion based on a word list
    expect((rows[2]!.assertion as { equals: string }).equals).toBe('登录表单正常展示');
  }, 30_000);

  it('createCaseWithSteps:断言只做形状规范化，措辞不参与入库判定', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    const c = await svc.createCaseWithSteps({
      groupId, versionId, title: '断言清洗验证',
      steps: [
        // Descriptive phrase: persisted as usual, judged by verify_case with an LLM on the real page
        { instruction: '打开登录页', assertion: '登录表单正常展示' },
        { instruction: '点登录', assertion: '登录成功' },
        { instruction: '看结果', assertion: '成功' },
        { instruction: '空白断言', assertion: '   ' },
      ],
    });
    const rows = (await pool.query(`SELECT "order", assertion FROM test_steps WHERE case_id=$1 ORDER BY "order"`, [c.id])).rows as Array<{
      order: number; assertion: Record<string, unknown> | null;
    }>;
    expect(rows[0]!.assertion).toEqual({
      kind: 'assertText', locator: [], target: 'page', match: 'contains', equals: '登录表单正常展示',
    });
    expect(rows[1]!.assertion).toEqual({
      kind: 'assertText', locator: [], target: 'page', match: 'contains', equals: '登录成功',
    });
    expect(rows[2]!.assertion).toEqual({
      kind: 'assertText', locator: [], target: 'page', match: 'contains', equals: '成功',
    });
    // Pure whitespace still normalizes to null (nothing to assert)
    expect(rows[3]!.assertion).toBeNull();
  }, 30_000);

  it('updateCase:scenario 不匹配 → 400;tagIds [] 清空;searchCasesInVersion 关键词过滤', async () => {
    const { groupId, versionId, projectId } = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    const c = await svc.createCase({ groupId, versionId, title: '搜索关键字X用例' });
    await svc.createCase({ groupId, versionId, title: '无关用例' });

    const hits = await svc.searchCasesInVersion(versionId, { keyword: '关键字x' });
    expect(hits.map((r) => r.id)).toEqual([c.id]);

    await expect(svc.updateCase(c.id, { scenarioId: '00000000-0000-0000-0000-000000000000' }))
      .rejects.toMatchObject({ status: 404 });
    const updated = await svc.updateCase(c.id, { title: '改名', tagIds: [] });
    expect(updated.title).toBe('改名');
    expect(updated.tags).toEqual([]);
  }, 30_000);

  it('searchCasesInVersion:召回面含步骤指令/标签/预期结果/描述;列表项形状不含这两个匹配字段', async () => {
    const seed = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    // Title doesn't carry the keyword; the hit comes from the step instruction
    const byStep = await svc.createCase({ groupId: seed.groupId, versionId: seed.versionId, title: '用例A' });
    await svc.insertCaseStep(byStep.id, { instruction: '在号码管理页点击导出按钮并等待列表刷新' });
    // Hit via tag name
    const byTag = await svc.createCase({ groupId: seed.groupId, versionId: seed.versionId, title: '用例B' });
    const tagId = (await pool.query(`INSERT INTO tags(organization_id, name, color) VALUES ($1,'导出回归','34c759') RETURNING id`, [seed.orgId])).rows[0]!.id as string;
    await pool.query(`INSERT INTO case_tags(case_id, tag_id) VALUES ($1,$2)`, [byTag.id, tagId]);
    // Hit via expected outcome
    const byOutcome = await svc.createCase({ groupId: seed.groupId, versionId: seed.versionId, title: '用例C', expectedOutcome: '页面提示导出成功' });
    // Hit via description
    const byDesc = await svc.createCase({ groupId: seed.groupId, versionId: seed.versionId, title: '用例D', description: '验证批量导出功能可用性' });
    // Control group: title/description/expected outcome/steps/tags all lack the keyword
    await svc.createCase({ groupId: seed.groupId, versionId: seed.versionId, title: '登录成功跳转首页' });

    const hits = await svc.searchCasesInVersion(seed.versionId, { keyword: '导出' });
    expect(hits.map((r) => r.id).sort()).toEqual([byStep.id, byTag.id, byOutcome.id, byDesc.id].sort());
    // List items don't carry description/expectedOutcome (get the full text via get)
    expect(hits[0]).not.toHaveProperty('description');
    expect(hits[0]).not.toHaveProperty('expectedOutcome');
    // Title-hit path doesn't regress
    const byTitle = await svc.searchCasesInVersion(seed.versionId, { keyword: '登录成功' });
    expect(byTitle).toHaveLength(1);
  }, 30_000);

  it('createGroup:项目不存在 → 404;成功后 groupProjectId 可解析', async () => {
    const { projectId } = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    const g = await svc.createGroup(projectId, { name: '新分组' });
    expect(await svc.groupProjectId(g.id)).toBe(projectId);
    await expect(svc.createGroup('00000000-0000-0000-0000-000000000000', { name: 'x' }))
      .rejects.toMatchObject({ status: 404 });
  }, 30_000);

  it('tagIds:组织内创建带 tags 返回完整行;缺失 tag → 404;跨组织 tag → 400', async () => {
    const seed = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    const t1 = (await pool.query(`INSERT INTO tags(organization_id, name, color) VALUES ($1,'冒烟','34c759') RETURNING id`, [seed.orgId])).rows[0]!.id as string;

    const c = await svc.createCase({ groupId: seed.groupId, versionId: seed.versionId, title: '带标签用例', tagIds: [t1] });
    expect(c.tags).toEqual([{ id: t1, name: '冒烟', color: '34c759' }]);
    expect((await pool.query(`SELECT tag_id FROM case_tags WHERE case_id=$1`, [c.id])).rowCount).toBe(1);

    await expect(svc.createCase({ groupId: seed.groupId, versionId: seed.versionId, title: 'x', tagIds: ['00000000-0000-0000-0000-000000000000'] }))
      .rejects.toMatchObject({ status: 404 });

    // Another organization's tag -> 400 tag_org_mismatch
    const otherOrg = randomUUID();
    await pool.query(`INSERT INTO organizations(id, name, path) VALUES ($1,'他组织',$2)`, [otherOrg, `/${otherOrg}/`]);
    const foreignTag = (await pool.query(`INSERT INTO tags(organization_id, name, color) VALUES ($1,'外标签','ff0000') RETURNING id`, [otherOrg])).rows[0]!.id as string;
    await expect(svc.createCase({ groupId: seed.groupId, versionId: seed.versionId, title: 'y', tagIds: [foreignTag] }))
      .rejects.toMatchObject({ status: 400, code: 'tag_org_mismatch' });
  }, 30_000);

  it('updateCase:跨项目移动分组 → 400 cross_project_move;同项目换分组成功', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    const c = await svc.createCase({ groupId: a.groupId, versionId: a.versionId, title: '搬运工' });

    await expect(svc.updateCase(c.id, { groupId: b.groupId }))
      .rejects.toMatchObject({ status: 400, code: 'cross_project_move' });

    const g2 = (await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1,'第二分组') RETURNING id`, [a.projectId])).rows[0]!.id as string;
    const moved = await svc.updateCase(c.id, { groupId: g2 });
    expect(moved.groupId).toBe(g2);
  }, 30_000);

  it('webServiceRef 随 create/patch 透传;resolvedUrl 相对拼接展示', async () => {
    const { groupId, versionId, projectId } = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    // Build a default environment + web object (origin http://10.0.0.1:8080, name=frontend, isDefault), shared into the project
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认环境', true) RETURNING id`,
      [projectId],
    );
    const envId = env.rows[0]!.id as string;
    await pool.query(
      `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1, 'web', '前端', $2::jsonb, true)`,
      [envId, JSON.stringify({ name: 'frontend', scheme: 'http', host: '10.0.0.1', port: 8080 })],
    );
    const c = await svc.createCase({ groupId, versionId, title: 't', url: '/login', webServiceRef: 'frontend' });
    expect(c.webServiceRef).toBe('frontend');
    const detail = await svc.getCaseDetail(c.id);
    expect(detail!.webServiceRef).toBe('frontend');
    expect(detail!.resolvedUrl).toBe('http://10.0.0.1:8080/login');
    const list = await svc.searchCasesInVersion(versionId, {});
    expect(list[0]!.webServiceRef).toBe('frontend');
    expect(list[0]!.resolvedUrl).toBe('http://10.0.0.1:8080/login');
    // Patch path: rebind to the second named service -> resolvedUrl follows the origin; then set null -> falls back to the default service
    await pool.query(
      `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1, 'web', '后端', $2::jsonb, false)`,
      [envId, JSON.stringify({ name: 'backend', scheme: 'http', host: '10.0.0.2', port: 8081 })],
    );
    await svc.updateCase(c.id, { webServiceRef: 'backend' });
    const swapped = await svc.getCaseDetail(c.id);
    expect(swapped!.webServiceRef).toBe('backend');
    expect(swapped!.resolvedUrl).toBe('http://10.0.0.2:8081/login');
    await svc.updateCase(c.id, { webServiceRef: null });
    const cleared = await svc.getCaseDetail(c.id);
    expect(cleared!.webServiceRef).toBeNull();
    expect(cleared!.resolvedUrl).toBe('http://10.0.0.1:8080/login');
  }, 30_000);
});
