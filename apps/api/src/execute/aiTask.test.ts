import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt, referencesCredential, buildDegradeContext, classifyDegradeStep, brittleSelectorReason, originOf, scopeViolationReason } from './aiTask.js';

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

  it('base 覆盖 → 换基底但保留凭据段拼装（探索式会话路径）', () => {
    const p = assembleSystemPrompt({
      credEnabled: true,
      manifest: '- web（默认） https://x 已配置凭据',
      base: '你是探索型测试员。',
    });
    expect(p.startsWith('你是探索型测试员。')).toBe(true);
    expect(p).not.toContain('指令忠实');
    expect(p).toContain('ITEST_');
    expect(p).toContain('@服务名');
  });

  it('base 覆盖 + credEnabled=false → 纯基底无凭据段', () => {
    const p = assembleSystemPrompt({ credEnabled: false, manifest: '', base: '你是探索型测试员。' });
    expect(p).toBe('你是探索型测试员。');
  });

  it('不传 base → 行为不变（执行提示词）', () => {
    const p = assembleSystemPrompt({ credEnabled: false, manifest: '' });
    expect(p).toContain('指令忠实');
  });

  it('数据忠实守则恒在（负向用例不被 AI 改写表单值）', () => {
    const p = assembleSystemPrompt({ credEnabled: false, manifest: '' });
    expect(p).toContain('数据忠实');
  });

  it('零动作完成守则：确认式步骤目标已达成即可 done（RC1 登录用例空转修复）', () => {
    const p = assembleSystemPrompt({ credEnabled: false, manifest: '' });
    expect(p).toContain('目标已达成即完成');
    expect(p).toContain('零动作');
    // 完成判据规则对零动作完成显式豁免——否则模型不敢零动作 done，空转到轮数耗尽
    expect(/完成判据要执行证据[\s\S]*?零动作完成（上一条）/.test(p)).toBe(true);
    // mobile 提示词同步（移动端确认式步骤同样存在）
    const m = assembleSystemPrompt({ mobile: true, credEnabled: true, manifest: '' });
    expect(m).toContain('目标已达成即完成');
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

describe('brittleSelectorReason - 脆弱 selector 硬闸（借 srbarrios 口径）', () => {
  it('普通 CSS / text= / 属性 / id 子选择器放行', () => {
    for (const s of ['#app', '.btn', "[data-test='x']", 'text=登录', 'button.primary', '#save > i', 'input[name="username"]']) {
      expect(brittleSelectorReason(s), s).toBeNull();
    }
  });

  it('XPath（绝对路径与 //）拒绝', () => {
    expect(brittleSelectorReason('/html/body/div[2]')).toContain('XPath');
    expect(brittleSelectorReason('//div[@class="x"]')).toContain('XPath');
    expect(brittleSelectorReason('.//span')).toContain('XPath');
  });

  it(':nth-child / :nth-of-type 位置选择拒绝', () => {
    expect(brittleSelectorReason('ul > li:nth-child(2)')).toContain('nth-child');
    expect(brittleSelectorReason('span:nth-of-type(3)')).toContain('nth-of-type');
  });

  it('裸标签位置链拒绝（> div/span/li/… 后接组合器）', () => {
    expect(brittleSelectorReason('body > div > span')).toContain('位置链');
    expect(brittleSelectorReason('ul > li > a')).toContain('位置链');
  });

  it(':has-text（提示词禁令的运行时 enforcement）拒绝', () => {
    expect(brittleSelectorReason('button:has-text("保存")')).toContain('has-text');
  });
});

describe('scopeViolationReason / originOf - 探索范围闸（2026-11-10 prod 越界写数据实证）', () => {
  it('originOf 归一化：端口/路径/大小写差异同 origin；非 http(s) 与非 URL → null', () => {
    expect(originOf('http://127.0.0.1:56100/defect.html')).toBe('http://127.0.0.1:56100');
    expect(originOf('https://SUT.example.com/app?x=1')).toBe('https://sut.example.com');
    expect(originOf('javascript:alert(1)')).toBeNull();
    expect(originOf('not a url')).toBeNull();
  });

  it('同 origin 放行；跨 origin 拒收且原因点名目标与被允许范围', () => {
    const allow = ['http://127.0.0.1:56100'];
    expect(scopeViolationReason('http://127.0.0.1:56100/other.html', allow)).toBeNull();
    expect(scopeViolationReason('http://127.0.0.1:56100', allow)).toBeNull();
    const r = scopeViolationReason('https://192.168.30.123:1688/login', allow);
    expect(r).toContain('越界');
    expect(r).toContain('https://192.168.30.123:1688');
    expect(r).toContain('http://127.0.0.1:56100');
  });

  it('端口不同即跨 origin（56100 vs 56101 不放行）；多 origin 白名单任一命中即放行', () => {
    const allow = ['http://127.0.0.1:56100', 'https://sso.example.com'];
    expect(scopeViolationReason('http://127.0.0.1:56101/defect.html', allow)).not.toBeNull();
    expect(scopeViolationReason('https://sso.example.com/login', allow)).toBeNull();
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
