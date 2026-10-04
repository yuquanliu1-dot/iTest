import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('cases.service', () => {
  it('createCase:同项目分组+版本创建成功并带 tags;version 跨项目 → version_mismatch', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const other = await seedProject(pool); // 第二个项目
    const svc = await import('../src/services/cases.service.js');
    const created = await svc.createCase({ groupId, versionId, title: '登录-正常' });
    expect(created.title).toBe('登录-正常');
    expect(created.versionId).toBe(versionId);

    await expect(svc.createCase({ groupId, versionId: other.versionId, title: 'x' }))
      .rejects.toMatchObject({ status: 400, code: 'version_mismatch' });
    await expect(svc.createCase({ groupId: other.groupId, versionId, title: 'x' }))
      .rejects.toMatchObject({ status: 400, code: 'version_mismatch' });
  }, 30_000);

  it('createCaseWithSteps:compiled click 展开为具体步骤,compiled:[] 映射为 null 保留 aiStep 壳', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    const c = await svc.createCaseWithSteps({
      groupId, versionId, title: '下单流程',
      steps: [
        { instruction: '打开首页', compiled: [{ kind: 'navigate', url: 'https://a.example.com/' }] },
        { instruction: '点击下单按钮', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '.buy' }] }], assertion: '出现成功提示' },
        { instruction: '模糊步骤', compiled: [] },
      ],
    });
    const rows = (await pool.query(`SELECT "order", name, action, assertion FROM test_steps WHERE case_id=$1 ORDER BY "order"`, [c.id])).rows as Array<{
      order: number; name: string | null; action: Record<string, unknown>; assertion: Record<string, unknown> | null;
    }>;
    // 第 1、2 条被展开成具体 DSL(每条 compiled 1 个子步骤 → 各 1 行);第 3 条 [] → null,留 aiStep 壳
    expect(rows).toHaveLength(3);
    expect((rows[0]!.action as { kind: string }).kind).toBe('navigate');
    expect((rows[1]!.action as { kind: string }).kind).toBe('click');
    expect((rows[1]!.assertion as { kind: string; match?: string }).kind).toBe('assertText');
    expect((rows[2]!.action as { kind: string; compiled?: unknown }).kind).toBe('aiStep');
    expect((rows[2]!.action as { compiled: unknown }).compiled).toBeNull();
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

  it('createGroup:项目不存在 → 404;成功后 groupProjectId 可解析', async () => {
    const { projectId } = await seedProject(pool);
    const svc = await import('../src/services/cases.service.js');
    const g = await svc.createGroup(projectId, { name: '新分组', defaultUrl: 'https://g.example.com' });
    expect(await svc.groupProjectId(g.id)).toBe(projectId);
    await expect(svc.createGroup('00000000-0000-0000-0000-000000000000', { name: 'x' }))
      .rejects.toMatchObject({ status: 404 });
  }, 30_000);
});
