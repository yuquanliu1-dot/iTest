import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProductLine } from './helpers/db.js';

let pool: Pool;
let piDataDir: string;

const GIT = (cmd: string, cwd: string, env?: Record<string, string>) =>
  execSync(cmd, { cwd, stdio: 'pipe', env: env ? { ...process.env, ...env } : process.env }).toString().trim();

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  piDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-repo-deepen-'));
  process.env.PI_DATA_DIR = piDataDir;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await fs.rm(piDataDir, { recursive: true, force: true });
});

/** 3 个提交，日期钉死在 2026-01-01/02/03（浅克隆边界按日期算必须可控）。 */
async function makeDatedRepo(): Promise<string> {
  const bareParent = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-deepen-remote-'));
  const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-deepen-seed-'));
  GIT('git init -b main .', seed);
  for (const [day, msg] of [['01', 'c1'], ['02', 'c2'], ['03', 'c3']] as const) {
    await fs.writeFile(path.join(seed, `f${day}.txt`), msg);
    GIT('git add -A', seed);
    const date = `2026-01-${day} 10:00:00`;
    GIT('git commit -q -m ' + msg, seed, {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    });
  }
  GIT(`git clone --bare . ${bareParent}/repo.git`, seed);
  return `${bareParent}/repo.git`;
}

async function seedVersion(repoUrl: string): Promise<string> {
  const { productLineId } = await seedProductLine(pool);
  const projectId = (await pool.query(
    `INSERT INTO projects(product_line_id, name, repo_url, provider, default_branch) VALUES ($1,'p',$2,'github','main') RETURNING id`,
    [productLineId, `file://${repoUrl}`],
  )).rows[0]!.id as string;
  return (await pool.query(
    `INSERT INTO project_versions(project_id, name) VALUES ($1,'v1') RETURNING id`,
    [projectId],
  )).rows[0]!.id as string;
}

const commitSubjects = (repo: string): string[] =>
  GIT('git log --format=%s', repo).split('\n').filter(Boolean).reverse();

describe('deepenVersionRepo', () => {
  it('冷路径 since 加深：工作树建在 versionWorkspaceDir，历史覆盖窗口，返回 HEAD sha', async () => {
    const repoUrl = await makeDatedRepo();
    const versionId = await seedVersion(repoUrl);
    const { deepenVersionRepo, versionWorkspaceDir } = await import('../src/pi/repo.js');

    const headSha = await deepenVersionRepo(versionId, { since: '2026-01-01T00:00:00' });
    const ws = versionWorkspaceDir(versionId);
    expect(ws).toBe(path.join(piDataDir, 'workspaces', `v-${versionId}`, 'repo'));
    expect(GIT('git rev-parse HEAD', ws)).toBe(headSha);
    // 窗口含全部 3 个提交（边界 2026-01-01T00:00 严格早于 c1 的 10:00）
    expect(commitSubjects(ws)).toEqual(['c1', 'c2', 'c3']);
  }, 30_000);

  it('冷路径 depth 加深：恰好 N 个提交', async () => {
    const repoUrl = await makeDatedRepo();
    const versionId = await seedVersion(repoUrl);
    const { deepenVersionRepo, versionWorkspaceDir } = await import('../src/pi/repo.js');

    await deepenVersionRepo(versionId, { depth: 2 });
    const ws = versionWorkspaceDir(versionId);
    expect(commitSubjects(ws)).toEqual(['c2', 'c3']);
  }, 30_000);

  it('助手 depth=1 截断后，depth 加深恢复历史（对象已在本地也恒生效）', async () => {
    const repoUrl = await makeDatedRepo();
    const versionId = await seedVersion(repoUrl);
    const { deepenVersionRepo, versionWorkspaceDir, checkoutRepoForVersion } = await import('../src/pi/repo.js');
    const ws = versionWorkspaceDir(versionId);

    await deepenVersionRepo(versionId, { since: '2026-01-01T00:00:00' });
    // 助手路径（默认 depth 1）截回 1 个提交——共享同一目录与同一把锁
    await checkoutRepoForVersion(versionId, ws);
    expect(commitSubjects(ws)).toEqual(['c3']);

    await deepenVersionRepo(versionId, { depth: 3 });
    expect(commitSubjects(ws)).toEqual(['c1', 'c2', 'c3']);
  }, 30_000);

  it('与助手检出共用目录：加深后助手 checkout 不重克隆（fetch+reset 幂等）', async () => {
    const repoUrl = await makeDatedRepo();
    const versionId = await seedVersion(repoUrl);
    const { deepenVersionRepo, versionWorkspaceDir, checkoutRepoForVersion } = await import('../src/pi/repo.js');
    const ws = versionWorkspaceDir(versionId);

    await deepenVersionRepo(versionId, { since: '2026-01-01T00:00:00' });
    const cwd = await checkoutRepoForVersion(versionId, ws);
    expect(cwd).toBe(ws);
    expect(commitSubjects(ws)).toEqual(['c3']); // depth 1
  }, 30_000);

  it('项目无 repoUrl → RepoUnavailableError(no_repo)', async () => {
    const { productLineId } = await seedProductLine(pool);
    const projectId = (await pool.query(
      `INSERT INTO projects(product_line_id, name) VALUES ($1,'no-repo') RETURNING id`,
      [productLineId],
    )).rows[0]!.id as string;
    const versionId = (await pool.query(
      `INSERT INTO project_versions(project_id, name) VALUES ($1,'v-norepo') RETURNING id`,
      [projectId],
    )).rows[0]!.id as string;
    const { deepenVersionRepo, RepoUnavailableError } = await import('../src/pi/repo.js');
    await expect(deepenVersionRepo(versionId, { depth: 5 })).rejects.toBeInstanceOf(RepoUnavailableError);
  }, 30_000);
});
