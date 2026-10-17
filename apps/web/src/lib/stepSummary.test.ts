// apps/web/src/lib/stepSummary.test.ts
import { describe, it, expect } from 'vitest';
import type { Locator } from '@itest/shared';
import type { TFunction } from 'i18next';
import { stepSummary, fullStepDescription, getKind, isUncompiled, type StepRowLike } from './stepSummary';
import zhCases from '../i18n/locales/zh-CN/cases.json';

/** 测试桩 t：按 key 在 zh cases.json 里解析文案并做 {{}} 插值，使断言仍是真实 zh 输出。 */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

const t = ((key: string, opts?: Record<string, unknown>): string => {
  const m = key.match(/^([^:]+):(.+)$/);
  const ns = m?.[1];
  const path = m?.[2] ?? key;
  let v: unknown = ns === 'cases' ? resolvePath(zhCases as unknown as Record<string, unknown>, path) : undefined;
  if (typeof v !== 'string') v = key;
  let out = v as string;
  if (opts) {
    for (const [k, val] of Object.entries(opts)) {
      out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(val));
    }
  }
  return out;
}) as unknown as TFunction;

const loc = (strategy: Locator['strategy'] = 'css', value = '#btn'): Locator[] => [{ strategy, value }];

describe('stepSummary', () => {
  it('navigate 显示 URL', () => {
    expect(stepSummary({ compiled: [{ kind: 'navigate', url: 'https://example.com' }] }, t)).toBe('打开 https://example.com');
  });

  it('click 优先用 intentLocator.contextText', () => {
    expect(stepSummary({ compiled: [{ kind: 'click', locator: loc(), intentLocator: { semanticRole: 'button', contextText: '登录' } }] }, t)).toBe('点击 登录');
  });

  it('click 无 intent 时用首个 locator', () => {
    expect(stepSummary({ compiled: [{ kind: 'click', locator: loc('role', 'button') }] }, t)).toBe('点击 role=button');
  });

  it('fill 固定值', () => {
    expect(stepSummary({ compiled: [{ kind: 'fill', locator: loc(), value: 'alice' }] }, t)).toBe('输入 alice');
  });

  it('fill sensitive 脱敏', () => {
    expect(stepSummary({ compiled: [{ kind: 'fill', locator: loc(), value: '__sensitive__', sensitive: true }] }, t)).toBe('输入 ***');
  });

  it('fill 生成器值显示模式名', () => {
    expect(stepSummary({ compiled: [{ kind: 'fill', locator: loc(), value: { mode: 'randomString', length: 8 } }] }, t)).toBe('输入 (随机字符串)');
  });

  it('select 显示值', () => {
    expect(stepSummary({ compiled: [{ kind: 'select', locator: loc(), value: 'SH' }] }, t)).toBe('选择 SH');
  });

  it('check / hover / waitFor / assertVisible', () => {
    expect(stepSummary({ compiled: [{ kind: 'check', locator: loc(), checked: true }] }, t)).toBe('勾选');
    expect(stepSummary({ compiled: [{ kind: 'check', locator: loc(), checked: false }] }, t)).toBe('取消勾选');
    expect(stepSummary({ compiled: [{ kind: 'hover', locator: loc() }] }, t)).toBe('悬停 css=#btn');
    expect(stepSummary({ compiled: [{ kind: 'waitFor', locator: loc() }] }, t)).toBe('等待元素 css=#btn');
    expect(stepSummary({ compiled: [{ kind: 'assertVisible', locator: loc() }] }, t)).toBe('断言可见 css=#btn');
  });

  it('waitFor 空定位 = 固定时长等待（默认 5000）', () => {
    expect(stepSummary({ compiled: [{ kind: 'waitFor', locator: [], timeoutMs: 3000 }] }, t)).toBe('固定等待 3000 ms');
    expect(stepSummary({ compiled: [{ kind: 'waitFor', locator: [] }] }, t)).toBe('固定等待 5000 ms');
  });

  it('assertText 按 match 生成', () => {
    expect(stepSummary({ compiled: [{ kind: 'assertText', locator: [], target: 'page', match: 'contains', equals: '登录成功' }] }, t)).toBe('断言文本 包含「登录成功」');
  });

  it('screenshot / upload / switchTab / assertJson', () => {
    expect(stepSummary({ compiled: [{ kind: 'screenshot', name: 'shot1' }] }, t)).toBe('截图 shot1');
    expect(stepSummary({ compiled: [{ kind: 'upload', locator: loc(), fileId: 'u-1' }] }, t)).toBe('上传文件');
    expect(stepSummary({ compiled: [{ kind: 'switchTab', tabRef: 't1' }] }, t)).toBe('切换标签页 t1');
    expect(stepSummary({ compiled: [{ kind: 'assertJson', locator: loc(), equals: { a: 1 } }] }, t)).toBe('断言 JSON');
  });

  it('extract 显示变量名', () => {
    expect(stepSummary({ compiled: [{ kind: 'extract', locator: loc(), varName: 'orderId', mode: 'completeValue' }] }, t)).toBe('提取 → {{orderId}}');
  });

  it('httpRequest 显示方法+URL，saveAs 加提取箭头', () => {
    expect(stepSummary({ compiled: [{ kind: 'httpRequest', method: 'GET', url: '{{apiBase}}/users', headers: [], timeoutMs: 10000 }] }, t)).toBe('GET {{apiBase}}/users');
    expect(stepSummary({ compiled: [{ kind: 'httpRequest', method: 'POST', url: '/api/orders', headers: [], timeoutMs: 10000, saveAs: { varName: 'orderId', from: 'body', path: 'data.id' } }] }, t)).toBe('POST /api/orders → {{orderId}}');
  });

  it('未知类型回退 JSON 片段（超长截断）', () => {
    const row = { compiled: [{ kind: 'weird', foo: 'x'.repeat(60) }] };
    expect(stepSummary(row, t)).toBe(JSON.stringify(row.compiled![0]).slice(0, 39) + '…');
  });

  it('nullish 输入回退 JSON 字串化（default 分支）', () => {
    // pickAction(nullish) → {} → default 分支返回 JSON.stringify({}) === "{}"
    //   与历史 `String(action)` 行为不同；新签名接受 row（含 instruction/compiled），
    //   nullish 是测试便利输入。这里断言「不抛错 + 返回纯字串」。
    expect(typeof stepSummary(undefined, t)).toBe('string');
    expect(typeof stepSummary(null, t)).toBe('string');
  });

  it('kind 取自 compiled[0]', () => {
    const row: StepRowLike = {
      instruction: '在用户名框输入 admin',
      compiled: [{ kind: 'fill', locator: loc(), value: 'admin' }],
    };
    expect(stepSummary(row, t)).toBe('输入 admin');
    expect(getKind(row)).toBe('fill');
  });

  it('compiled 为空数组时前缀「⚠ 未编译 · 」', () => {
    const row: StepRowLike = { instruction: '待编译', compiled: [] };
    expect(stepSummary(row, t)).toBe('⚠ 未编译 · {}');
    expect(isUncompiled(row)).toBe(true);
  });

  it('compiled=null/undefined 也视为未编译（action 列已 DROP，无 compiled 即无法回放）', () => {
    expect(isUncompiled({ compiled: null })).toBe(true);
    expect(isUncompiled({ compiled: undefined })).toBe(true);
    expect(isUncompiled({})).toBe(true);
    // 未编译前缀同样适用于 null/undefined
    expect(stepSummary({ compiled: null }, t)).toBe('⚠ 未编译 · {}');
  });

  it('fullStepDescription 含自然语言行', () => {
    const row: StepRowLike = {
      instruction: '点击登录',
      compiled: [{ kind: 'click', locator: loc('role', 'button') }],
    };
    const out = fullStepDescription(row, t);
    expect(out).toContain('自然语言：点击登录');
    expect(out).toContain('类型：click');
  });

  it('fullStepDescription 未编译时标注', () => {
    const row: StepRowLike = { instruction: '填邮箱', compiled: [] };
    expect(fullStepDescription(row, t)).toContain('未编译');
  });

  it('多动作行：stepSummary 枚举整条链（共 N 步）', () => {
    const row: StepRowLike = {
      instruction: '登录后点编辑',
      compiled: [
        { kind: 'fill', locator: loc('css', '#u'), value: 'admin' },
        { kind: 'click', locator: loc('css', '#btn') },
        { kind: 'assertVisible', locator: loc('css', '#modal') },
      ],
    };
    expect(stepSummary(row, t)).toBe('共 3 步：输入 admin → 点击 css=#btn → 断言可见 css=#modal');
  });

  it('多动作行：fullStepDescription 按【动作 i/N】分块枚举', () => {
    const row: StepRowLike = {
      instruction: '登录后点编辑',
      compiled: [
        { kind: 'fill', locator: loc('css', '#u'), value: 'admin' },
        { kind: 'click', locator: loc('css', '#btn') },
      ],
    };
    const out = fullStepDescription(row, t);
    expect(out).toContain('【动作 1/2】');
    expect(out).toContain('【动作 2/2】');
    expect(out).toContain('类型：fill');
    expect(out).toContain('类型：click');
    expect(out).toContain('自然语言：登录后点编辑');
  });

  it('单动作行输出与多动作路径无关（保持历史格式）', () => {
    const row: StepRowLike = {
      instruction: '点击登录',
      compiled: [{ kind: 'click', locator: loc('role', 'button') }],
    };
    expect(stepSummary(row, t)).toBe('点击 role=button');
    const out = fullStepDescription(row, t);
    expect(out).toContain('类型：click');
    expect(out).not.toContain('【动作');
  });
});