/**
 * Regression guard for the space-assistant identity rewrite (preamble replacement).
 *
 * Background: pi's default preamble is "You are an expert coding assistant operating inside pi",
 * which makes the assistant present itself externally as a coding assistant. The fix rewrites the rendered
 * system prompt inside before_agent_start.
 *
 * This test locks in a known gotcha: **the identity must not be changed via
 * loader.systemPrompt / systemPromptOptions.customPrompt**. pi's buildSystemPromptSections (system-prompt.js:76)
 * skips the else branch entirely when customPrompt is non-empty, dropping the tools / rules / docs sections —
 * the rules section carries the promptGuidelines of all space tools (STAGE_PROMPT_GUIDELINES etc.);
 * losing it silently voids the tool-usage guidelines.
 * The e2e below uses a real AgentSession + a real tool to assert those sections survive.
 */
import { describe, it, expect } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import {
  createAgentSession, defineTool, DefaultResourceLoader, getAgentDir, SessionManager,
} from '@earendil-works/pi-coding-agent';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { buildSpacePreamble, rewriteSpacePreamble } from '../src/pi/space/session.js';

/** pi's default preamble when unmodified (system-prompt.js:81). */
const PI_DEFAULT_PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. '
  + 'You help users by reading files, executing commands, editing code, and writing new files.';

describe('rewriteSpacePreamble', () => {
  const rendered = [
    PI_DEFAULT_PREAMBLE,
    '<tools>\n- verify_case: 在真实被测系统上验证用例\n</tools>',
    '<rules>\n- RULE_KEEP_ME\n- Be concise in your responses\n</rules>',
    '<addendum>\n## 输出风格\n- 简体中文\n</addendum>',
  ].join('\n\n');

  it('把 pi 默认 preamble 换成产品身份', () => {
    const out = rewriteSpacePreamble(rendered)!;
    expect(out.startsWith(buildSpacePreamble())).toBe(true);
    expect(out).not.toContain('coding assistant');
  });

  it('tools / rules / addendum 段原样保留', () => {
    const out = rewriteSpacePreamble(rendered)!;
    expect(out).toContain('verify_case: 在真实被测系统上验证用例');
    expect(out).toContain('RULE_KEEP_ME');
    expect(out).toContain('Be concise in your responses');
    expect(out).toContain('## 输出风格');
  });

  it('不含默认文案时返回 undefined（不用过期全文覆盖）', () => {
    expect(rewriteSpacePreamble('上游已改版的 prompt')).toBeUndefined();
  });

  it('幂等：改写结果再喂一次不再触发', () => {
    expect(rewriteSpacePreamble(rewriteSpacePreamble(rendered)!)).toBeUndefined();
  });
});

describe('buildSpacePreamble 语言化', () => {
  it('缺省 zh-CN：产品身份原文', () => {
    expect(buildSpacePreamble()).toContain('iTest 平台的测试助手');
  });

  it('en-US：英文产品身份（不混入中文定位）', () => {
    const out = buildSpacePreamble('en-US');
    expect(out).toContain('iTest platform');
    expect(out).not.toContain('iTest 平台的测试助手');
  });
});

/** Spin up a real session to capture "the system prompt actually sent to the provider", verifying the rewrite touches only the identity and never the tool guidelines. */
describe('空间助手 session 的 system prompt（端到端）', () => {
  /** Throws on any network request; its role is to cut off right after prompt construction. */
  function captureWirePrompt(buildLoader: (ws: string) => DefaultResourceLoader): Promise<string> {
    return (async () => {
      const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-space-identity-'));
      const loader = buildLoader(ws);
      await loader.reload();
      const model = {
        provider: 'openai', id: 'gpt-4o-mini', name: 'stub', api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 100,
      };
      // A real tool with promptGuidelines: exactly the guidelines lost when customPrompt short-circuits.
      const tool = defineTool({
        name: 'verify_case', label: 'verify_case', description: 'verify',
        parameters: Type.Object({}), promptGuidelines: ['RULE_KEEP_ME'],
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });
      let wire = '';
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (u: unknown, init: { body?: string } | undefined) => {
        wire = init?.body ?? String(u);
        throw new Error('stop-after-prompt');
      }) as typeof fetch;
      const { session } = await createAgentSession({
        cwd: ws, noTools: 'builtin', customTools: [tool], model,
        sessionManager: SessionManager.inMemory(), resourceLoader: loader,
      });
      try {
        await session.prompt('你是谁？');
      } catch { /* network cutoff is expected */ }
      const sys = session.messages.find((m) => m.role === 'system');
      globalThis.fetch = origFetch;
      await session.dispose();
      await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
      const head = JSON.parse(wire).input?.find((m: { role: string }) => m.role === 'system')?.content ?? '';
      // The transcript's sections stay intact: forceSystemPrompt only projects into the request header, it never lands in the session record.
      expect(Object.keys((sys as { sections?: object } | undefined)?.sections ?? {})).toEqual(
        ['preamble', 'tools', 'rules', 'docs', 'addendum', 'cwd'],
      );
      return head;
    })();
  }

  it('身份已替换，且工具 promptGuidelines 未丢', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const head = await captureWirePrompt((ws) => new DefaultResourceLoader({
      cwd: ws, agentDir: getAgentDir(), appendSystemPromptOverride: () => ['风格段'],
      extensionFactories: [{
        name: 'itest-space-identity', hidden: true,
        factory: (pi) => {
          pi.on('before_agent_start', (event) => {
            const rewritten = rewriteSpacePreamble(event.systemPrompt);
            if (rewritten !== undefined) return { systemPrompt: rewritten };
            return undefined;
          });
        },
      }],
    }));
    expect(head).toContain('iTest 平台的测试助手');
    expect(head).not.toContain('coding assistant');
    expect(head).toContain('RULE_KEEP_ME'); // exactly the item lost by the customPrompt short-circuit
  });

  it('对照组：不加扩展时 pi 原文照发（证明改写确实由扩展驱动）', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const head = await captureWirePrompt((ws) => new DefaultResourceLoader({
      cwd: ws, agentDir: getAgentDir(), appendSystemPromptOverride: () => ['风格段'],
    }));
    expect(head).toContain('coding assistant');
    expect(head).toContain('RULE_KEEP_ME');
  });
});
