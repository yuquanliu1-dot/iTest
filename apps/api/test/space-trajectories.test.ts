import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject, seedProductLineInOrg } from './helpers/db.js';

let pool: Pool;
let managerApp: import('express').Express;
let memberApp: import('express').Express;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
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
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_trajectories`);
});

describe('R2 trajectories：表与约束', () => {
  it('插入/查询往返；partial unique——同 source_case_id 双 active 插入第二次落空，软删后可再插', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const caseId = randomUUID();
    const base = `INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model, source_case_id)
      VALUES ($1,$2,'T','k','d','C','m',$3)
      ON CONFLICT DO NOTHING`;
    await pool.query(base, [randomUUID(), lineId, caseId]);
    await pool.query(base, [randomUUID(), lineId, caseId]); // 必须不抛
    let n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(1);
    await pool.query(`UPDATE assistant_trajectories SET status='deleted' WHERE source_case_id=$1`, [caseId]);
    await pool.query(base, [randomUUID(), lineId, caseId]); // 软删后可再插
    n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(2);
  });

  it('删除产品线级联清除轨迹', async () => {
    const org = await seedOrg(pool);
    const lineId = await seedProductLineInOrg(pool, org.orgId, `线-${randomUUID().slice(0, 8)}`);
    await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model)
      VALUES ($1,$2,'T','k','d','C','m')`, [randomUUID(), lineId]);
    await pool.query(`DELETE FROM product_lines WHERE id=$1`, [lineId]);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(0);
  });
});

describe('R2 trajectories：服务层', () => {
  async function lineOfSeed(): Promise<string> {
    const { projectId } = await seedProject(pool);
    return (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
  }
  async function insertRow(lineId: string, o: { title?: string; keywords?: string; caseTitle?: string; caseId?: string; ago?: number }) {
    await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model, source_case_id, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'m',$7, now() - ($8 || ' seconds')::interval)`,
      [randomUUID(), lineId, o.title ?? 'T', o.keywords ?? 'k', 'digest-body', o.caseTitle ?? 'C', o.caseId ?? randomUUID(), String(o.ago ?? 0)]);
  }

  it('loadActiveTrajectories：本线 active 降序；他线/deleted 不泄漏', async () => {
    const lineId = await lineOfSeed();
    const otherLine = await seedProductLineInOrg(pool, (await seedOrg(pool)).orgId, `他线-${randomUUID().slice(0, 8)}`);
    await insertRow(lineId, { title: '旧', ago: 60 });
    await insertRow(lineId, { title: '新', ago: 0 });
    await insertRow(otherLine, { title: '他线行' });
    await insertRow(lineId, { title: '已删' });
    await pool.query(`UPDATE assistant_trajectories SET status='deleted' WHERE task_title='已删'`);
    const { loadActiveTrajectories } = await import('../src/pi/space/trajectories.js');
    const rows = await loadActiveTrajectories(lineId);
    expect(rows.map((r) => r.taskTitle)).toEqual(['新', '旧']);
  });

  it(`buildTrajectoriesSection：空→''；正常含标题行+检索指引脚注；超预算截完整行`, async () => {
    const { buildTrajectoriesSection, TRAJECTORY_SECTION_MAX_CHARS } = await import('../src/pi/space/trajectories.js');
    expect(buildTrajectoriesSection([])).toBe('');
    const out = buildTrajectoriesSection([
      { taskTitle: '登录失败锁定提示', caseTitle: '用户管理-登录-密码错误' },
      { taskTitle: '列表导出按钮遮蔽绕行', caseTitle: '事件管理-导出' },
    ]);
    expect(out).toContain('# 成功用例轨迹');
    expect(out).toContain('- 登录失败锁定提示（用例：用户管理-登录-密码错误）');
    expect(out).toContain('search_trajectories');
    const many = Array.from({ length: 60 }, (_, i) => ({ taskTitle: `T${i}${'x'.repeat(80)}`, caseTitle: `C${i}` }));
    const big = buildTrajectoriesSection(many);
    expect(big.length).toBeLessThanOrEqual(TRAJECTORY_SECTION_MAX_CHARS);
    big.split('\n').filter((l) => l.startsWith('- ')).forEach((l) => {
      expect(many.some((m) => `- ${m.taskTitle}（用例：${m.caseTitle}）`.startsWith(l) || l === `- ${m.taskTitle}（用例：${m.caseTitle}）`.slice(0, l.length))).toBe(true);
    });
    // 对抗形态：列宽上限（title/caseTitle 各 200）的胖行密集排列——仍不超帽、只截完整行
    const fat = Array.from({ length: 30 }, (_, i) => ({ taskTitle: `F${i}${'f'.repeat(199)}`, caseTitle: 'k'.repeat(200) }));
    const fatOut = buildTrajectoriesSection(fat);
    expect(fatOut.length).toBeLessThanOrEqual(TRAJECTORY_SECTION_MAX_CHARS);
    const fatLines = fatOut.split('\n');
    expect(fatLines[0]).toBe('# 成功用例轨迹'); // 头部恒在
    expect(fatLines[fatLines.length - 1]).toContain('禁止照抄'); // 脚注恒在
    fatLines.filter((l) => l.startsWith('- ')).forEach((l) => {
      expect(fat.some((m) => `- ${m.taskTitle}（用例：${m.caseTitle}）`.startsWith(l))).toBe(true);
    });
  });

  it('searchTrajectoriesByQuery：命中字段数打分 top-3、同分 updatedAt 降序、命中行 hit_count +1；miss 返回空 hits 带全集', async () => {
    const lineId = await lineOfSeed();
    const lineOther = await seedProductLineInOrg(pool, (await seedOrg(pool)).orgId, `他线-${randomUUID().slice(0, 8)}`);
    const c1 = randomUUID(), c2 = randomUUID(), c3 = randomUUID();
    await insertRow(lineId, { title: '登录 失败 提示', keywords: '登录 密码错误', caseTitle: '登录用例', caseId: c1, ago: 300 });
    await insertRow(lineId, { title: '登录锁定', keywords: '账号锁', caseTitle: '登录用例B', caseId: c2, ago: 200 });
    await insertRow(lineId, { title: '列表导出', keywords: '导出 excel', caseTitle: '导出用例', caseId: c3, ago: 100 });
    await insertRow(lineOther, { title: '他线 登录', caseId: randomUUID() });
    const { searchTrajectoriesByQuery } = await import('../src/pi/space/trajectories.js');
    const r = await searchTrajectoriesByQuery(lineId, '登录');
    expect(r.hits.length).toBe(2); // 本线只有 2 条含「登录」
    expect(r.hits[0]!.taskTitle).toBe('登录 失败 提示'); // title+keywords+caseTitle 三字段命中 > 单字段
    const hits = (await pool.query(`SELECT hit_count::int h FROM assistant_trajectories WHERE source_case_id = ANY($1)`, [[c1, c2]])).rows;
    expect(hits.every((x) => x.h === 1)).toBe(true);
    const miss = await searchTrajectoriesByQuery(lineId, '不存在词');
    expect(miss.hits).toEqual([]);
    expect(miss.all.length).toBeGreaterThanOrEqual(3);
  });

  it('insertTrajectory：onConflictDoNothing——同 case 二次插入返回 false 不新建', async () => {
    const lineId = await lineOfSeed();
    const caseId = randomUUID();
    const { insertTrajectory } = await import('../src/pi/space/trajectories.js');
    const input = {
      productLineId: lineId, taskTitle: 'T', taskKeywords: 'k', digest: 'd', caseTitle: 'C',
      status: 'active' as const, retiredByBatch: null, sourceThreadId: null, sourceCaseId: caseId,
      sourceProjectId: null, sourceVersionId: null, createdByUserId: null, distillModel: 'm',
    };
    expect(await insertTrajectory(input)).toBe(true);
    expect(await insertTrajectory(input)).toBe(false);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(1);
  });

  it('insertTrajectory：入库清洗——title/keywords 去换行；title≤200/keywords≤500/digest≤8000 截断', async () => {
    const lineId = await lineOfSeed();
    const { insertTrajectory } = await import('../src/pi/space/trajectories.js');
    expect(await insertTrajectory({
      productLineId: lineId,
      taskTitle: `标\n题\r\n第二行${'x'.repeat(300)}`,
      taskKeywords: `kw1\nkw2\rc${'y'.repeat(600)}`,
      digest: 'd'.repeat(9_000),
      caseTitle: 'C', status: 'active' as const, retiredByBatch: null, sourceThreadId: null,
      sourceCaseId: randomUUID(), sourceProjectId: null, sourceVersionId: null, createdByUserId: null, distillModel: 'm',
    })).toBe(true);
    const row = (await pool.query(`SELECT task_title, task_keywords, digest FROM assistant_trajectories`)).rows[0]!;
    expect(row.task_title).not.toMatch(/[\r\n]/); // 换行伪造 system prompt 段结构——堵死
    expect(row.task_title.length).toBeLessThanOrEqual(200);
    expect(row.task_title.startsWith('标')).toBe(true); // 截断保留前缀
    expect(row.task_keywords).not.toMatch(/[\r\n]/);
    expect(row.task_keywords.length).toBeLessThanOrEqual(500);
    expect(row.digest.length).toBe(8_000);
  });
});

describe('R2 trajectories：工具层', () => {
  async function toolCtx(projectId: string) {
    const { emptyRepoState } = await import('../src/pi/space/tools/context.js');
    return { threadId: randomUUID(), versionId: randomUUID(), projectId, repo: emptyRepoState(), emit: () => {}, createdByUserId: null, manager: true };
  }

  it('search_trajectories：命中返回 digest+task_title；命中行 hit_count +1；miss 返回可用清单', async () => {
    const { buildSearchTrajectoryTool } = await import('../src/pi/space/tools/trajectories.js');
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const caseId = randomUUID();
    await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model, source_case_id)
      VALUES ($1,$2,'登录失败提示','登录 密码','## 任务描述…','登录-密码错误','m',$3)`, [randomUUID(), lineId, caseId]);
    const tool = buildSearchTrajectoryTool(await toolCtx(projectId));
    const hit = await tool.execute({ query: '登录 失败' });
    expect(hit.ok).toBe(true);
    const data = JSON.parse((hit as { ok: true; data: string }).data);
    expect(Array.isArray(data.trajectories)).toBe(true);
    expect(data.trajectories[0].task_title).toBe('登录失败提示');
    expect(data.trajectories[0].digest).toContain('任务描述');
    expect((await pool.query(`SELECT hit_count::int h FROM assistant_trajectories WHERE source_case_id=$1`, [caseId])).rows[0]!.h).toBe(1);
    const miss = await tool.execute({ query: '不存在词' });
    expect(miss.ok).toBe(false);
    expect((miss as { ok: false; error: string }).error).toContain('登录失败提示');
  });

  it('项目未归线：报错不抛', async () => {
    const { buildSearchTrajectoryTool } = await import('../src/pi/space/tools/trajectories.js');
    const tool = buildSearchTrajectoryTool(await toolCtx(randomUUID()));
    const r = await tool.execute({ query: 'x' });
    expect(r.ok).toBe(false);
  });
});

describe('R2 trajectories：管理路由', () => {
  it('GET：本组织线可见+带 productLineName+默认 active；他组织线不可见；?status=deleted 可审计', async () => {
    const org1 = await seedOrg(pool);
    const line1 = await seedProductLineInOrg(pool, org1.orgId, `本线-${randomUUID().slice(0, 8)}`);
    const org2Id = randomUUID();
    await pool.query(`INSERT INTO organizations(id, name, path) VALUES ($1,$2,$3)`, [org2Id, `他组织-${org2Id.slice(0, 8)}`, `/${org2Id}/`]);
    const line2 = await seedProductLineInOrg(pool, org2Id, `他线-${randomUUID().slice(0, 8)}`);
    await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model) VALUES
      ($1,$2,'本线轨迹','k','d','C','m'), ($3,$4,'他组织线轨迹','k','d','C','m')`, [randomUUID(), line1, randomUUID(), line2]);
    const res = await request(managerApp).get('/api/assistant/trajectories');
    expect(res.status).toBe(200);
    const titles = (res.body.items as Array<{ taskTitle: string; productLineName: string | null }>).map((r) => r.taskTitle);
    expect(titles).toContain('本线轨迹');
    expect(titles).not.toContain('他组织线轨迹');
    expect((res.body.items as Array<{ productLineName: string | null }>).find((r) => r.productLineName)).toBeTruthy();
    await pool.query(`UPDATE assistant_trajectories SET status='deleted' WHERE task_title='本线轨迹'`);
    const activeRes = await request(managerApp).get('/api/assistant/trajectories');
    expect((activeRes.body.items as Array<{ taskTitle: string }>).some((r) => r.taskTitle === '本线轨迹')).toBe(false);
    const auditRes = await request(managerApp).get('/api/assistant/trajectories?status=deleted');
    expect((auditRes.body.items as Array<{ taskTitle: string }>).some((r) => r.taskTitle === '本线轨迹')).toBe(true);
  });

  it('GET：分页（page/limit/total）+ 跨页不重不漏 + 不可见线不进 total', async () => {
    const org1 = await seedOrg(pool);
    const line1 = await seedProductLineInOrg(pool, org1.orgId, `本线-${randomUUID().slice(0, 8)}`);
    const org2Id = randomUUID();
    await pool.query(`INSERT INTO organizations(id, name, path) VALUES ($1,$2,$3)`, [org2Id, `他组织-${org2Id.slice(0, 8)}`, `/${org2Id}/`]);
    const line2 = await seedProductLineInOrg(pool, org2Id, `他线-${randomUUID().slice(0, 8)}`);
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model) VALUES ($1,$2,$3,'k','d','C','m')`,
        [randomUUID(), line1, `本线轨迹-${i}`],
      );
    }
    await pool.query(
      `INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model) VALUES ($1,$2,'他组织线轨迹','k','d','C','m')`,
      [randomUUID(), line2],
    );

    const p1 = await request(managerApp).get('/api/assistant/trajectories?page=1&limit=2').expect(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.total).toBe(5); // 他组织线轨迹不可见，不计入
    expect(p1.body.page).toBe(1);
    expect(p1.body.limit).toBe(2);

    const p3 = await request(managerApp).get('/api/assistant/trajectories?page=3&limit=2').expect(200);
    expect(p3.body.items).toHaveLength(1);

    const seen = new Set<string>();
    for (const p of [1, 2, 3]) {
      const r = await request(managerApp).get(`/api/assistant/trajectories?page=${p}&limit=2`).expect(200);
      for (const it of r.body.items as Array<{ id: string }>) seen.add(it.id);
    }
    expect(seen.size).toBe(5);

    // 筛某条可见线 → 只回该线
    const one = await request(managerApp).get(`/api/assistant/trajectories?productLineId=${line1}`).expect(200);
    expect(one.body.total).toBe(5);

    // 筛不可见线 → 空
    const other = await request(managerApp).get(`/api/assistant/trajectories?productLineId=${line2}`).expect(200);
    expect(other.body.total).toBe(0);
    expect(other.body.items).toHaveLength(0);

    // 非法分页参数被钳制
    const bad = await request(managerApp).get('/api/assistant/trajectories?page=0&limit=0').expect(200);
    expect(bad.body.page).toBe(1);
    expect(bad.body.limit).toBe(1);
  });

  it('DELETE：软删 status=deleted；member 403；不存在 404', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const id = randomUUID();
    await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model) VALUES ($1,$2,'待删','k','d','C','m')`, [id, lineId]);
    expect((await request(memberApp).delete(`/api/assistant/trajectories/${id}`)).status).toBe(403);
    expect((await request(managerApp).delete(`/api/assistant/trajectories/${randomUUID()}`)).status).toBe(404);
    const res = await request(managerApp).delete(`/api/assistant/trajectories/${id}`);
    expect(res.status).toBe(204);
    expect((await pool.query(`SELECT status FROM assistant_trajectories WHERE id=$1`, [id])).rows[0]!.status).toBe('deleted');
  });
});

describe('R2 trajectories：system prompt 注入', () => {
  it('零轨迹时输出与旧构造完全一致（回归红线）', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const legacy = buildSpaceSystemPrompt('SUMMARY', 'zh-CN', [{ kind: 'flow', body: 'F' }], 'MEM');
    const withEmpty = buildSpaceSystemPrompt('SUMMARY', 'zh-CN', [{ kind: 'flow', body: 'F' }], 'MEM', '');
    expect(legacy).toBe(withEmpty);
    expect(withEmpty).not.toContain('成功用例轨迹');
  });

  it('轨迹段位于 memories 之后、workspace 之前；工厂零轨迹时第 5 参缺省可用', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const out = buildSpaceSystemPrompt(null, 'zh-CN', [{ kind: 'flow', body: 'F' }], '# 产品线记忆\n- x', '# 成功用例轨迹\n- t');
    const iGuides = out.indexOf('# 流程指令');
    const iMem = out.indexOf('# 产品线记忆');
    const iTraj = out.indexOf('# 成功用例轨迹');
    const iWorkspace = out.indexOf('## 工作空间');
    expect(iGuides).toBeGreaterThan(-1);
    expect(iMem).toBeGreaterThan(iGuides);
    expect(iTraj).toBeGreaterThan(iMem);
    expect(iWorkspace).toBeGreaterThan(iTraj);
    // 缺省第 5 参（旧调用）编译期兼容
    expect(() => buildSpaceSystemPrompt(null, 'zh-CN', [], '')).not.toThrow();
  });
});
