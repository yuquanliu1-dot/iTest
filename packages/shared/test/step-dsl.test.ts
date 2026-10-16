import { describe, it, expect } from 'vitest';
import { StepAction, Locator, LocatorStrategy, NavigateAction } from '../src/step-dsl.js';

describe('step-dsl', () => {
  it('accepts valid click action', () => {
    const r = StepAction.safeParse({
      kind: 'click',
      locator: [{ strategy: 'role', value: 'button[name="Submit"]' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects click action with empty locator array', () => {
    const r = StepAction.safeParse({ kind: 'click', locator: [] });
    expect(r.success).toBe(false);
  });

  it('accepts valid fill action', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'testId', value: 'email' }],
      value: 'a@b.com',
    });
    expect(r.success).toBe(true);
  });

  it('rejects fill action without value', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'testId', value: 'email' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects navigate with non-URL string', () => {
    const r = StepAction.safeParse({ kind: 'navigate', url: 'not-a-url' });
    expect(r.success).toBe(false);
  });

  it('accepts locator with all strategies', () => {
    for (const s of ['role', 'text', 'testId', 'css', 'xpath'] as const) {
      const r = Locator.safeParse({ strategy: s, value: 'foo' });
      expect(r.success).toBe(true);
    }
  });

  it('rejects locator with unknown strategy', () => {
    const r = Locator.safeParse({ strategy: 'bogus', value: 'foo' });
    expect(r.success).toBe(false);
  });
});

describe('step-dsl — phase1 new kinds', () => {
  it('accepts check action', () => {
    const r = StepAction.safeParse({
      kind: 'check',
      locator: [{ strategy: 'role', value: 'checkbox[name="同意"]' }],
      checked: true,
    });
    expect(r.success).toBe(true);
  });

  it('accepts select action', () => {
    const r = StepAction.safeParse({
      kind: 'select',
      locator: [{ strategy: 'css', value: 'select' }],
      value: 'cn',
    });
    expect(r.success).toBe(true);
  });

  it('accepts upload action with fileId', () => {
    const r = StepAction.safeParse({
      kind: 'upload',
      locator: [{ strategy: 'css', value: 'input[type=file]' }],
      fileId: 'att-1',
    });
    expect(r.success).toBe(true);
  });

  it('accepts assertJson action', () => {
    const r = StepAction.safeParse({
      kind: 'assertJson',
      locator: [{ strategy: 'css', value: 'pre' }],
      equals: { code: 0 },
    });
    expect(r.success).toBe(true);
  });

  it('accepts extract action', () => {
    const r = StepAction.safeParse({
      kind: 'extract',
      locator: [{ strategy: 'css', value: '.order-no' }],
      varName: 'orderNo',
    });
    expect(r.success).toBe(true);
  });

  it('accepts aiStep with compiled steps', () => {
    const r = StepAction.safeParse({
      kind: 'aiStep',
      instruction: '关闭弹窗',
      compiled: [{ kind: 'assertVisible', locator: [{ strategy: 'role', value: 'main' }] }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts aiStep with compiled = null', () => {
    const r = StepAction.safeParse({ kind: 'aiStep', instruction: 'x', compiled: null });
    expect(r.success).toBe(true);
  });

  it('rejects extract without varName', () => {
    const r = StepAction.safeParse({
      kind: 'extract',
      locator: [{ strategy: 'css', value: '.x' }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts fill with generator value', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: { mode: 'prefixTimestamp', prefix: '测试-' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects fill with unknown generator mode', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: { mode: 'uuid' },
    });
    expect(r.success).toBe(false);
  });

  it('accepts aiStep nested inside aiStep compiled (recursion)', () => {
    const r = StepAction.safeParse({
      kind: 'aiStep',
      instruction: '外层',
      compiled: [{ kind: 'aiStep', instruction: '内层', compiled: null }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts aiStep with optional assertion string', () => {
    const r = StepAction.safeParse({
      kind: 'aiStep',
      instruction: '提交订单',
      compiled: null,
      assertion: '页面显示订单提交成功',
    });
    expect(r.success).toBe(true);
  });

  it('accepts aiStep with assertion = null', () => {
    const r = StepAction.safeParse({
      kind: 'aiStep',
      instruction: '提交订单',
      compiled: null,
      assertion: null,
    });
    expect(r.success).toBe(true);
  });

  it('accepts aiStep without assertion field (backward compat)', () => {
    const r = StepAction.safeParse({
      kind: 'aiStep',
      instruction: '提交订单',
      compiled: null,
    });
    expect(r.success).toBe(true);
  });

  it('rejects aiStep with non-string assertion', () => {
    const r = StepAction.safeParse({
      kind: 'aiStep',
      instruction: '提交订单',
      compiled: null,
      assertion: 123,
    });
    expect(r.success).toBe(false);
  });

  it('generator defaults materialize on parse', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#x' }],
      value: { mode: 'randomString' },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === 'fill') {
      const v = r.data.value as { mode: string; length: number };
      expect(v.length).toBe(12);
    }
  });

  it('rejects randomNumber with inverted range', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#x' }],
      value: { mode: 'randomNumber', min: 5, max: 2 },
    });
    expect(r.success).toBe(false);
  });
});

describe('step-dsl — phase2 new kinds', () => {
  it('accepts switchTab action', () => {
    const r = StepAction.safeParse({
      kind: 'switchTab',
      tabRef: 'session-abc|tab#1',
    });
    expect(r.success).toBe(true);
  });

  it('accepts upload action with required fileId', () => {
    const ok = StepAction.safeParse({
      kind: 'upload',
      locator: [{ strategy: 'css', value: 'input[type=file]' }],
      fileId: 'att-1',
    });
    expect(ok.success).toBe(true);
    const noFile = StepAction.safeParse({
      kind: 'upload',
      locator: [{ strategy: 'css', value: 'input[type=file]' }],
    });
    expect(noFile.success).toBe(false);
  });

  it('accepts fill action with sensitive flag', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: 'input[type=password]' }],
      value: 'placeholder-not-stored',
      sensitive: true,
    });
    expect(r.success).toBe(true);
  });

  it('accepts fill without sensitive flag (existing behavior)', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: 'alice',
    });
    expect(r.success).toBe(true);
  });
});

describe('step-dsl — phase3 intent locator', () => {
  it('accepts click action with optional intentLocator', () => {
    const r = StepAction.safeParse({
      kind: 'click',
      locator: [{ strategy: 'css', value: '#btn' }],
      intentLocator: { semanticRole: 'loginSubmit', contextText: '登录' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts click action without intentLocator (back-compat)', () => {
    const r = StepAction.safeParse({
      kind: 'click',
      locator: [{ strategy: 'css', value: '#btn' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects intentLocator with empty semanticRole', () => {
    const r = StepAction.safeParse({
      kind: 'click',
      locator: [{ strategy: 'css', value: '#btn' }],
      intentLocator: { semanticRole: '' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects intentLocator with oversize contextText', () => {
    const r = StepAction.safeParse({
      kind: 'click',
      locator: [{ strategy: 'css', value: '#btn' }],
      intentLocator: { semanticRole: 'loginSubmit', contextText: 'x'.repeat(501) },
    });
    expect(r.success).toBe(false);
  });
});

describe('step-dsl — phase3 assertText target/match', () => {
  it('accepts assertText with default target/match', () => {
    const r = StepAction.safeParse({
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      equals: 'ok',
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === 'assertText') {
      expect(r.data.target).toBe('specifiedElement');
      expect(r.data.match).toBe('equals');
    }
  });

  it('accepts assertText with explicit page target + regex match', () => {
    const r = StepAction.safeParse({
      kind: 'assertText',
      locator: [],
      target: 'page',
      match: 'regex',
      equals: '^登录成功',
    });
    expect(r.success).toBe(true);
  });

  it('accepts assertText with intentLocator', () => {
    const r = StepAction.safeParse({
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      target: 'specifiedElement',
      match: 'contains',
      equals: '成功',
      intentLocator: { semanticRole: 'successMsg' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects assertText with unknown target', () => {
    const r = StepAction.safeParse({
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      target: 'body',
      equals: 'x',
    });
    expect(r.success).toBe(false);
  });
});

describe('step-dsl — phase3 composite value', () => {
  it('accepts fill with composite value of multiple fragments', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: {
        mode: 'composite',
        fragments: [
          { mode: 'fixed', value: 'CS' },
          { mode: 'date', format: 'YYYYMMDD' },
          { mode: 'randomNumber', length: 3 },
        ],
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects composite with empty fragments array', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: { mode: 'composite', fragments: [] },
    });
    expect(r.success).toBe(false);
  });

  it('rejects composite when total max length exceeds 1024', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: {
        mode: 'composite',
        fragments: [
          { mode: 'fixed', value: 'x'.repeat(500) },
          { mode: 'randomString', length: 1024 },
        ],
      },
    });
    expect(r.success).toBe(false);
  });

  it('rejects composite fragment with unknown mode', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: { mode: 'composite', fragments: [{ mode: 'uuid' }] },
    });
    expect(r.success).toBe(false);
  });
});

describe('step-dsl — mobile extensions (2026-10-07)', () => {
  it('accepts tap action with accessibilityId', () => {
    const r = StepAction.safeParse({
      kind: 'tap',
      locator: [{ strategy: 'accessibilityId', value: 'login_button' }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts swipe action', () => {
    const r = StepAction.safeParse({
      kind: 'swipe',
      from: [{ strategy: 'accessibilityId', value: 'list_top' }],
      to: [{ strategy: 'accessibilityId', value: 'list_bottom' }],
      durationMs: 500,
    });
    expect(r.success).toBe(true);
  });

  it('accepts swipe without durationMs (uses default)', () => {
    const r = StepAction.safeParse({
      kind: 'swipe',
      from: [{ strategy: 'accessibilityId', value: 'a' }],
      to: [{ strategy: 'accessibilityId', value: 'b' }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts setNetwork airplane', () => {
    const r = StepAction.safeParse({ kind: 'setNetwork', state: 'airplane' });
    expect(r.success).toBe(true);
  });

  it('rejects setLocation out of latitude range', () => {
    const r = StepAction.safeParse({ kind: 'setLocation', latitude: 95, longitude: 0 });
    expect(r.success).toBe(false);
  });

  it('parses accessibilityId locator strategy', () => {
    const r = LocatorStrategy.safeParse('accessibilityId');
    expect(r.success).toBe(true);
  });
});

describe('NavigateAction.url 相对/变量形态', () => {
  it('绝对 URL 合法', () => {
    expect(NavigateAction.safeParse({ kind: 'navigate', url: 'https://a.com/x?y=1#z' }).success).toBe(true);
  });
  it('以 / 开头的相对 URL 合法(含 query/hash)', () => {
    expect(NavigateAction.safeParse({ kind: 'navigate', url: '/admin/user?tab=1#sec' }).success).toBe(true);
  });
  it('{{变量}} 打头合法(替换后由运行时判断)', () => {
    expect(NavigateAction.safeParse({ kind: 'navigate', url: '{{web_backend}}/api/x' }).success).toBe(true);
  });
  it('裸文本与 ftp 非法', () => {
    expect(NavigateAction.safeParse({ kind: 'navigate', url: 'admin/user' }).success).toBe(false);
    expect(NavigateAction.safeParse({ kind: 'navigate', url: 'ftp://a.com/x' }).success).toBe(false);
    expect(NavigateAction.safeParse({ kind: 'navigate', url: '' }).success).toBe(false);
  });
});