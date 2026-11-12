import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL } from './helpers/db.js';

// mock playwright-core: fake browser/context/page. evaluate's return value and the launch error are injectable.
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

let pool: Pool;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
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
      bodyLen: 520,
      overflow: false,
      candidates: [
        { tag: 'button', type: '', id: 'add', name: '', role: '', text: '添加元素', placeholder: '', aria: '', titleAttr: '', testid: '', editable: false, selector: '#add' },
        { tag: 'input', type: 'text', id: '', name: 'kw', role: '', text: '', placeholder: '搜索元素...', aria: '', titleAttr: '', testid: '', editable: false, selector: 'text=搜索元素...' },
      ],
    };
    const out = await inspectPage('http://192.168.30.228:8088/static/element-manager.html');
    expect(mocks.state.gotoUrls).toEqual(['http://192.168.30.228:8088/static/element-manager.html']);
    expect(out).toContain('标题: 元素管理');
    expect(out).toContain('button#add "添加元素"');
    expect(out).toContain('可交互元素 (2)');
    // Capture-quality self-assessment: too few elements (<5) is judged low quality even with a sufficient body
    expect(out).toContain('抓取质量: 低(可交互元素 2 个,正文 520 字符)');
    expect(out).toContain('请勿基于此清单编造用例');
    // Snapshot-scope note must be present: tells the LLM the snapshot is only the initial state and fabricating testids outside the list is forbidden
    expect(out).toContain('仅为页面初始状态');
    expect(out).toContain('禁止编造');
  });

  it('元素充足且正文足够时抓取质量判正常', async () => {
    const { inspectPage } = await import('../src/pi/inspectPage.js');
    mocks.state.evalValue = {
      title: '元素管理',
      bodyLen: 520,
      overflow: false,
      candidates: [1, 2, 3, 4, 5, 6].map((i) => ({
        tag: 'a', type: '', id: String(i), name: '', role: '', text: `链接${i}`, placeholder: '', aria: '', titleAttr: '', testid: '', editable: false, selector: `#${i}`,
      })),
    };
    const out = await inspectPage('http://192.168.30.228:8088/static/element-manager.html');
    expect(out).toContain('抓取质量: 正常(可交互元素 6 个,正文 520 字符;清单已去重降噪,保留 6 条)');
  });

  it('正文过短(<100 字符)时即使元素多也判低质量(空壳/404 特征)', async () => {
    const { assessPageQuality } = await import('../src/pi/inspectPage.js');
    expect(assessPageQuality({ title: 'mainApp', bodyLen: 6, elements: ['- a', '- b', '- c', '- d', '- e'] })).toBe('low');
    expect(assessPageQuality({ title: '404', bodyLen: 0, elements: [] })).toBe('low');
    expect(assessPageQuality({ title: 'x', bodyLen: 100, elements: ['- a', '- b', '- c', '- d', '- e'] })).toBe('ok');
    // A very short list after dedupe/cap but with plenty of real candidates is not a hollow shell (candidateCount fallback)
    expect(assessPageQuality({ title: 'x', bodyLen: 200, elements: [], candidateCount: 8 })).toBe('ok');
  });
});
