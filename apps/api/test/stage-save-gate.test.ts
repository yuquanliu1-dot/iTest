import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// P1-3 落库闸门：/stage/save 对死步骤（无 compiled 且无指令）422 拦截 + 纯 NL 草稿 advisory warnings。
// 路由级测试（supertest + 真实 stageRoute），与 space-guides.test.ts 同款挂载。
let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await (await import('./helpers/db.js')).seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app = exp();
  app.use(exp.json());
  app.use((req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/assistant', spaceRoute);
  app.use(errorHandler);
  // 动态 import：stageRoute 链上静态引 db/client（DATABASE_URL 在 beforeAll 才指向容器）
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  // 只清本测试域的表；org/project 行留给 seedOrg/seedProject 复用（org 缓存仍有效）
  await pool.query(`TRUNCATE ai_threads, ai_stage_cases, test_steps, test_cases RESTART IDENTITY CASCADE`);
});

/** 造一个版本线程 + 一条暂存用例草稿，返回 threadId/localId/groupId。 */
async function seedDraft(steps: Array<Record<string, unknown>>, title = '草稿用例'): Promise<{ threadId: string; localId: string; groupId: string }> {
  const { versionId, groupId } = await seedProject(pool);
  const threadId = randomUUID();
  await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [threadId, versionId]);
  const localId = randomUUID();
  await pool.query(
    `INSERT INTO ai_stage_cases(thread_id, local_id, version_id, title, url, steps) VALUES ($1, $2, $3, $4, 'http://env.example/page', $5::jsonb)`,
    [threadId, localId, versionId, title, JSON.stringify(steps)],
  );
  return { threadId, localId, groupId };
}

describe('POST /threads/:id/stage/save — 死步骤拦截与 NL 草稿告警', () => {
  it('死步骤（无 compiled 且无指令）→ 422 dead_steps 点名步骤序号，不落库且 stage 行保留', async () => {
    const { threadId, localId, groupId } = await seedDraft([
      { action: '点击登录按钮', compiled: null, assertion: null },
      { action: '', compiled: null, assertion: null }, // 死步：既无 DSL 也没有指令
    ], '死步用例');
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ cases: [{ localId, groupId }] });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('dead_steps');
    expect(r.body.message).toContain('死步用例');
    expect(r.body.message).toContain('第 2 步');
    // 拦截语义：用例没建、暂存行不删（用户可让助手补写后重试）
    const caseRows = await pool.query(`SELECT count(*)::int n FROM test_cases`);
    expect(caseRows.rows[0]!.n).toBe(0);
    const stageRows = await pool.query(`SELECT count(*)::int n FROM ai_stage_cases WHERE local_id = $1`, [localId]);
    expect(stageRows.rows[0]!.n).toBe(1);
  });

  it('纯 NL 草稿（有指令 + 字符串断言）→ 保存成功且带 advisory warnings', async () => {
    const { threadId, localId, groupId } = await seedDraft([
      { action: '输入用户名并点击登录', compiled: null, assertion: '页面提示登录成功' },
    ], 'NL草稿用例');
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ cases: [{ localId, groupId }] });
    expect(r.status).toBe(200);
    expect(r.body.savedCases).toBe(1);
    expect(Array.isArray(r.body.warnings)).toBe(true);
    expect(String(r.body.warnings[0])).toContain('自然语言草稿');
    expect(String(r.body.warnings[0])).toContain('NL草稿用例');
    // 指令完整落库；字符串断言经 createCaseWithSteps 迁移成 canonical 形态
    // （{kind:'assertText', target:'page', locator:[]}——正是机械回放会跳过的整页模糊断言，advisory warning 的动机）
    const row = (await pool.query(
      `SELECT c.title, s.instruction, s.assertion FROM test_cases c JOIN test_steps s ON s.case_id = c.id`,
    )).rows[0]!;
    expect(row.title).toBe('NL草稿用例');
    expect(row.instruction).toBe('输入用户名并点击登录');
    expect(row.assertion).toMatchObject({ kind: 'assertText', equals: '页面提示登录成功', locator: [] });
    const stageRows = await pool.query(`SELECT count(*)::int n FROM ai_stage_cases WHERE local_id = $1`, [localId]);
    expect(stageRows.rows[0]!.n).toBe(0);
  });

  it('已编译步骤（有 compiled）→ 保存成功且无 warnings', async () => {
    const { threadId, localId, groupId } = await seedDraft([
      {
        action: '点击删除',
        compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }],
        assertion: null,
      },
    ]);
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ cases: [{ localId, groupId }] });
    expect(r.status).toBe(200);
    expect(r.body.savedCases).toBe(1);
    expect(r.body.warnings).toBeUndefined();
  });
});
