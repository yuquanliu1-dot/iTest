import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

async function makeBareRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-bare-'));
  spawnSync('git', ['init', '--bare', dir], { stdio: 'ignore' });
  // 推一个 commit 到 main
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-work-'));
  spawnSync('git', ['init', '-b', 'main', work], { stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: work });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: work });
  await fs.writeFile(path.join(work, 'f.txt'), 'hello');
  spawnSync('git', ['add', '.'], { cwd: work });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: work });
  spawnSync('git', ['remote', 'add', 'origin', dir], { cwd: work });
  spawnSync('git', ['push', 'origin', 'main'], { cwd: work });
  await fs.rm(work, { recursive: true, force: true });
  return dir;
}

describe('checkoutRepo end-to-end (local bare repo)', () => {
  it('首次 checkout 浅克隆 + 写 .itest-sandbox.json', async () => {
    const bare = await makeBareRepo();
    await pool.query(`UPDATE projects SET repo_url=$1, default_branch='main', provider='github' WHERE id=$2`, [bare, projectId]);
    const { checkoutRepo } = await import('../src/pi/repo.js');
    const target = await checkoutRepo(reqId);
    expect(target.startsWith(reposRoot)).toBe(true);
    const meta = JSON.parse(await fs.readFile(path.join(target, '.itest-sandbox.json'), 'utf8'));
    expect(meta.branch).toBe('main');
    expect(meta.provider).toBe('github');
    expect(typeof meta.commit).toBe('string');
    expect(meta.commit.length).toBeGreaterThanOrEqual(7);
    await fs.rm(bare, { recursive: true, force: true });
  }, 30_000);

  it('第二次 checkout 复用本地，commit 保持一致', async () => {
    const bare = await makeBareRepo();
    await pool.query(`UPDATE projects SET repo_url=$1, default_branch='main', provider='github' WHERE id=$2`, [bare, projectId]);
    const { checkoutRepo } = await import('../src/pi/repo.js');
    const t1 = await checkoutRepo(reqId);
    const m1 = JSON.parse(await fs.readFile(path.join(t1, '.itest-sandbox.json'), 'utf8'));
    const t2 = await checkoutRepo(reqId);
    expect(t1).toBe(t2);
    const m2 = JSON.parse(await fs.readFile(path.join(t2, '.itest-sandbox.json'), 'utf8'));
    expect(m2.commit).toBe(m1.commit);
    await fs.rm(bare, { recursive: true, force: true });
  }, 30_000);

  it('并发冷 checkout：先锁后检串行化，双请求都成功且目标一致（3 副本同检竞态回归）', async () => {
    const bare = await makeBareRepo();
    await pool.query(`UPDATE projects SET repo_url=$1, default_branch='main', provider='github' WHERE id=$2`, [bare, projectId]);
    const { checkoutRepo } = await import('../src/pi/repo.js');
    // 两路并发都从「目录不存在」进入：赢家锁内克隆，输家等锁后二次检查走热路径。
    // 旧实现（冷路径吞锁 + rm 在拿锁前）此场景会互相 rm/克隆同一目录。
    const [a, b] = await Promise.all([checkoutRepo(reqId), checkoutRepo(reqId)]);
    expect(a).toBe(b);
    const meta = JSON.parse(await fs.readFile(path.join(a, '.itest-sandbox.json'), 'utf8'));
    expect(meta.branch).toBe('main');
    expect(typeof meta.commit).toBe('string');
    await fs.rm(bare, { recursive: true, force: true });
  }, 30_000);
});