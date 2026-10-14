/**
 * 空间助手身份重写（preamble 替换）的回归防护。
 *
 * 背景：pi 默认 preamble 是 "You are an expert coding assistant operating inside pi"，
 * 会让助手对外自称编码助手。修复方式是 before_agent_start 里改写渲染后的 system prompt。
 *
 * 本测试锁住一个易踩的坑：**不能通过 loader.systemPrompt / systemPromptOptions.customPrompt
 * 改身份**。pi 的 buildSystemPromptSections（system-prompt.js:76）在 customPrompt 非空时
 * 会整个跳过 else 分支，tools / rules / docs 三段全丢——rules 段承载所有空间工具的
 * promptGuidelines（STAGE_PROMPT_GUIDELINES 等），丢了等于静默废掉工具使用规范。
 * 下面的 e2e 用真实 AgentSession + 真实工具断言这些段仍在。
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

/** pi 未改版时的默认 preamble（system-prompt.js:81）。 */
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

/** 起一个真实 session 抓「真正发到 provider 的 system prompt」，验证改写只动身份、不伤工具规范。 */
describe('空间助手 session 的 system prompt（端到端）', () => {
  /** 命中网络请求即抛，作用是截断在 prompt 构造之后。 */
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
      // 带 promptGuidelines 的真实工具：正是 customPrompt 短路时会丢的那批规范。
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
      } catch { /* 网络截断属预期 */ }
      const sys = session.messages.find((m) => m.role === 'system');
      globalThis.fetch = origFetch;
      await session.dispose();
      await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
      const head = JSON.parse(wire).input?.find((m: { role: string }) => m.role === 'system')?.content ?? '';
      // transcript 的 sections 保持完整：forceSystemPrompt 只投影到请求头，不落会话记录。
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
    expect(head).toContain('RULE_KEEP_ME'); // customPrompt 短路会丢的就是这条
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
