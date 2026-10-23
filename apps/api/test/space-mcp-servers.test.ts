import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject, seedProjectInOrg } from './helpers/db.js';

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
  await pool.query(`TRUNCATE assistant_guides, assistant_mcp_servers`);
});

describe('S3 mcp-servers：CRUD + 配置期守卫 + 鉴权 + 跨组织隔离', () => {
  it('POST 建 stdio/http server；config 期守卫：oauth 拒、缺 command 拒、file:// 拒、缺 name 拒', async () => {
    const stdio = await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'my-server', kind: 'stdio', command: 'node', args: ['x'], exposure: 'direct' });
    expect(stdio.status).toBe(201);
    expect(stdio.body).toMatchObject({ kind: 'stdio', command: 'node', exposure: 'direct', scope: 'global', enabled: true });

    const http = await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'http-server', kind: 'http', url: 'https://mcp.example.com/sse', env: { TOKEN: 'env:SOME_KEY' } });
    expect(http.status).toBe(201);
    expect(http.body).toMatchObject({ kind: 'http', url: 'https://mcp.example.com/sse' });

    // 配置期守卫（spec §MCP）：oauth/未知 exposure 一律 400
    expect((await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'x', kind: 'stdio', command: 'node', exposure: 'oauth' })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'x', kind: 'stdio', command: 'node', exposure: 'nope' })).status).toBe(400);
    // stido 必须 command；http 必须 http(s):// url（防 file:// 本地读取）
    expect((await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'x', kind: 'stdio' })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'x', kind: 'http', url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ kind: 'stdio', command: 'node' })).status).toBe(400); // 缺 name
  });

  it('GET：kind/enabled 过滤；默认全量按 name 排序', async () => {
    await request(managerApp).post('/api/assistant/mcp-servers').send({ name: 'b-server', kind: 'stdio', command: 'node' });
    await request(managerApp).post('/api/assistant/mcp-servers').send({ name: 'a-server', kind: 'http', url: 'https://x.dev' });
    await request(managerApp).post('/api/assistant/mcp-servers').send({ name: 'z-off', kind: 'stdio', command: 'node', enabled: false });
    const all = await request(managerApp).get('/api/assistant/mcp-servers');
    expect(all.status).toBe(200);
    expect(all.body.map((s: { name: string }) => s.name)).toEqual(['a-server', 'b-server', 'z-off']);
    const onlyHttp = await request(managerApp).get('/api/assistant/mcp-servers?kind=http');
    expect(onlyHttp.body.map((s: { name: string }) => s.name)).toEqual(['a-server']);
    const onlyDisabled = await request(managerApp).get('/api/assistant/mcp-servers?enabled=false');
    expect(onlyDisabled.body.map((s: { name: string }) => s.name)).toEqual(['z-off']);
  });

  it('PATCH 改 kind 须带上新 kind 的必需字段并清掉旧列（回归：kind-switch 丢字段）', async () => {
    const created = await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'switcher', kind: 'stdio', command: 'node' });
    const id = created.body.id as string;
    // stdio → http：url 落库、command 清空
    const toHttp = await request(managerApp).patch(`/api/assistant/mcp-servers/${id}`)
      .send({ kind: 'http', url: 'https://mcp.example.com/sse' });
    expect(toHttp.status).toBe(200);
    expect(toHttp.body).toMatchObject({ kind: 'http', url: 'https://mcp.example.com/sse', command: null });
    // http → stdio：command 落库、url 清空
    const toStdio = await request(managerApp).patch(`/api/assistant/mcp-servers/${id}`)
      .send({ kind: 'stdio', command: 'node' });
    expect(toStdio.status).toBe(200);
    expect(toStdio.body).toMatchObject({ kind: 'stdio', command: 'node', url: null });
    // 改 kind 但缺必需字段 → 400
    expect((await request(managerApp).patch(`/api/assistant/mcp-servers/${id}`)
      .send({ kind: 'http' })).status).toBe(400);
    // 单改 command（不动 kind）合法
    const cmdOnly = await request(managerApp).patch(`/api/assistant/mcp-servers/${id}`).send({ command: 'node --version' });
    expect(cmdOnly.status).toBe(200);
    expect(cmdOnly.body.command).toBe('node --version');
  });

  it('PATCH 非法 exposure → 400；DELETE 删除返回 204；删不存在 → 404', async () => {
    const created = await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'd', kind: 'stdio', command: 'node' });
    const id = created.body.id as string;
    expect((await request(managerApp).patch(`/api/assistant/mcp-servers/${id}`).send({ exposure: 'oauth' })).status).toBe(400);
    expect((await request(managerApp).delete(`/api/assistant/mcp-servers/${id}`)).status).toBe(204);
    expect((await request(managerApp).get('/api/assistant/mcp-servers')).body.length).toBe(0);
    expect((await request(managerApp).delete(`/api/assistant/mcp-servers/${id}`)).status).toBe(404);
  });

  it('member 一律 403；POST scope=project/version 引用组织内项目可建', async () => {
    const { projectId, versionId } = await seedProject(pool);
    expect((await request(memberApp).post('/api/assistant/mcp-servers')
      .send({ name: 'x', kind: 'stdio', command: 'node' })).status).toBe(403);
    expect((await request(memberApp).get('/api/assistant/mcp-servers')).status).toBe(403);
    expect((await request(memberApp).patch('/api/assistant/mcp-servers/x').send({ enabled: true })).status).toBe(403);
    expect((await request(memberApp).delete('/api/assistant/mcp-servers/x')).status).toBe(403);
    // scope=project/version 需要对应 id，引用可见项目 → 201
    const scoped = await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'scoped', kind: 'stdio', command: 'node', scope: 'project', projectId });
    expect(scoped.status).toBe(201);
    expect(scoped.body.scope).toBe('project');
    expect((await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'v-scoped', kind: 'stdio', command: 'node', scope: 'version', versionId })).status).toBe(201);
    expect((await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'bad-scope', kind: 'stdio', command: 'node', scope: 'project' })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'bad-scope2', kind: 'stdio', command: 'node', scope: 'org' })).status).toBe(400);
  });

  it('跨组织隔离：project/version 归属组织，manager A 看不到/改不了 B 组织 scoped servers，global 仍共享', async () => {
    const orgB = randomUUID();
    await pool.query(`INSERT INTO organizations(id, name, path) VALUES ($1, '组织B-mcp', $2)`, [orgB, `/${orgB}/`]);
    const projB = await seedProjectInOrg(pool, orgB, 'P-B-MCP');
    const verB = (await pool.query(`INSERT INTO project_versions(project_id, name) VALUES ($1, 'v0') RETURNING id`, [projB])).rows[0]!.id as string;
    const rowProj = randomUUID();
    const rowVer = randomUUID();
    await pool.query(`INSERT INTO assistant_mcp_servers (id, name, kind, command, scope, project_id, version_id) VALUES
      ($1,'B-PROJ','stdio','node','project',$2,NULL),
      ($3,'B-VER','stdio','node','version',NULL,$4)`,
      [rowProj, projB, rowVer, verB]);
    await pool.query(`INSERT INTO assistant_mcp_servers (id, name, kind, command, scope) VALUES
      ($1,'SHARED','stdio','node','global')`, [randomUUID()]);
    // GET：B 组织 scoped 行不可见，global 仍返回
    const listed = await request(managerApp).get('/api/assistant/mcp-servers');
    expect(listed.status).toBe(200);
    const names = listed.body.map((s: { name: string }) => s.name);
    expect(names).toContain('SHARED');
    expect(names).not.toContain('B-PROJ');
    expect(names).not.toContain('B-VER');
    // PATCH/DELETE：跨组织 scoped 行一律 404；POST 引用 B 组织项目/版本同样 404
    expect((await request(managerApp).patch(`/api/assistant/mcp-servers/${rowProj}`).send({ command: 'x' })).status).toBe(404);
    expect((await request(managerApp).delete(`/api/assistant/mcp-servers/${rowVer}`)).status).toBe(404);
    expect((await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'x', kind: 'stdio', command: 'node', scope: 'project', projectId: projB })).status).toBe(404);
    expect((await request(managerApp).post('/api/assistant/mcp-servers')
      .send({ name: 'x', kind: 'stdio', command: 'node', scope: 'version', versionId: verB })).status).toBe(404);
  });
});
