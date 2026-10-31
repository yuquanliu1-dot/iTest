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
    expect(out.length).toBeLessThanOrEqual(4_000); // 预算 4000 硬顶
    const inputLines = new Set(rows.map(r => `- [${r.title}] ${r.hook}`));
    out.split('\n').filter(l => l.startsWith('- [')).forEach(l => expect(inputLines.has(l)).toBe(true));
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

describe('R1 memories：工具层', () => {
  async function toolCtx(projectId: string) {
    const { emptyRepoState } = await import('../src/pi/space/tools/context.js');
    return {
      threadId: randomUUID(), versionId: randomUUID(), projectId,
      repo: emptyRepoState(), emit: () => {}, createdByUserId: null, manager: true,
    };
  }

  it('save_memory：新建/更新语义 + product_line 解析 + global 不查线', async () => {
    const { buildSaveMemoryTool } = await import('../src/pi/space/tools/memories.js');
    const { projectId } = await seedProject(pool);
    const tool = buildSaveMemoryTool(await toolCtx(projectId));
    const r1 = await tool.execute({ title: '环境怪癖', hook: '测试环境每晚 2 点重启', provenance: 'user_stated' });
    expect(r1.ok).toBe(true);
    expect((r1 as { ok: true; data: string }).data).toContain('新建');
    const r2 = await tool.execute({ title: '环境怪癖', hook: '测试环境每晚 2 点重启（已证实）', provenance: 'user_stated' });
    expect((r2 as { ok: true; data: string }).data).toContain('更新');
    const g = await tool.execute({ title: '平台事实', hook: '附件下载有 24h 过期', provenance: 'user_stated', scope: 'global' });
    expect(g.ok).toBe(true);
  });

  it('save_memory：项目不存在时 product_line 报错不写入', async () => {
    const { buildSaveMemoryTool } = await import('../src/pi/space/tools/memories.js');
    const tool = buildSaveMemoryTool(await toolCtx(randomUUID()));
    const r = await tool.execute({ title: 'X', hook: 'Y', provenance: 'user_stated' });
    expect(r.ok).toBe(false);
  });

  it('read_memory：模糊命中返回正文 + hit_count 递增；找不到给可用标题清单', async () => {
    const { buildSaveMemoryTool, buildReadMemoryTool } = await import('../src/pi/space/tools/memories.js');
    const { projectId } = await seedProject(pool);
    const ctx = await toolCtx(projectId);
    await buildSaveMemoryTool(ctx).execute({ title: '登录页特殊行为', hook: '先关弹窗', body: '公告弹窗出现在登录页首次加载，selector .announce-modal，必须先点右上角关闭才能点登录按钮。', provenance: 'ai_inferred' });
    const read = buildReadMemoryTool(ctx);
    const r = await read.execute({ title: '登录页' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { ok: true; data: string }).data);
    expect(data.body).toContain('announce-modal');
    const hit = (await pool.query(`SELECT hit_count::int h FROM assistant_memories WHERE title='登录页特殊行为'`)).rows[0]!;
    expect(hit.h).toBe(1);
    const miss = await read.execute({ title: '不存在的主题' });
    expect(miss.ok).toBe(false);
    expect((miss as { ok: false; error: string }).error).toContain('登录页特殊行为');
  });
});

describe('R1 memories：system prompt 注入', () => {
  it('零记忆时输出与旧构造完全一致（回归红线）', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const withMem = buildSpaceSystemPrompt('SUMMARY', 'zh-CN', [{ kind: 'flow', body: 'F' }], '');
    const noArg = buildSpaceSystemPrompt('SUMMARY', 'zh-CN', [{ kind: 'flow', body: 'F' }]);
    expect(withMem).toBe(noArg);
    expect(withMem).not.toContain('产品线记忆');
  });

  it('记忆段位于 guides 段之后、workspace 段之前', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const { buildMemoriesSection } = await import('../src/pi/space/memories.js');
    const mem = buildMemoriesSection([{ title: 'T', hook: 'H' }]);
    const out = buildSpaceSystemPrompt(null, 'zh-CN', [{ kind: 'flow', body: 'F' }], mem);
    const iGuides = out.indexOf('# 流程指令');
    const iMem = out.indexOf('# 产品线记忆');
    const iWorkspace = out.indexOf('## 工作空间');
    expect(iGuides).toBeGreaterThan(-1);
    expect(iMem).toBeGreaterThan(iGuides);
    expect(iWorkspace).toBeGreaterThan(iMem);
  });
});

describe('R1 memories：管理路由', () => {
  it('GET：global + 本组织线可见，他组织线不可见；带 productLineName', async () => {
    const org1 = await seedOrg(pool);
    const line1 = await seedProductLineInOrg(pool, org1.orgId, `本线-${randomUUID().slice(0, 8)}`);
    // 第二组织 + 该组织下的线（manager 不在其子树）
    const org2Id = randomUUID();
    await pool.query(`INSERT INTO organizations(id, name, path) VALUES ($1,$2,$3)`, [org2Id, `他组织-${org2Id.slice(0, 8)}`, `/${org2Id}/`]);
    const line2 = await seedProductLineInOrg(pool, org2Id, `他线-${randomUUID().slice(0, 8)}`);
    await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES
      ($1,'product_line',$2,'本线记忆','h','user_stated'),
      ($3,'global',NULL,'全局记忆','h','user_stated'),
      ($4,'product_line',$5,'他组织线记忆','h','user_stated')`,
      [randomUUID(), line1, randomUUID(), randomUUID(), line2]);
    const res = await request(managerApp).get('/api/assistant/memories');
    expect(res.status).toBe(200);
    const titles = (res.body as Array<{ title: string; productLineName: string | null }>).map((r) => r.title);
    expect(titles).toContain('本线记忆');
    expect(titles).toContain('全局记忆');
    expect(titles).not.toContain('他组织线记忆');
    const mine = (res.body as Array<{ title: string; productLineName: string | null }>).find((r) => r.title === '本线记忆');
    expect(mine!.productLineName).toBeTruthy();
  });

  it('DELETE：软删（行保留 status=deleted），loadActiveMemories 不再返回；member 403', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const id = randomUUID();
    await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES ($1,'product_line',$2,'待删','h','user_stated')`, [id, lineId]);
    const forbidden = await request(memberApp).delete(`/api/assistant/memories/${id}`);
    expect(forbidden.status).toBe(403);
    const res = await request(managerApp).delete(`/api/assistant/memories/${id}`);
    expect(res.status).toBe(204);
    const row = (await pool.query(`SELECT status FROM assistant_memories WHERE id=$1`, [id])).rows[0]!;
    expect(row.status).toBe('deleted');
    const { loadActiveMemories } = await import('../src/pi/space/memories.js');
    expect((await loadActiveMemories(lineId)).map((r) => r.title)).not.toContain('待删');
  });

  it('GET ?status=deleted：软删行可查（审计）', async () => {
    await pool.query(`INSERT INTO assistant_memories (id, scope, title, hook, provenance, status) VALUES ($1,'global','已删','h','user_stated','deleted')`, [randomUUID()]);
    const res = await request(managerApp).get('/api/assistant/memories?status=deleted');
    expect(res.status).toBe(200);
    expect((res.body as Array<{ title: string }>).some((r) => r.title === '已删')).toBe(true);
  });
});
