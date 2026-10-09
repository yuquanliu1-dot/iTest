import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL } from './helpers/db.js';

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
