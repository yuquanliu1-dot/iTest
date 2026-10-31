import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject, seedProductLineInOrg } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let managerApp: import('express').Express;
let memberApp: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf, memberUserOf } = await import('./helpers/auth.js');
  const mount = (user: ReturnType<typeof managerUserOf>) => {
    const a = exp();
    a.use(exp.json());
    a.use((req, _res, next) => { req.user = user; next(); });
    a.use('/api/assistant', spaceRoute);
    a.use(errorHandler);
    return a;
  };
  managerApp = mount(managerUserOf(userId, username, orgId, orgPath));
  memberApp = mount(memberUserOf(userId, username, orgId, orgPath));
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_memories`);
});

describe('R1 memories：服务层', () => {
  it('loadActiveMemories：global+本线可见、他线不泄漏、非 active 不可见、updatedAt 降序', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const otherLine = await seedProductLineInOrg(pool, (await seedOrg(pool)).orgId, `他线-${randomUUID().slice(0, 8)}`);
    await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance, status) VALUES
      ($1,'product_line',$2,'A-本线','hook-a','user_stated','active'),
      ($3,'global',NULL,'B-全局','hook-b','user_stated','active'),
      ($4,'product_line',$5,'C-他线','hook-c','user_stated','active'),
      ($6,'product_line',$2,'D-退役','hook-d','user_stated','retired_solidified'),
      ($7,'product_line',$2,'E-删除','hook-e','user_stated','deleted')`,
      [randomUUID(), lineId, randomUUID(), randomUUID(), otherLine, randomUUID(), randomUUID()]);
    const { loadActiveMemories } = await import('../src/pi/space/memories.js');
    const rows = await loadActiveMemories(lineId);
    expect(rows.map((r) => r.title).sort()).toEqual(['A-本线', 'B-全局']);
  });

  it('loadActiveMemories：updatedAt 降序（新写的排前面）', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES
      ($1,'product_line',$2,'旧','旧 hook','user_stated')`, [randomUUID(), lineId]);
    await new Promise((r) => setTimeout(r, 20));
    await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES
      ($1,'product_line',$2,'新','新 hook','user_stated')`, [randomUUID(), lineId]);
    const { loadActiveMemories } = await import('../src/pi/space/memories.js');
    const rows = await loadActiveMemories(lineId);
    expect(rows[0]!.title).toBe('新');
  });

  it('buildMemoriesSection：空返回空串；正常渲染含标题/hook/说明脚注', async () => {
    const { buildMemoriesSection } = await import('../src/pi/space/memories.js');
    expect(buildMemoriesSection([])).toBe('');
    const out = buildMemoriesSection([
      { title: '登录页特殊行为', hook: '必须先关掉公告弹窗才能点登录按钮' },
      { title: '测试账号怪癖', hook: '未验证：admin 账号连续失败 3 次锁 10 分钟' },
    ]);
    expect(out).toContain('# 产品线记忆（历史会话沉淀的经验）');
    expect(out).toContain('- [登录页特殊行为] 必须先关掉公告弹窗才能点登录按钮');
    expect(out).toContain('- [测试账号怪癖] 未验证：admin 账号连续失败 3 次锁 10 分钟');
    expect(out).toContain('read_memory');
    expect(out).toContain('save_memory');
  });

  it('buildMemoriesSection：超字符预算截断到最近完整行（不产生半行）', async () => {
    const { buildMemoriesSection } = await import('../src/pi/space/memories.js');
    const rows = Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, hook: 'x'.repeat(200) }));
    const out = buildMemoriesSection(rows);
    expect(out.length).toBeLessThanOrEqual(4_200); // 预算 4000 + 头脚余量
    for (const line of out.split('\n')) {
      expect(line === '' || line.startsWith('#') || line.startsWith('- [') || !line.startsWith('-')).toBe(true);
    }
    expect(out).not.toContain('- [T29]'); // 30×~210 字符必然超 4000，尾部被截
  });

  it('upsertMemory：同 title active 行更新不新建；retired 同名行不算命中', async () => {
    const { upsertMemory } = await import('../src/pi/space/memories.js');
    const lineId = await seedProductLineInOrg(pool, (await seedOrg(pool)).orgId, `线-${randomUUID().slice(0, 8)}`);
    const base = { scope: 'product_line' as const, productLineId: lineId, title: '标题', provenance: 'user_stated' as const, sourceThreadId: null, createdByUserId: null };
    expect(await upsertMemory({ ...base, hook: 'v1', body: null })).toBe('created');
    expect(await upsertMemory({ ...base, hook: 'v2', body: '正文' })).toBe('updated');
    let n = (await pool.query(`SELECT count(*)::int n, max(hook) hook FROM assistant_memories WHERE title='标题'`)).rows[0]!;
    expect(n.n).toBe(1);
    expect(n.hook).toBe('v2');
    await pool.query(`UPDATE assistant_memories SET status='retired_stale' WHERE title='标题'`);
    expect(await upsertMemory({ ...base, hook: 'v3', body: null })).toBe('created');
    n = (await pool.query(`SELECT count(*)::int n FROM assistant_memories WHERE title='标题'`)).rows[0]!;
    expect(n.n).toBe(2);
  });

  it('findMemoriesByTitle：ILIKE 模糊命中 active+可见作用域', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES
      ($1,'product_line',$2,'登录页特殊行为','h','user_stated'),
      ($3,'global',NULL,'登录接口怪癖','h','user_stated')`,
      [randomUUID(), lineId, randomUUID()]);
    const { findMemoriesByTitle } = await import('../src/pi/space/memories.js');
    const hits = await findMemoriesByTitle(lineId, '登录');
    expect(hits.map((h) => h.title).sort()).toEqual(['登录接口怪癖', '登录页特殊行为']);
  });
});
