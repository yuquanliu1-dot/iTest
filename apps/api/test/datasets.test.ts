import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedProjectInOrg } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let projectId: string;
let groupId: string;
let versionId: string;
let userId: string;
let username: string;
let orgId: string;
let orgPath: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  userId = seed.userId;
  username = seed.username;
  orgId = seed.orgId;
  orgPath = seed.orgPath;
  const { default: express } = await import('express');
  const { datasetsRoute } = await import('../src/routes/datasets.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api', datasetsRoute);
  const { casesRoute } = await import('../src/routes/cases.js');
  app.use('/api/cases', casesRoute);
  const { stepsRoute } = await import('../src/routes/steps.js');
  app.use('/api/cases', stepsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

const body = {
  name: '登录账号',
  columns: [
    { name: 'username', sensitive: false },
    { name: 'password', sensitive: true },
  ],
  rows: [
    { disabled: false, cells: { username: 'alice', password: 'pw-1' } },
    { disabled: false, cells: { username: 'bob', password: 'pw-2' } },
  ],
};

describe('datasets.service', () => {
  it('createDataset 加密敏感列；getDataset 返回 __masked 占位', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, body);
    expect(created.id).toBeTruthy();
    // 落库形态：敏感格是密文三元组，不是明文
    const raw = await pool.query(`SELECT rows FROM datasets WHERE id = $1`, [created.id]);
    const cell = raw.rows[0].rows[0].cells.password;
    expect(typeof cell).toBe('object');
    expect(cell.c).toBeTruthy();
    expect(cell.c).not.toContain('pw-1');
    // 出参：敏感格占位、明文列原样
    const detail = await svc.getDataset(created.id);
    expect(detail!.rows[0].cells.username).toBe('alice');
    expect(detail!.rows[0].cells.password).toEqual({ __masked: true });
    // 写路径出参也必须是掩码（路由直接 res.json 该返回值）
    expect(created.rows[0].cells.password).toEqual({ __masked: true });
    expect(JSON.stringify(created)).not.toContain('pw-1');
  });

  it('updateDataset：__masked 回传沿用旧密文（解密可还原），改字符串则重新加密', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '账号2' });
    // 行 0 密码不改（占位回传），行 1 改成新明文
    const detail = await svc.getDataset(created.id);
    const rows = detail!.rows.map((r, i) => ({
      disabled: false,
      cells: {
        username: `user-${i}`,
        password: i === 0 ? { __masked: true } : 'pw-new',
      },
    }));
    await svc.updateDataset(created.id, { name: '账号2', columns: body.columns, rows });
    const run = await svc.loadDatasetForRun(created.id);
    expect(run.rows).toHaveLength(2);
    expect(run.rows[0].vars.password).toBe('pw-1'); // 旧密文沿用 → 仍可解出原值
    expect(run.rows[1].vars.password).toBe('pw-new');
  });

  it('updateDataset：列从敏感切成非敏感时 __masked 解回明文', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '账号3' });
    await svc.updateDataset(created.id, {
      name: '账号3',
      columns: [
        { name: 'username', sensitive: false },
        { name: 'password', sensitive: false }, // 去敏
      ],
      rows: body.rows.map(() => ({ disabled: false, cells: { username: 'x', password: { __masked: true } } })),
    });
    const detail = await svc.getDataset(created.id);
    expect(detail!.rows[0].cells.password).toBe('pw-1');
  });

  it('updateDataset：敏感列改名 + renames 声明 → __masked 沿用旧密文，回放变量跟随新列名', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '改名账号' });
    const detail = await svc.getDataset(created.id);
    const updated = await svc.updateDataset(created.id, {
      name: '改名账号',
      columns: [
        { name: 'username', sensitive: false },
        { name: 'secret', sensitive: true }, // password → secret
      ],
      renames: { password: 'secret' },
      rows: detail!.rows.map((r) => ({
        disabled: false,
        cells: { username: r.cells.username as string, secret: r.cells.password }, // __masked 原样回传
      })),
    });
    // 出参仍是掩码（不是空串）→ 密文没有丢
    expect(updated.rows[0].cells.secret).toEqual({ __masked: true });
    // 解密存活：改名后按新列名仍解出原明文
    const run = await svc.loadDatasetForRun(created.id);
    expect(run.rows[0].vars.secret).toBe('pw-1');
    expect(run.rows[1].vars.secret).toBe('pw-2');
    expect(run.rows[0].sensitiveVarKeys).toEqual(['secret']);
  });

  it('updateDataset：敏感列改名但不带 renames → 400，不再静默清空密文', async () => {
    const { HttpError } = await import('../src/middleware/errorHandler.js');
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '改名无声明' });
    const detail = await svc.getDataset(created.id);
    const missing = await svc.updateDataset(created.id, {
      name: '改名无声明',
      columns: [{ name: 'username', sensitive: false }, { name: 'secret', sensitive: true }],
      rows: detail!.rows.map((r) => ({ disabled: false, cells: { username: 'x', secret: { __masked: true } } })),
    }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(HttpError);
    expect((missing as HttpError).status).toBe(400);
    expect((missing as HttpError).message).toContain('renames');
    // renames 目标列不在本次列集 → 同样 400
    const badTarget = await svc.updateDataset(created.id, {
      name: '改名无声明',
      columns: [{ name: 'username', sensitive: false }, { name: 'secret', sensitive: true }],
      renames: { password: 'nonexistent' },
      rows: detail!.rows.map((r) => ({ disabled: false, cells: { username: 'x', secret: 'pw' } })),
    }).catch((e: unknown) => e);
    expect((badTarget as HttpError).status).toBe(400);
  });

  it('updateDataset：敏感→非敏感但旧密文损坏 → 400 提示重新填写（而非 500）', async () => {
    const { HttpError } = await import('../src/middleware/errorHandler.js');
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '坏密文去敏' });
    await pool.query(
      `UPDATE datasets SET rows = jsonb_set(rows, '{0,cells,password}', '{"c":"AAAA","i":"AAAA","t":"AAAA"}') WHERE id = $1`,
      [created.id],
    );
    const e = await svc.updateDataset(created.id, {
      name: '坏密文去敏',
      columns: [{ name: 'username', sensitive: false }, { name: 'password', sensitive: false }], // 去敏触发解密
      rows: [{ disabled: false, cells: { username: 'x', password: { __masked: true } } }],
    }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    expect((e as HttpError).message).toContain('解密失败');
  });

  it('校验：非法列名 / 重复列名 / 未知列 / 超上限 报 400', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const { HttpError } = await import('../src/middleware/errorHandler.js');
    const badNames = await svc.createDataset(projectId, {
      name: 'x1', columns: [{ name: '1bad', sensitive: false }],
      rows: [],
    }).catch((e: unknown) => e);
    expect(badNames).toBeInstanceOf(HttpError);
    expect((badNames as HttpError).status).toBe(400);

    const dup = await svc.createDataset(projectId, {
      name: 'x2', columns: [{ name: 'a', sensitive: false }, { name: 'a', sensitive: false }],
      rows: [],
    }).catch((e: unknown) => e);
    expect((dup as HttpError).status).toBe(400);

    const unknownCol = await svc.createDataset(projectId, {
      name: 'x3', columns: [{ name: 'a', sensitive: false }],
      rows: [{ disabled: false, cells: { b: 'x' } }],
    }).catch((e: unknown) => e);
    expect((unknownCol as HttpError).status).toBe(400);

    const tooMany = await svc.createDataset(projectId, {
      name: 'x4',
      columns: Array.from({ length: 31 }, (_, i) => ({ name: `c${i}`, sensitive: false })),
      rows: [],
    }).catch((e: unknown) => e);
    expect((tooMany as HttpError).status).toBe(400);
  });

  it('createDataset 重名报 409', async () => {
    const svc = await import('../src/services/datasets.service.js');
    // 注意：'登录账号' 已被首个用例占用，这里用独立名字避免跨用例冲突
    const dupBody = { ...body, name: '账号-重名' };
    await svc.createDataset(projectId, dupBody);
    const conflict = await svc.createDataset(projectId, dupBody).catch((e: unknown) => e);
    expect((conflict as { status?: number }).status).toBe(409);
  });

  it('loadDatasetForRun：过滤 disabled 行、rowIndex 从 0 编号、快照敏感值打码', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, {
      name: '账号4',
      columns: body.columns,
      rows: [
        { disabled: true, cells: { username: 'skip', password: 'pw-0' } },
        { disabled: false, cells: { username: 'alice', password: 'pw-1' } },
        { disabled: false, cells: { username: 'bob', password: 'pw-2' } },
      ],
    });
    const run = await svc.loadDatasetForRun(created.id);
    expect(run.rows).toHaveLength(2);
    expect(run.rows[0].rowIndex).toBe(0);
    expect(run.rows[0].totalRows).toBe(2);
    expect(run.rows[0].vars).toEqual({ username: 'alice', password: 'pw-1' });
    expect(run.rows[0].sensitiveVarKeys).toEqual(['password']);
    expect(run.rows[1].snapshot.values).toEqual({ username: 'bob', password: '******' });
  });

  it('loadDatasetForRun：0 启用行 / 数据集不存在 抛 DatasetConfigError', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const empty = await svc.createDataset(projectId, {
      name: '全禁用',
      columns: body.columns,
      rows: [{ disabled: true, cells: { username: 'a', password: 'b' } }],
    });
    await expect(svc.loadDatasetForRun(empty.id)).rejects.toThrow('没有启用行');
    await expect(svc.loadDatasetForRun('00000000-0000-0000-0000-000000000000')).rejects.toThrow('dataset not found');
  });

  it('datasetUsage / deleteDataset', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '待删' });
    await pool.query(`INSERT INTO test_cases(group_id, version_id, title, dataset_id) VALUES ($1, $2, '绑定用例', $3)`, [groupId, versionId, created.id]);
    expect((await svc.datasetUsage(created.id)).caseCount).toBe(1);
    await svc.deleteDataset(created.id);
    // FK SET NULL：用例自动解绑
    const c = await pool.query(`SELECT dataset_id FROM test_cases WHERE version_id = $1`, [versionId]);
    expect(c.rows[0].dataset_id).toBeNull();
  });

  it('loadDatasetForRun：rowIndexes 过滤 —— 只跑选中的启用行，rowIndex 是启用空间下标', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, {
      name: '账号-选行',
      columns: body.columns,
      rows: [
        { disabled: false, cells: { username: 'alice', password: 'pw-0' } },
        { disabled: false, cells: { username: 'bob', password: 'pw-1' } },
        { disabled: false, cells: { username: 'carol', password: 'pw-2' } },
      ],
    });
    // 不传 = 全部启用行（旧行为）
    const all = await svc.loadDatasetForRun(created.id);
    expect(all.rows).toHaveLength(3);
    expect(all.rows.map((r) => r.rowIndex)).toEqual([0, 1, 2]);
    expect(all.rows[0].totalRows).toBe(3);
    // 只选第 2 行（启用空间下标 1）
    const one = await svc.loadDatasetForRun(created.id, { rowIndexes: [1] });
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0].rowIndex).toBe(1);
    expect(one.rows[0].vars.username).toBe('bob');
    // totalRows = 本批次执行行数（分母口径）
    expect(one.rows[0].totalRows).toBe(1);
    expect(one.rows[0].snapshot.totalRows).toBe(1);
    // 选多行 → 按数据集行序执行
    const many = await svc.loadDatasetForRun(created.id, { rowIndexes: [2, 0] });
    expect(many.rows.map((r) => r.rowIndex)).toEqual([0, 2]);
    expect(many.rows[0].totalRows).toBe(2);
    // 空数组 = 所有行
    const emptySel = await svc.loadDatasetForRun(created.id, { rowIndexes: [] });
    expect(emptySel.rows).toHaveLength(3);
    // 越界 → 抛错（宁可不跑，也不跑错行）
    await expect(svc.loadDatasetForRun(created.id, { rowIndexes: [5] })).rejects.toThrow('超出该数据集的启用行范围');
  });

  it('loadDatasetForRun：rowIndexes 编号空间 = 剔除禁用行后重编号', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, {
      name: '账号-禁用重编号',
      columns: body.columns,
      rows: [
        { disabled: true, cells: { username: 'skip', password: 'pw-0' } },
        { disabled: false, cells: { username: 'alice', password: 'pw-1' } },
        { disabled: false, cells: { username: 'bob', password: 'pw-2' } },
      ],
    });
    // 启用行只有 2 行 → 下标 0/1；选 1 = 第二个启用行（原始位置 2）
    const one = await svc.loadDatasetForRun(created.id, { rowIndexes: [1] });
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0].rowIndex).toBe(1);
    expect(one.rows[0].vars.username).toBe('bob');
    // 选 2 已越界（启用行只有 2 条）
    await expect(svc.loadDatasetForRun(created.id, { rowIndexes: [2] })).rejects.toThrow('超出该数据集的启用行范围');
  });

  it('enabledRowCount：只数启用行；数据集不存在返回 0', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, {
      name: '账号-行数',
      columns: body.columns,
      rows: [
        { disabled: true, cells: { username: 'a', password: 'b' } },
        { disabled: false, cells: { username: 'c', password: 'd' } },
      ],
    });
    expect(await svc.enabledRowCount(created.id)).toBe(1);
    expect(await svc.enabledRowCount('00000000-0000-0000-0000-000000000000')).toBe(0);
  });

  it('deleteDataset：清空绑定用例的行选择', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '待删-选行' });
    await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title, dataset_id, dataset_row_indexes) VALUES ($1, $2, '绑定选行用例', $3, ARRAY[0])`,
      [groupId, versionId, created.id],
    );
    await svc.deleteDataset(created.id);
    const c = await pool.query(`SELECT dataset_id, dataset_row_indexes FROM test_cases WHERE version_id = $1`, [versionId]);
    expect(c.rows[0].dataset_id).toBeNull();
    expect(c.rows[0].dataset_row_indexes).toEqual([]);
  });

  it('loadDatasetForRun：敏感格损坏（解密失败）抛 DatasetConfigError', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '坏密文' });
    await pool.query(
      `UPDATE datasets SET rows = jsonb_set(rows, '{0,cells,password}', '{"c":"AAAA","i":"AAAA","t":"AAAA"}') WHERE id = $1`,
      [created.id],
    );
    await expect(svc.loadDatasetForRun(created.id)).rejects.toThrow('解密失败');
  });
});

describe('datasets routes', () => {
  it('GET /projects/:id/datasets 列表不带 rows；POST 新建', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...body, name: '路由列表' });
    expect(created.status).toBe(200);
    expect(created.id ?? created.body.id).toBeTruthy();
    const list = await request(app).get(`/api/projects/${projectId}/datasets`);
    expect(list.status).toBe(200);
    const item = list.body.find((d: { id: string }) => d.id === created.body.id);
    expect(item.rowCount).toBe(2);
    expect(item.enabledRowCount).toBe(2);
    expect(item.rows).toBeUndefined();
    expect(item.columns).toEqual(body.columns.map((c) => ({ name: c.name, sensitive: c.sensitive })));
  });

  it('GET 详情敏感格 __masked；PUT 整文档更新', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...body, name: '路由编辑' });
    const detail = await request(app).get(`/api/projects/${projectId}/datasets/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.rows[0].cells.password).toEqual({ __masked: true });
    const updated = await request(app)
      .put(`/api/projects/${projectId}/datasets/${created.body.id}`)
      .send({ ...body, name: '路由编辑', rows: [{ disabled: true, cells: { username: 'z', password: { __masked: true } } }] });
    expect(updated.status).toBe(200);
    const list = await request(app).get(`/api/projects/${projectId}/datasets`);
    const item = list.body.find((d: { id: string }) => d.id === created.body.id);
    expect(item.enabledRowCount).toBe(0);
  });

  it('DELETE 需确认：先返回 requiresConfirm，confirm=true 后删除并解绑用例', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...body, name: '路由删除' });
    await pool.query(`INSERT INTO test_cases(group_id, version_id, title, dataset_id) VALUES ($1, $2, '删除绑定', $3)`, [groupId, versionId, created.body.id]);
    const first = await request(app).delete(`/api/projects/${projectId}/datasets/${created.body.id}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: false, requiresConfirm: true, caseCount: 1 });
    const second = await request(app).delete(`/api/projects/${projectId}/datasets/${created.body.id}?confirm=true`);
    expect(second.body).toEqual({ ok: true, caseCount: 1 });
    const gone = await request(app).get(`/api/projects/${projectId}/datasets/${created.body.id}`);
    expect(gone.status).toBe(404);
  });

  it('名称超 120 字符 → 400（zod max，避免 pg 22001 变 500）', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...body, name: 'x'.repeat(121) });
    expect(r.status).toBe(400);
  });

  it('跨项目访问 404（不泄露存在性）', async () => {
    const otherId = await seedProjectInOrg(pool, orgId, '别家项目');
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...body, name: '隔离' });
    const r = await request(app).get(`/api/projects/${otherId}/datasets/${created.body.id}`);
    expect(r.status).toBe(404);
  });
});

describe('case dataset binding', () => {
  async function newCase(title: string): Promise<string> {
    const r = await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, $3) RETURNING id`,
      [groupId, versionId, title],
    );
    return r.rows[0].id as string;
  }

  it('PATCH 绑定/解绑 datasetId；详情回带 datasetId', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '绑定目标' });
    const caseId = await newCase('绑定流程');
    const bind = await request(app).patch(`/api/cases/${caseId}`).send({ datasetId: created.id });
    expect(bind.status).toBe(200);
    expect(bind.body.datasetId).toBe(created.id);
    const detail = await request(app).get(`/api/cases/${caseId}`);
    expect(detail.body.datasetId).toBe(created.id);
    const unbind = await request(app).patch(`/api/cases/${caseId}`).send({ datasetId: null });
    expect(unbind.body.datasetId).toBeNull();
  });

  it('绑定别的项目的数据集报 400', async () => {
    const otherId2 = await seedProjectInOrg(pool, orgId, '别家2');
    await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'G')`, [otherId2]);
    const g = await pool.query(`SELECT id FROM "groups" WHERE project_id = $1`, [otherId2]);
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '本项目的' });
    const foreign = await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, '外案') RETURNING id`,
      [g.rows[0].id, versionId],
    );
    const r = await request(app).patch(`/api/cases/${foreign.rows[0].id}`).send({ datasetId: created.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('dataset_project_mismatch');
  });

  it('PATCH datasetRowIndexes：合法下标落库并回带；[] = 所有行', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '行选择目标' });
    const caseId = await newCase('行选择用例');
    await request(app).patch(`/api/cases/${caseId}`).send({ datasetId: created.id });

    const r = await request(app).patch(`/api/cases/${caseId}`).send({ datasetRowIndexes: [0, 1] });
    expect(r.status).toBe(200);
    expect(r.body.datasetRowIndexes).toEqual([0, 1]);
    const detail = await request(app).get(`/api/cases/${caseId}`);
    expect(detail.body.datasetRowIndexes).toEqual([0, 1]);

    // [] = 所有启用行（默认口径）
    const empty = await request(app).patch(`/api/cases/${caseId}`).send({ datasetRowIndexes: [] });
    expect(empty.status).toBe(200);
    expect(empty.body.datasetRowIndexes).toEqual([]);
  });

  it('PATCH datasetRowIndexes：负数 400；越界 400（文案含越界行号与启用行总数）', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '行选择校验' });
    const caseId = await newCase('行选择校验用例');
    await request(app).patch(`/api/cases/${caseId}`).send({ datasetId: created.id });

    const neg = await request(app).patch(`/api/cases/${caseId}`).send({ datasetRowIndexes: [-1] });
    expect(neg.status).toBe(400);

    const oob = await request(app).patch(`/api/cases/${caseId}`).send({ datasetRowIndexes: [999] });
    expect(oob.status).toBe(400);
    expect(oob.body.message).toContain('超出该数据集的启用行范围');
    expect(oob.body.message).toContain('共 2 行');
  });

  it('PATCH datasetRowIndexes：绑定数据集与选行同一次保存 → 选择落库（不被换数据集清掉）', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '一次保存数据集' });
    const caseId = await newCase('一次保存用例');

    // 前端「先选数据集 → 选行 → 一次保存」：datasetId 与 datasetRowIndexes 同时到达
    const both = await request(app).patch(`/api/cases/${caseId}`).send({
      datasetId: created.id,
      datasetRowIndexes: [1],
    });
    expect(both.status).toBe(200);
    expect(both.body.datasetRowIndexes).toEqual([1]);
    const detail = await request(app).get(`/api/cases/${caseId}`);
    expect(detail.body.datasetRowIndexes).toEqual([1]);
  });

  it('PATCH datasetRowIndexes：未绑数据集 400；解绑/换数据集 → 选择清空', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const ds1 = await svc.createDataset(projectId, { ...body, name: '数据集甲' });
    const ds2 = await svc.createDataset(projectId, { ...body, name: '数据集乙' });

    // 没有数据集时选行 → 400
    const noDs = await newCase('无数据集选行');
    const bad = await request(app).patch(`/api/cases/${noDs}`).send({ datasetRowIndexes: [0] });
    expect(bad.status).toBe(400);

    // 解绑 → 选择清空
    const caseId = await newCase('解绑清空');
    await request(app).patch(`/api/cases/${caseId}`).send({ datasetId: ds1.id });
    await request(app).patch(`/api/cases/${caseId}`).send({ datasetRowIndexes: [0] });
    const unbind = await request(app).patch(`/api/cases/${caseId}`).send({ datasetId: null });
    expect(unbind.status).toBe(200);
    expect(unbind.body.datasetRowIndexes).toEqual([]);

    // 换数据集 → 选择重置（下标空间属于旧数据集）
    const caseId2 = await newCase('换数据集重置');
    await request(app).patch(`/api/cases/${caseId2}`).send({ datasetId: ds1.id });
    await request(app).patch(`/api/cases/${caseId2}`).send({ datasetRowIndexes: [1] });
    const swapped = await request(app).patch(`/api/cases/${caseId2}`).send({ datasetId: ds2.id });
    expect(swapped.status).toBe(200);
    expect(swapped.body.datasetRowIndexes).toEqual([]);
  });

  it('PUT steps：数据集列作初始变量不误报未定义；compiled[1] 里的引用也检出', async () => {
    const svc = await import('../src/services/datasets.service.js');
    const created = await svc.createDataset(projectId, { ...body, name: '体检数据集' });
    const caseId = await newCase('变量体检集成');
    const bind = await request(app).patch(`/api/cases/${caseId}`).send({ datasetId: created.id });
    expect(bind.status).toBe(200);
    const put = await request(app).put(`/api/cases/${caseId}/steps`).send({
      steps: [
        { instruction: '输入用户名', compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#u' }], value: '{{username}}' }] },
        { instruction: '抽取token', compiled: [{ kind: 'extract', locator: [{ strategy: 'css', value: 'a' }], varName: 'token', mode: 'completeValue' }] },
        { instruction: '输入token', compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#t' }], value: '{{token}}' }] },
        { instruction: '组合步骤', compiled: [
          { kind: 'waitFor', locator: [{ strategy: 'css', value: '#x' }], timeoutMs: 1000 },
          { kind: 'assertText', locator: [{ strategy: 'css', value: '#y' }], equals: '订单{{orderNo}}' },
        ] },
      ],
    });
    expect(put.status).toBe(200);
    // 数据集列（username）与已 extract 的 token 不误报未定义
    const names: string[] = put.body.variableReport.undefined.map((u: { name: string }) => u.name);
    expect(names).not.toContain('username');
    expect(names).not.toContain('token');
    // orderNo 既不在数据集列也没 extract，且位于 compiled[1]（第二个动作）——必须被扁平化检出，stepOrder 映射回步骤 3
    expect(put.body.variableReport.undefined).toContainEqual({ stepOrder: 3, field: 'assertText.equals', name: 'orderNo' });
  });
});
