import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let managerApp: import('express').Express;
let memberApp: import('express').Express;
/** 隔离的 .data 根：必须在任何静态/动态 import skillsStore 之前设好，否则模块级 SKILLS_ROOT
 *  会解析到开发者真实的 PI_DATA_DIR，测试会真的建删目录。 */
let tmpDataDir: string;

const skillsRoot = (): string => path.join(tmpDataDir, 'skills');
const skillDir = (name: string): string => path.join(skillsRoot(), name);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  tmpDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'itest-skilldata-'));
  process.env.PI_DATA_DIR = tmpDataDir;
  vi.resetModules();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf, memberUserOf } = await import('./helpers/auth.js');
  const mount = (user: ReturnType<typeof managerUserOf>) => {
    const a = exp();
    // 与 src/index.ts 一致的 body 上限；默认 100kb 会让「单文件 1MB」用例在解析层就失败。
    a.use(exp.json({ limit: '2mb' }));
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
  await fs.promises.rm(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query('TRUNCATE assistant_skills');
  await fs.promises.rm(skillsRoot(), { recursive: true, force: true });
});

describe('skills 元数据 CRUD（文件系统为真源）', () => {
  it('POST 建目录 + SKILL.md 骨架 + DB 行', async () => {
    const ok = await request(managerApp).post('/api/assistant/skills')
      .send({ name: 'smoke-check', description: '冒烟技能' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ name: 'smoke-check', description: '冒烟技能', enabled: true, onDisk: true });
    const md = path.join(skillDir('smoke-check'), 'SKILL.md');
    expect(fs.existsSync(md)).toBe(true);
    expect(fs.readFileSync(md, 'utf8')).toContain('name: "smoke-check"');
    expect(ok.body.fileCount).toBe(1); // 只有 SKILL.md
  });

  it('name slug 校验 + 重名 409 + 缺 description 400', async () => {
    await request(managerApp).post('/api/assistant/skills').send({ name: 'dup', description: 'd' });
    expect((await request(managerApp).post('/api/assistant/skills').send({ name: 'dup', description: 'd2' })).status).toBe(409);
    expect((await request(managerApp).post('/api/assistant/skills').send({ name: 'Bad_Name', description: 'x' })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/skills').send({ name: '-lead', description: 'x' })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/skills').send({ name: 'nd' })).status).toBe(400);
  });

  it('GET：全量按 name 排序；enabled 过滤', async () => {
    for (const [name, enabled] of [['b', true], ['a', true], ['z-off', false]] as const) {
      await request(managerApp).post('/api/assistant/skills').send({ name, description: 'x', enabled });
    }
    const all = await request(managerApp).get('/api/assistant/skills');
    expect(all.status).toBe(200);
    expect(all.body.map((s: { name: string }) => s.name)).toEqual(['a', 'b', 'z-off']);
    expect((await request(managerApp).get('/api/assistant/skills?enabled=true'))
      .body.map((s: { name: string }) => s.name)).toEqual(['a', 'b']);
    expect((await request(managerApp).get('/api/assistant/skills?enabled=false'))
      .body.map((s: { name: string }) => s.name)).toEqual(['z-off']);
  });

  it('PATCH 改名 → 目录跟着搬', async () => {
    const created = await request(managerApp).post('/api/assistant/skills').send({ name: 'old-name', description: 'x' });
    const id = created.body.id as string;
    const patched = await request(managerApp).patch(`/api/assistant/skills/${id}`).send({ name: 'new-name', description: 'y' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: 'new-name', description: 'y', onDisk: true });
    expect(fs.existsSync(skillDir('old-name'))).toBe(false);
    expect(fs.existsSync(path.join(skillDir('new-name'), 'SKILL.md'))).toBe(true);
  });

  it('PATCH 改 enabled/description；改名撞已有 409；不存在 404；空 description 400', async () => {
    const created = await request(managerApp).post('/api/assistant/skills').send({ name: 'editable', description: 'x' });
    const id = created.body.id as string;
    const patched = await request(managerApp).patch(`/api/assistant/skills/${id}`).send({ description: 'y', enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ description: 'y', enabled: false });
    await request(managerApp).post('/api/assistant/skills').send({ name: 'taken', description: 'x' });
    expect((await request(managerApp).patch(`/api/assistant/skills/${id}`).send({ name: 'taken' })).status).toBe(409);
    expect((await request(managerApp).patch(`/api/assistant/skills/${randomUUID()}`).send({ enabled: true })).status).toBe(404);
    expect((await request(managerApp).patch(`/api/assistant/skills/${id}`).send({ description: '' })).status).toBe(400);
  });

  it('DELETE：DB 行与磁盘目录一起没；再删 404', async () => {
    const created = await request(managerApp).post('/api/assistant/skills').send({ name: 'gone', description: 'x' });
    const id = created.body.id as string;
    expect((await request(managerApp).delete(`/api/assistant/skills/${id}`)).status).toBe(204);
    expect(fs.existsSync(skillDir('gone'))).toBe(false);
    expect((await request(managerApp).get('/api/assistant/skills')).body.length).toBe(0);
    expect((await request(managerApp).delete(`/api/assistant/skills/${id}`)).status).toBe(404);
  });

  it('GET：孤儿目录以 unregistered 行出现，绝不入 enabled 过滤结果', async () => {
    await request(managerApp).post('/api/assistant/skills').send({ name: 'counted', description: 'x' });
    fs.mkdirSync(path.join(skillDir('counted'), 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skillDir('counted'), 'scripts', 'a.py'), 'print(1)');
    fs.mkdirSync(skillDir('orphan-dir'), { recursive: true });
    fs.writeFileSync(path.join(skillDir('orphan-dir'), 'SKILL.md'), 'x');

    const all = await request(managerApp).get('/api/assistant/skills');
    const counted = all.body.find((s: { name: string }) => s.name === 'counted');
    expect(counted.fileCount).toBe(2); // SKILL.md + scripts/a.py
    const orphan = all.body.find((s: { name: string }) => s.name === 'orphan-dir');
    expect(orphan.unregistered).toBe(true);
    expect(orphan.id).toBeNull();
    expect((await request(managerApp).get('/api/assistant/skills?enabled=true'))
      .body.map((s: { name: string }) => s.name)).toEqual(['counted']);
  });

  it('member 一律 403', async () => {
    expect((await request(memberApp).post('/api/assistant/skills').send({ name: 'x', description: 'x' })).status).toBe(403);
    expect((await request(memberApp).get('/api/assistant/skills')).status).toBe(403);
    expect((await request(memberApp).patch('/api/assistant/skills/x').send({ enabled: true })).status).toBe(403);
    expect((await request(memberApp).delete('/api/assistant/skills/x')).status).toBe(403);
    expect((await request(memberApp).delete('/api/assistant/skills/orphan/x')).status).toBe(403);
  });

  it('DELETE /orphan/:name 删未登记目录；已登记的走常规删除（409）', async () => {
    fs.mkdirSync(skillDir('orphan-del'), { recursive: true });
    fs.writeFileSync(path.join(skillDir('orphan-del'), 'SKILL.md'), 'x');
    const r = await request(managerApp).delete('/api/assistant/skills/orphan/orphan-del');
    expect(r.status).toBe(204);
    expect(fs.existsSync(skillDir('orphan-del'))).toBe(false);
    // 目录已不在 → 404
    expect((await request(managerApp).delete('/api/assistant/skills/orphan/orphan-del')).status).toBe(404);

    // 已登记的技能不允许走 orphan 路由（否则 DB 行会变成指向空目录的死行）
    await request(managerApp).post('/api/assistant/skills').send({ name: 'registered', description: 'd' });
    const clash = await request(managerApp).delete('/api/assistant/skills/orphan/registered');
    expect(clash.status).toBe(409);
    expect(fs.existsSync(skillDir('registered'))).toBe(true);
  });

  it('DELETE /orphan/:name 名称非法 → 400（守卫 name 段）', async () => {
    for (const bad of ['Bad_Name', '..', 'a%2Fb']) {
      expect((await request(managerApp).delete(`/api/assistant/skills/orphan/${bad}`)).status).toBe(400);
    }
  });
});

describe('skill 文件树接口', () => {
  const newSkill = async (name: string): Promise<string> => {
    const r = await request(managerApp).post('/api/assistant/skills').send({ name, description: 'd' });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };

  it('PUT/GET/DELETE 文件往返', async () => {
    const id = await newSkill('tree-skill');
    fs.mkdirSync(path.join(skillDir('tree-skill'), 'scripts'), { recursive: true });
    const put = await request(managerApp).put(`/api/assistant/skills/${id}/file`)
      .send({ path: 'scripts/a.py', content: 'print(1)' });
    expect(put.status).toBe(200);
    const got = await request(managerApp).get(`/api/assistant/skills/${id}/file?path=scripts%2Fa.py`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ path: 'scripts/a.py', content: 'print(1)', truncated: false });
    expect((await request(managerApp).delete(`/api/assistant/skills/${id}/file?path=scripts%2Fa.py`)).status).toBe(204);
    expect(fs.existsSync(path.join(skillDir('tree-skill'), 'scripts', 'a.py'))).toBe(false);
  });

  it('越界路径全部 400（绝对/.. /盘符/隐藏文件/.git/node_modules/空字节）', async () => {
    const id = await newSkill('guard-skill');
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'C:\\Windows\\x', '.env', '.git/config', 'node_modules/x', 'scripts\\a.py']) {
      const r = await request(managerApp).put(`/api/assistant/skills/${id}/file`).send({ path: bad, content: 'x' });
      expect(r.status, `path=${bad}`).toBe(400);
    }
  });

  it('软链逃逸 → 400（词法守卫挡不住的那类）', async () => {
    const id = await newSkill('sym-skill');
    fs.symlinkSync('/tmp', path.join(skillDir('sym-skill'), 'evil'));
    const r = await request(managerApp).put(`/api/assistant/skills/${id}/file`).send({ path: 'evil/x', content: 'x' });
    expect(r.status).toBe(400);
  });

  it('父目录不存在 → 400（不递归 mkdir，目录结构只来自 import）', async () => {
    const id = await newSkill('nomkdir-skill');
    const r = await request(managerApp).put(`/api/assistant/skills/${id}/file`).send({ path: 'no/such/dir/f.py', content: 'x' });
    expect(r.status).toBe(400);
  });

  it('GET /tree 递归列出目录，剔除 .git', async () => {
    const id = await newSkill('t2');
    fs.mkdirSync(path.join(skillDir('t2'), 'references'), { recursive: true });
    fs.mkdirSync(path.join(skillDir('t2'), '.git'), { recursive: true });
    fs.writeFileSync(path.join(skillDir('t2'), 'references', 'schemas.md'), 'x');
    fs.writeFileSync(path.join(skillDir('t2'), '.git', 'config'), 'x');
    const t = await request(managerApp).get(`/api/assistant/skills/${id}/tree`);
    expect(t.status).toBe(200);
    const paths = t.body.map((n: { path: string }) => n.path);
    expect(paths).toContain('references');
    expect(paths).toContain('references/schemas.md');
    expect(paths.some((p: string) => p.includes('.git'))).toBe(false);
  });

  it('POST /files 批量上传到已存在子目录', async () => {
    const id = await newSkill('bulk-skill');
    fs.mkdirSync(path.join(skillDir('bulk-skill'), 'agents'), { recursive: true });
    const r = await request(managerApp).post(`/api/assistant/skills/${id}/files`)
      .send({ dir: 'agents', files: [{ path: 'grader.md', content: 'g' }, { path: 'analyzer.md', content: 'a' }] });
    expect(r.status).toBe(200);
    expect(r.body.written.sort()).toEqual(['agents/analyzer.md', 'agents/grader.md']);
    expect(fs.existsSync(path.join(skillDir('bulk-skill'), 'agents', 'grader.md'))).toBe(true);
    // 子目录不存在 → 400（不代建目录）
    expect((await request(managerApp).post(`/api/assistant/skills/${id}/files`)
      .send({ dir: 'nope', files: [{ path: 'x.md', content: 'x' }] })).status).toBe(400);
    // files 空数组 → 400
    expect((await request(managerApp).post(`/api/assistant/skills/${id}/files`)
      .send({ dir: 'agents', files: [] })).status).toBe(400);
  });

  it('DELETE /file 只能删文件，删目录 → 400', async () => {
    const id = await newSkill('dirdel-skill');
    fs.mkdirSync(path.join(skillDir('dirdel-skill'), 'scripts'), { recursive: true });
    expect((await request(managerApp).delete(`/api/assistant/skills/${id}/file?path=scripts`)).status).toBe(400);
  });

  it('单文件写入超 1MB → 400', async () => {
    const id = await newSkill('big-skill');
    const r = await request(managerApp).put(`/api/assistant/skills/${id}/file`)
      .send({ path: 'SKILL.md', content: 'x'.repeat(1_000_001) });
    expect(r.status).toBe(400);
  });

  it('未知 skill id → 404', async () => {
    expect((await request(managerApp).get('/api/assistant/skills/00000000-0000-0000-0000-000000000000/tree')).status).toBe(404);
  });

  it('member 对文件树接口一律 403', async () => {
    const id = await newSkill('member-skill');
    expect((await request(memberApp).get(`/api/assistant/skills/${id}/tree`)).status).toBe(403);
    expect((await request(memberApp).get(`/api/assistant/skills/${id}/file?path=SKILL.md`)).status).toBe(403);
    expect((await request(memberApp).put(`/api/assistant/skills/${id}/file`).send({ path: 'SKILL.md', content: 'x' })).status).toBe(403);
    expect((await request(memberApp).delete(`/api/assistant/skills/${id}/file?path=SKILL.md`)).status).toBe(403);
    expect((await request(memberApp).post(`/api/assistant/skills/${id}/files`).send({ dir: '.', files: [{ path: 'a', content: 'a' }] })).status).toBe(403);
  });
});
