import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
let reqId: string;
let reposRoot: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-repos-'));
  process.env.PI_DATA_DIR = reposRoot;
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
  await fs.rm(reposRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // 不 TRUNCATE，靠 vitest 的 file-level 隔离（test 顺序 + 各自 insert）。
  // seedProject() 复用 WeakMap 缓存的 orgId；如果前面已经 seed 过，本测试只是再添加新的
  // 项目到同一组织下，不影响 FK。
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
  reqId = r.rows[0]!.id as string;
});

describe('checkoutRepo', () => {
  it('projects.repoUrl 缺失抛 RepoUnavailableError(no_repo)', async () => {
    const { checkoutRepo, RepoUnavailableError } = await import('../src/pi/repo.js');
    await expect(checkoutRepo(reqId)).rejects.toBeInstanceOf(RepoUnavailableError);
    try { await checkoutRepo(reqId); } catch (e) { expect((e as { reason: string }).reason).toBe('no_repo'); }
  }, 30_000);

  it('repoUrl 存在但 git clone 失败抛 RepoUnavailableError(clone_failed or auth_failed)', async () => {
    await pool.query(`UPDATE projects SET repo_url=$1 WHERE id=$2`, ['https://github.com/itest-nonexistent-12345-xyz/foo.git', projectId]);
    const { checkoutRepo, RepoUnavailableError } = await import('../src/pi/repo.js');
    await expect(checkoutRepo(reqId)).rejects.toBeInstanceOf(RepoUnavailableError);
  }, 30_000);
});