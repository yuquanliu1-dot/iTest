import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt, referencesCredential, buildDegradeContext, classifyDegradeStep } from './aiTask.js';

describe('assembleSystemPrompt - 凭据段门控', () => {
  it('credEnabled=false → 提示词不含任何凭据形态', () => {
    const p = assembleSystemPrompt({ credEnabled: false, manifest: '' });
    expect(p).not.toContain('ITEST_');
    expect(p).not.toContain('凭据');
  });

  it('credEnabled=false + 有 manifest → 清单也不出现', () => {
    const p = assembleSystemPrompt({
      credEnabled: false,
      manifest: '- web（默认） https://x 已配置凭据',
    });
    expect(p).not.toContain('ITEST_');
    expect(p).not.toContain('已配置凭据');
  });

  it('credEnabled=true + 有 manifest → 含清单与 @服务名 占位符形态', () => {
    const p = assembleSystemPrompt({
      credEnabled: true,
      manifest: '- web（默认） https://x 已配置凭据',
    });
    expect(p).toContain('ITEST_');
    expect(p).toContain('@服务名');
    expect(p).toContain('已配置凭据');
  });

  it('credEnabled=true 无 manifest → 含裸占位符文案', () => {
    const p = assembleSystemPrompt({ credEnabled: true, manifest: '' });
    expect(p).toContain('__ITEST_USERNAME__');
    expect(p).toContain('__ITEST_PASSWORD__');
  });

  it('mobile=true → 恒无凭据段', () => {
    const p = assembleSystemPrompt({ mobile: true, credEnabled: true, manifest: '- web 已配置凭据' });
    expect(p).not.toContain('ITEST_');
    expect(p).not.toContain('凭据');
  });

  it('数据忠实守则恒在（负向用例不被 AI 改写表单值）', () => {
    const p = assembleSystemPrompt({ credEnabled: false, manifest: '' });
    expect(p).toContain('数据忠实');
  });
});

describe('referencesCredential - 占位符形态识别', () => {
  it('识别哨兵形态', () => {
    expect(referencesCredential('填入 __ITEST_USERNAME__')).toBe(true);
    expect(referencesCredential('填入 __ITEST_PASSWORD__')).toBe(true);
    expect(referencesCredential('填入 __ITEST_STEP_SECRET__')).toBe(true);
  });

  it('识别带 @ref 形态', () => {
    expect(referencesCredential('填入 __ITEST_USERNAME@web__')).toBe(true);
    expect(referencesCredential('填入 __ITEST_PASSWORD@backend__')).toBe(true);
  });

  it('识别花括号 / 裸名形态', () => {
    expect(referencesCredential('填入 {{ITEST_PASSWORD}}')).toBe(true);
    expect(referencesCredential('填入 ITEST_USERNAME')).toBe(true);
  });

  it('普通文本不误判', () => {
    expect(referencesCredential('在账号框填入管理员账号')).toBe(false);
    expect(referencesCredential('识别验证码图片中的字符并填入验证码输入框')).toBe(false);
  });
});

describe('buildDegradeContext - 降级时把机械意图喂给 AI', () => {
  it('机械语义：waitFor 文本定位渲染成可读描述', () => {
    const ctx = buildDegradeContext({
      compiled: [{ kind: 'waitFor', locator: [{ strategy: 'text', value: '验证码不正确' }], timeoutMs: 10000 }],
      mechanicalError: 'count=0 (text)',
    });
    expect(ctx).toContain('本步机械语义');
    expect(ctx).toContain('等待 text=验证码不正确 出现');
    expect(ctx).toContain('10000ms');
  });

  it('机械执行结果原样带上（AI 知道「已经失败」而非「还没试」）', () => {
    const ctx = buildDegradeContext({
      compiled: [{ kind: 'waitFor', locator: [{ strategy: 'text', value: 'x' }], timeoutMs: 10000 }],
      mechanicalError: 'count=0 (text)',
    });
    expect(ctx).toContain('机械执行结果');
    expect(ctx).toContain('count=0 (text)');
  });

  it('观察不制造守则恒在（不得为诱发现象而填值/重复提交）', () => {
    const ctx = buildDegradeContext({
      compiled: [{ kind: 'waitFor', locator: [{ strategy: 'text', value: 'x' }], timeoutMs: 1000 }],
      mechanicalError: 'count=0 (text)',
    });
    expect(ctx).toContain('不得填入任何值');
    expect(ctx).toContain('不得重复提交');
    expect(ctx).toContain('如实报失败');
  });

  it('断言失败（不在 compiled 里）也补一条语义', () => {
    const ctx = buildDegradeContext({
      compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '.login-btn' }] }],
      failedAction: { kind: 'assertVisible', locator: [{ strategy: 'css', value: 'input[name="username"]' }] },
      mechanicalError: 'assertVisible failed: input[name="username"]',
    });
    expect(ctx).toContain('点击 css=.login-btn');
    expect(ctx).toContain('断言 css=input[name="username"] 可见');
    expect(ctx).toContain('实际失败于这条');
  });

  it('纯自然语言步（无机械动作）也带守则，且不谎称有机械结果', () => {
    const ctx = buildDegradeContext({ compiled: null });
    expect(ctx).toContain('纯自然语言步骤');
    expect(ctx).toContain('不得重复提交');
    expect(ctx).not.toContain('失败：');
  });
});

describe('classifyDegradeStep - 按机械语义分类', () => {
  it('waitFor / assert* / screenshot → observe', () => {
    expect(classifyDegradeStep({ compiled: [{ kind: 'waitFor', locator: [], timeoutMs: 1000 }] })).toBe('observe');
    expect(classifyDegradeStep({ compiled: [{ kind: 'assertVisible', locator: [] }] })).toBe('observe');
    expect(classifyDegradeStep({ compiled: [{ kind: 'assertText', locator: [] }] })).toBe('observe');
    expect(classifyDegradeStep({ compiled: [{ kind: 'screenshot', locator: [] }] })).toBe('observe');
  });

  it('click / fill → interact', () => {
    expect(classifyDegradeStep({ compiled: [{ kind: 'click', locator: [] }] })).toBe('interact');
    expect(classifyDegradeStep({ compiled: [{ kind: 'fill', locator: [] }] })).toBe('interact');
  });

  it('断言（failedAction）也算进分类——断言步是 observe', () => {
    expect(classifyDegradeStep({
      compiled: [{ kind: 'click', locator: [] }],
      failedAction: { kind: 'assertVisible', locator: [] },
    })).toBe('interact');
    expect(classifyDegradeStep({
      compiled: null,
      failedAction: { kind: 'assertVisible', locator: [] },
    })).toBe('observe');
  });

  it('无机械动作 → unknown', () => {
    expect(classifyDegradeStep({ compiled: null })).toBe('unknown');
    expect(classifyDegradeStep({ compiled: [] })).toBe('unknown');
  });
});

describe('buildDegradeContext - 按步类型给不同守则', () => {
  it('observe 步：严格限制（禁填值/禁点击业务按钮/禁重复提交）', () => {
    const ctx = buildDegradeContext({
      compiled: [{ kind: 'waitFor', locator: [{ strategy: 'text', value: '验证码不正确' }], timeoutMs: 10000 }],
      mechanicalError: 'count=0 (text)',
    });
    expect(ctx).toContain('本步是观察步');
    expect(ctx).toContain('不得填入任何值');
    expect(ctx).toContain('不得重复提交');
    expect(ctx).toContain('造出来的现象不构成证据');
  });

  it('interact 步：有限授权（可动手，但禁改已填值/禁重复刚失败的动作）', () => {
    const ctx = buildDegradeContext({
      compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '.login-btn' }] }],
      mechanicalError: 'count=0 (css .login-btn)',
    });
    expect(ctx).toContain('本步是交互步');
    expect(ctx).toContain('不得改写');
    expect(ctx).toContain('不得重复执行刚刚失败的那次交互');
  });

  it('unknown 步（纯自然语言）：按观察口径严格约束', () => {
    const ctx = buildDegradeContext({ compiled: null });
    expect(ctx).toContain('本步是观察步');
    expect(ctx).toContain('不得填入任何值');
    expect(ctx).toContain('不得重复提交');
  });
});
