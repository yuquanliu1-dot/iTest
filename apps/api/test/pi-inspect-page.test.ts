import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// mock playwright-core：假 browser/context/page。evaluate 的返回值与 launch 错误可注入。
const mocks = vi.hoisted(() => {
  const state: { evalValue: unknown; launchError: Error | null; gotoUrls: string[] } = {
    evalValue: null,
    launchError: null,
    gotoUrls: [],
  };
  return { state };
});
vi.mock('playwright-core', () => ({
  chromium: {
    launch: async () => {
      if (mocks.state.launchError) throw mocks.state.launchError;
      return {
        newContext: async () => ({
          newPage: async () => ({
            goto: async (url: string) => { mocks.state.gotoUrls.push(url); },
            waitForTimeout: async () => {},
            evaluate: async () => mocks.state.evalValue,
          }),
        }),
        close: async () => {},
      };
    },
  },
}));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let requirementId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_scenarios, ai_cases, ai_threads RESTART IDENTITY CASCADE`);
  const { projectId } = await seedProject(pool);
  const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
  requirementId = r.rows[0]!.id as string;
  mocks.state.evalValue = null;
  mocks.state.launchError = null;
  mocks.state.gotoUrls = [];
});

describe('inspectPage', () => {
  it('拒绝非 http/https 协议与非法 URL（不启动浏览器）', async () => {
    const { inspectPage } = await import('../src/pi/inspectPage.js');
    await expect(inspectPage('ftp://example.com/x')).rejects.toThrow(/仅支持 http\/https/);
    await expect(inspectPage('not a url')).rejects.toThrow(/无法解析/);
    expect(mocks.state.gotoUrls).toEqual([]);
  });

  it('返回页面标题与元素清单文本', async () => {
    const { inspectPage } = await import('../src/pi/inspectPage.js');
    mocks.state.evalValue = {
      title: '元素管理',
      elements: ['- button#add "添加元素" 选择器: #add', '- input[placeholder="搜索元素..."] 选择器: text=搜索元素...'],
      truncated: false,
    };
    const out = await inspectPage('http://192.168.30.228:8088/static/element-manager.html');
    expect(mocks.state.gotoUrls).toEqual(['http://192.168.30.228:8088/static/element-manager.html']);
    expect(out).toContain('标题: 元素管理');
    expect(out).toContain('button#add "添加元素"');
    expect(out).toContain('可交互元素 (2)');
    // 快照范围说明必须存在：告知 LLM 快照仅为初始状态、清单外禁止编造 testid
    expect(out).toContain('仅为页面初始状态');
    expect(out).toContain('禁止编造');
  });
});

describe('inspect_page 工具（executor）', () => {
  it('成功：返回元素清单 data，并记录 pageContext 到暂存文档', async () => {
    mocks.state.evalValue = { title: 'T', elements: ['- button "保存" 选择器: text=保存'], truncated: false };
    const { buildWorkspaceTools } = await import('../src/pi/tools.js');
    const tool = buildWorkspaceTools(requirementId).find((t) => t.name === 'inspect_page')!;
    const r = await tool.execute({ url: 'http://intranet.example/page' });
    expect(r).toEqual({ ok: true, data: expect.stringContaining('button "保存"') });
    const { loadDoc } = await import('../src/pi/workspace.js');
    const doc = await loadDoc(requirementId);
    expect(doc.pageContext?.url).toBe('http://intranet.example/page');
    expect(doc.pageContext?.fetchedAt).toBeTruthy();
  });

  it('失败：launch 报错时返回 ok:false，不记录 pageContext', async () => {
    mocks.state.launchError = new Error('Executable doesn\'t exist');
    const { buildWorkspaceTools } = await import('../src/pi/tools.js');
    const tool = buildWorkspaceTools(requirementId).find((t) => t.name === 'inspect_page')!;
    const r = await tool.execute({ url: 'http://intranet.example/page' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('页面抓取失败');
    const { loadDoc } = await import('../src/pi/workspace.js');
    const doc = await loadDoc(requirementId);
    expect(doc.pageContext).toBeNull();
  });
});

describe('ai_workspace_state doc merge', () => {
  it('announcePlan 不覆盖已记录的 pageContext', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.recordPageInspection(requirementId, 'http://a.example/');
    await ws.announcePlan(requirementId, { scenarios: 2, cases: 10 });
    const doc = await ws.loadDoc(requirementId);
    expect(doc.plan).toEqual({ scenarios: 2, cases: 10 });
    expect(doc.pageContext?.url).toBe('http://a.example/');
  });
});
