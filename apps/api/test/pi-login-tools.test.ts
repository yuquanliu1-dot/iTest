import { describe, it, expect, beforeEach, vi } from 'vitest';

// perform_login AI 化编排测试：resolveEnv / runAiTask / llmSettings / playwright 打桩。
vi.mock('../src/execute/envContext.js', () => ({ resolveEnv: vi.fn() }));
vi.mock('../src/execute/aiTask.js', () => ({ runAiTask: vi.fn() }));
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

function mockEnv(login?: { user: string; password: string; loginUrl: string | null }) {
  vi.mocked(resolveEnv).mockResolvedValue({
    envId: 'env1',
    baseUrl: 'http://e',
    login,
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
    if (!r.ok) expect(r.error).toContain('未配置 login 凭据');
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
