import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
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
});
