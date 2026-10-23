import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProductLine } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

const GIT = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.PI_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-space-repo-'));
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

async function makeFixtureRepo(): Promise<string> {
  const bareParent = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-remote-'));
  const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-seed-'));
  GIT('git init -b main .', seed);
  await fs.writeFile(path.join(seed, 'app.txt'), 'main-content');
  GIT("git add -A && git -c user.email=t@t -c user.name=t commit -m main", seed);
  GIT('git checkout -b feature', seed);
  await fs.writeFile(path.join(seed, 'app.txt'), 'feature-content');
  GIT("git add -A && git -c user.email=t@t -c user.name=t commit -m feature", seed);
  GIT('git tag v1', seed);
  GIT(`git clone --bare . ${bareParent}/repo.git`, seed);
  return `${bareParent}/repo.git`;
}

describe('checkoutRepoForVersion', () => {
  it('version.ref 优先于项目默认分支;meta 记录实际 ref', async () => {
    const repoUrl = await makeFixtureRepo();
    const { productLineId } = await seedProductLine(pool);
    const projectId = (await pool.query(
      `INSERT INTO projects(product_line_id, name, repo_url, provider, default_branch) VALUES ($1,'p',$2,'github','main') RETURNING id`,
      [productLineId, `file://${repoUrl}`],
    )).rows[0]!.id as string;
    const versionId = (await pool.query(
      `INSERT INTO project_versions(project_id, name, ref, ref_kind) VALUES ($1,'v1','feature','branch') RETURNING id`,
      [projectId],
    )).rows[0]!.id as string;

    const { checkoutRepoForVersion } = await import('../src/pi/repo.js');
    const cwd = await checkoutRepoForVersion(versionId);
    expect(await fs.readFile(path.join(cwd, 'app.txt'), 'utf8')).toBe('feature-content');
    const meta = JSON.parse(await fs.readFile(path.join(cwd, '.itest-sandbox.json'), 'utf8')) as { branch: string };
    expect(meta.branch).toBe('feature');

    // 二次 checkout 走 fetch+reset 分支,结果幂等
    const cwd2 = await checkoutRepoForVersion(versionId);
    expect(cwd2).toBe(cwd);

    // 已有沙箱上切换 ref(FETCH_HEAD 机制的核心场景):feature → main,内容跟随
    await pool.query(`UPDATE project_versions SET ref='main' WHERE id=$1`, [versionId]);
    const cwd3 = await checkoutRepoForVersion(versionId);
    expect(cwd3).toBe(cwd);
    expect(await fs.readFile(path.join(cwd3, 'app.txt'), 'utf8')).toBe('main-content');
    const meta3 = JSON.parse(await fs.readFile(path.join(cwd3, '.itest-sandbox.json'), 'utf8')) as { branch: string };
    expect(meta3.branch).toBe('main');
  }, 30_000);

  it('version.ref 为空 → 回落项目默认分支;项目无 repoUrl → no_repo', async () => {
    const repoUrl = await makeFixtureRepo();
    const { productLineId } = await seedProductLine(pool);
    const p1 = (await pool.query(
      `INSERT INTO projects(product_line_id, name, repo_url, provider, default_branch) VALUES ($1,'p1',$2,'github','main') RETURNING id`,
      [productLineId, `file://${repoUrl}`],
    )).rows[0]!.id as string;
    const v1 = (await pool.query(
      `INSERT INTO project_versions(project_id, name) VALUES ($1,'v-default') RETURNING id`,
      [p1],
    )).rows[0]!.id as string;
    const p2 = (await pool.query(
      `INSERT INTO projects(product_line_id, name) VALUES ($1,'p2') RETURNING id`,
      [productLineId],
    )).rows[0]!.id as string;
    const v2 = (await pool.query(
      `INSERT INTO project_versions(project_id, name) VALUES ($1,'v-norepo') RETURNING id`,
      [p2],
    )).rows[0]!.id as string;

    const { checkoutRepoForVersion, RepoUnavailableError } = await import('../src/pi/repo.js');
    const cwd = await checkoutRepoForVersion(v1);
    expect(await fs.readFile(path.join(cwd, 'app.txt'), 'utf8')).toBe('main-content');
    await expect(checkoutRepoForVersion(v2)).rejects.toBeInstanceOf(RepoUnavailableError);
  }, 30_000);

  it('version.ref_kind=tag 时按 tag checkout', async () => {
    const repoUrl = await makeFixtureRepo();
    const { productLineId } = await seedProductLine(pool);
    const projectId = (await pool.query(
      `INSERT INTO projects(product_line_id, name, repo_url, provider, default_branch) VALUES ($1,'pt',$2,'github','main') RETURNING id`,
      [productLineId, `file://${repoUrl}`],
    )).rows[0]!.id as string;
    // ref_kind 仅是展示语义;checkout 只认 ref 值 —— 用 tag 名验证 fetch FETCH_HEAD 对 tag 生效
    const versionId = (await pool.query(
      `INSERT INTO project_versions(project_id, name, ref, ref_kind) VALUES ($1,'vt','v1','tag') RETURNING id`,
      [projectId],
    )).rows[0]!.id as string;

    const { checkoutRepoForVersion } = await import('../src/pi/repo.js');
    const cwd = await checkoutRepoForVersion(versionId);
    expect(await fs.readFile(path.join(cwd, 'app.txt'), 'utf8')).toBe('feature-content');
    const meta = JSON.parse(await fs.readFile(path.join(cwd, '.itest-sandbox.json'), 'utf8')) as { branch: string };
    expect(meta.branch).toBe('v1');
  }, 30_000);
});
