import { describe, it, expect, beforeEach, vi } from 'vitest';

// perform_login AI 化编排测试：resolveEnv / runAiTask / llmSettings / playwright 打桩。
vi.mock('../src/execute/envContext.js', () => ({ resolveEnv: vi.fn() }));
// 只打桩 runAiTask；占位符相关导出（credentialPlaceholder / makeCredentialValueSub 等）走真实实现——
// 凭据替换的口径必须与执行层一致，测试里另写一套就会漏掉 @ref 归属这类回归。
vi.mock('../src/execute/aiTask.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/execute/aiTask.js')>()),
  runAiTask: vi.fn(),
}));
vi.mock('../src/agent/llmSettings.js', () => ({
  resolveLlmClient: vi.fn(async () => ({
    config: { provider: 'anthropic', apiKey: 'fake', model: 'fake' },
    client: { provider: 'anthropic' as const, complete: async () => ({ kind: 'text' as const, value: '', provider: 'anthropic' as const, vision: false }) },
  })),
}));
vi.mock('playwright-core', () => ({
  chromium: {
    launch: vi.fn(async () => ({
      newContext: async () => ({
        newPage: async () => ({
          url: () => 'http://e/login',
          goto: async () => {},
          waitForLoadState: async () => {},
          waitForTimeout: async () => {},
          close: async () => {},
        }),
        storageState: async () => ({ cookies: [{ name: 'sid', value: 'abc' }], origins: [] }),
        close: async () => {},
      }),
      close: async () => {},
    })),
  },
}));

const { resolveEnv } = await import('../src/execute/envContext.js');
const { runAiTask } = await import('../src/execute/aiTask.js');
const { buildLoginTools } = await import('../src/pi/space/tools/login.js');

function toolCtx() {
  return { threadId: 't1', versionId: 'v1', projectId: 'p1', repo: { cwd: null, issue: null, noRepo: false }, emit: () => {} };
}

function mockEnv(login?: { user: string; password: string; loginUrl: string | null }, extra?: { logins?: Map<string, { user: string; password: string; loginUrl: string | null }>; webServices?: Array<{ name: string | null; label: string; origin: string; isDefault: boolean }> }) {
  const logins = extra?.logins ?? (login ? new Map([['default-web', login]]) : new Map());
  const webServices = extra?.webServices
    ?? (login ? [{ name: 'default-web', label: '默认 web', origin: 'http://e', isDefault: true }] : []);
  vi.mocked(resolveEnv).mockResolvedValue({
    envId: 'env1',
    envName: '测试环境',
    baseUrl: 'http://e',
    login,
    logins,
    webServices,
    hasCredentials: (ref: string) => logins.has(ref),
    resolveLogin: (ref?: string | null) => {
      if (ref) return logins.get(ref) ?? null;
      const def = webServices.find((w) => w.isDefault) ?? webServices.find((w) => w.name);
      return (def?.name ? logins.get(def.name) : undefined) ?? null;
    },
    close: async () => {},
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('get_login_credentials', () => {
  it('已配置凭据 → 概要含 user/loginUrl/hasPassword，不含密码', async () => {
    mockEnv({ user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://e/login' });
    const [credTool, loginTool] = buildLoginTools(toolCtx());
    const r = await credTool.execute({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data).toMatchObject({ user: 'qa01', loginUrl: 'http://e/login', hasPassword: true, environmentId: 'env1' });
      expect(r.data).not.toContain('Passw0rd!');
    }
    expect(loginTool.name).toBe('perform_login');
  });

  it('未配置凭据 → ok:false', async () => {
    mockEnv(undefined);
    const [credTool] = buildLoginTools(toolCtx());
    const r = await credTool.execute({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('未配置登录凭据');
  });

  it('返回可用 web 服务名清单（供 perform_login 选 webRef）', async () => {
    mockEnv(
      { user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://e/login' },
      {
        logins: new Map([
          ['default-web', { user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://e/login' }],
          ['backend', { user: 'ops01', password: 'Ops@12345', loginUrl: 'http://be/login' }],
        ]),
        webServices: [
          { name: 'default-web', label: '默认 web', origin: 'http://e', isDefault: true },
          { name: 'backend', label: '后端管理', origin: 'http://be', isDefault: false },
        ],
      },
    );
    const [credTool] = buildLoginTools(toolCtx());
    const r = await credTool.execute({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.webServices).toEqual(['default-web', 'backend']);
      expect(r.data).not.toContain('Ops@12345');
    }
  });
});

describe('perform_login（AI 驱动）', () => {
  it('runAiTask 报 passed → ok:true 返回 storageState，instruction 含占位符不含明文', async () => {
    mockEnv({ user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://e/login' });
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"登录成功"}');
    const [, loginTool] = buildLoginTools(toolCtx());
    const r = await loginTool.execute({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.storageState).toMatchObject({ cookies: [{ name: 'sid' }] });
      expect(data.message).toBe('登录成功');
      expect(r.data).not.toContain('Passw0rd!');
    }
    const call = vi.mocked(runAiTask).mock.calls[0]!;
    const instruction = String(call[1]);
    expect(instruction).toContain('http://e/login'); // 目标导航地址
    expect(instruction).toContain('__ITEST_USERNAME__');
    expect(instruction).toContain('__ITEST_PASSWORD__');
    expect(instruction).not.toContain('Passw0rd!');
    expect(call[4]).toMatchObject({ maxTurns: 10 });
    const opts = call[4] as { valueSub: (v: string) => string };
    expect(opts.valueSub('__ITEST_USERNAME__')).toBe('qa01');
    expect(opts.valueSub('__ITEST_PASSWORD__')).toBe('Passw0rd!');
  });

  it('显式 webRef → 用该服务的凭据（占位符带 @ref，值取该服务）', async () => {
    mockEnv(
      { user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://e/login' },
      {
        logins: new Map([
          ['default-web', { user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://e/login' }],
          ['backend', { user: 'ops01', password: 'Ops@12345', loginUrl: 'http://be/login' }],
        ]),
        webServices: [
          { name: 'default-web', label: '默认 web', origin: 'http://e', isDefault: true },
          { name: 'backend', label: '后端管理', origin: 'http://be', isDefault: false },
        ],
      },
    );
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"登录成功"}');
    const [, loginTool] = buildLoginTools(toolCtx());
    const r = await loginTool.execute({ webRef: 'backend' });
    expect(r.ok).toBe(true);
    const call = vi.mocked(runAiTask).mock.calls[0]!;
    const instruction = String(call[1]);
    expect(instruction).toContain('http://be/login'); // 目标 = 该服务自己的 loginUrl
    expect(instruction).toContain('__ITEST_USERNAME@backend__');
    expect(instruction).toContain('__ITEST_PASSWORD@backend__');
    expect(instruction).not.toContain('Ops@12345');
    const opts = call[4] as { valueSub: (v: string) => string };
    expect(opts.valueSub('__ITEST_USERNAME@backend__')).toBe('ops01');
    expect(opts.valueSub('__ITEST_PASSWORD@backend__')).toBe('Ops@12345');
    // 清单里同时列出两个服务，模型可自行改用别的 @ref
    expect(instruction).toContain('backend');
    expect(instruction).toContain('default-web');
  });

  it('webRef 指向未配凭据的服务 → ok:false（不静默回落默认服务）', async () => {
    mockEnv(
      { user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://e/login' },
      {
        logins: new Map([['default-web', { user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://e/login' }]]),
        webServices: [{ name: 'default-web', label: '默认 web', origin: 'http://e', isDefault: true }],
      },
    );
    const [, loginTool] = buildLoginTools(toolCtx());
    const r = await loginTool.execute({ webRef: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('nope');
    expect(vi.mocked(runAiTask)).not.toHaveBeenCalled();
  });

  it('summary failed → ok:false 登录失败携带 reason', async () => {
    mockEnv({ user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://e/login' });
    vi.mocked(runAiTask).mockResolvedValue('{"status":"failed","reason":"验证码始终识别错误"}');
    const [, loginTool] = buildLoginTools(toolCtx());
    const r = await loginTool.execute({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('验证码始终识别错误');
  });

  it('runAiTask reject → ok:false', async () => {
    mockEnv({ user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://e/login' });
    vi.mocked(runAiTask).mockRejectedValue(new Error('aiTask 超过 10 轮未完成'));
    const [, loginTool] = buildLoginTools(toolCtx());
    const r = await loginTool.execute({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('aiTask 超过 10 轮');
  });

  it('成功登录后回写 storageState 缓存（暖 verify_case）', async () => {
    mockEnv({ user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://e/login' });
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"登录成功"}');
    const [, loginTool] = buildLoginTools(toolCtx());
    const r = await loginTool.execute({});
    expect(r.ok).toBe(true);
    const { getLoginState } = await import('../src/pi/space/tools/loginStateCache.js');
    expect(getLoginState('env1:qa01')).toMatchObject({ cookies: [{ name: 'sid', value: 'abc' }] });
  });

  it('LLM 未配置 → ok:false，不启动浏览器', async () => {
    mockEnv({ user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://e/login' });
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    vi.mocked(resolveLlmClient).mockRejectedValueOnce(new Error('未配置 provider'));
    const [, loginTool] = buildLoginTools(toolCtx());
    const r = await loginTool.execute({});
    expect(r.ok).toBe(false);
    const { chromium } = await import('playwright-core');
    expect(chromium.launch).not.toHaveBeenCalled();
  });
});
