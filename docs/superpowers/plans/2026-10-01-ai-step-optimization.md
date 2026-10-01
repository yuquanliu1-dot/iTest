# 智能步骤优化 v2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在智能步骤（aiStep）上落地服务端拆条、空 instruction 兜底、视觉识别（OPENAI / ANTHROPIC 双 provider）以及 UI 使用边界提示。

**Architecture:** 自底向上——先做拆条纯函数（`aiStepSplit.ts`）与占位符解析（`aiStepVision.ts`），再补 LLMClient 的 image 参数与 OPENAI / ANTHROPIC provider 的 vision 适配，最后在 `steps.ts` 入口串起来、在 `cdp.ts` 的 `case 'aiStep'` 增加视觉路径、在 `StepEditModal.tsx` 加边界提示。

**Tech Stack:** TypeScript / Zod / Express 5 / Drizzle / Vitest / Playwright / React + Tailwind。

**前置依赖：** 已落地 phase 1 + phase 2 + phase 3；`compileAiStep` / `compileAiStepsInPlace` 已在 `apps/api/src/agent/aiStepCompile.ts`；OPENAI / ANTHROPIC SDK 已接入。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `apps/api/src/agent/aiStepSplit.ts` | 拆条纯函数（按编号行） |
| `apps/api/src/agent/aiStepVision.ts` | 占位符解析 + 合法性校验 |
| `apps/api/src/agent/llm-client.ts` | `LLMRequest.image` / `LLMResult.vision` 扩展；mock provider 补 vision 分支 |
| `apps/api/src/agent/llm-openai.ts` | OPENAI provider 拆出文件；payload 补 image_url |
| `apps/api/src/agent/llm-anthropic.ts` | ANTHROPIC provider 拆出文件；payload 补 image base64 block |
| `apps/api/src/agent/llm-google.ts` | GOOGLE provider 拆出文件；payload 补 inlineData |
| `apps/api/src/agent/llmSettings.ts` | 适配新 client 路径；保持 `getLlmClient` 入口 |
| `apps/api/src/agent/aiStepCompile.ts` | 兜底 instruction；带 image 走 vision provider；视觉失败回退纯文本 |
| `apps/api/src/routes/steps.ts` | PUT 入口顺序：migrate → split → compile |
| `apps/api/src/execute/cdp.ts` | `case 'aiStep'`：planVision → 截图 → vision → dispatch |
| `apps/web/src/components/StepEditModal.tsx` | aiStep 区加边界折叠 + 拆条实时文案 |
| `apps/recorder/popup/panel.js` | ai 模式 hint 加 `#cssSelector` 提示 |
| 测试：新增 `aiStepSplit.test.ts` / `aiStepVision.test.ts` / `llm-vision.test.ts`；补充 `aiStepCompile.test.ts` / `cases.test.ts` / `execute-cdp.test.ts` |

---

## Task 1: aiStepSplit 纯函数（红）

**Files:**
- Create: `apps/api/src/agent/aiStepSplit.ts`
- Create: `apps/api/test/aiStepSplit.test.ts`

- [ ] **Step 1: 写测试**

创建 `apps/api/test/aiStepSplit.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { splitByNumber } from '../src/agent/aiStepSplit.js';

describe('splitByNumber', () => {
  it('returns the original when no numbered lines present', () => {
    expect(splitByNumber('在搜索框输入"测试项目"')).toEqual(['在搜索框输入"测试项目"']);
  });

  it('splits a single numbered list (dot form) into separate instructions', () => {
    expect(
      splitByNumber('1. 在搜索框输入"测试项目"\n2. 点击查询\n3. 打开第一条结果详情'),
    ).toEqual([
      '在搜索框输入"测试项目"',
      '点击查询',
      '打开第一条结果详情',
    ]);
  });

  it('splits a single numbered list (、form)', () => {
    expect(
      splitByNumber('1、打开下拉框选择 MySQL\n2、打开下拉框选择 PostgreSQL\n3、点击保存'),
    ).toEqual([
      '打开下拉框选择 MySQL',
      '打开下拉框选择 PostgreSQL',
      '点击保存',
    ]);
  });

  it('keeps multi-line content within each numbered segment', () => {
    expect(
      splitByNumber('1. 第一行\n第二行\n2. 第三行\n第四行'),
    ).toEqual(['第一行\n第二行', '第三行\n第四行']);
  });

  it('ignores a single numbered segment (returns original)', () => {
    expect(splitByNumber('1. 只有一条')).toEqual(['1. 只有一条']);
  });

  it('keeps prose with "1" mid-sentence intact (not a list)', () => {
    expect(splitByNumber('处理完 1 个项目后点击确定')).toEqual(['处理完 1 个项目后点击确定']);
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/api test -- test/aiStepSplit.test.ts 2>&1 | tail -15`
Expected: 模块未找到，FAIL。

- [ ] **Step 3: 提交 RED**

```bash
git add apps/api/test/aiStepSplit.test.ts
git commit -m "test(api): aiStepSplit — number-line splitting rules"
```

---

## Task 2: aiStepSplit 纯函数（绿）

**Files:**
- Create: `apps/api/src/agent/aiStepSplit.ts`

- [ ] **Step 1: 实现 splitByNumber**

创建 `apps/api/src/agent/aiStepSplit.ts`：

```ts
/**
 * 按编号段拆一条自然语言指令。匹配规则：行首空白 + 数字 + `.` 或 `、` + 空白。
 * - 无编号段 → 返回 [raw]
 * - 编号段数 < 2 → 返回 [raw]（不去凑数）
 * - 编号段之间允许空白行；段内多行用 \n 拼接
 */
export function splitByNumber(raw: string): string[] {
  const re = /^[ \t]*\d+[.\、][ \t]+(.+)$/;
  const lines = raw.split(/\r?\n/);
  const matches: { index: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(re);
    if (m) matches.push({ index: i, text: m[1]! });
  }
  if (matches.length < 2) return [raw];
  const result: string[] = [];
  for (let k = 0; k < matches.length; k++) {
    const start = matches[k]!.index;
    const end = k + 1 < matches.length ? matches[k + 1]!.index : lines.length;
    const inner = lines
      .slice(start, end)
      .map((line) => line.replace(re, '$1'))
      .filter((s) => s.length > 0);
    const joined = inner.join('\n').trim();
    if (joined) result.push(joined);
  }
  return result.length >= 2 ? result : [raw];
}

/** 整批拆条；就地把 aiStep 拆为多条同 kind 步骤，并标记 originOrder。返回展开数量。 */
export function splitAiStepsInPlace(
  steps: Array<{ action: unknown; order?: number; name?: string; delayMs?: number; source?: string }>,
): { expanded: number } {
  let expanded = 0;
  const out: typeof steps = [];
  for (const s of steps) {
    const a = s.action as { kind?: string; instruction?: string; compiled?: unknown };
    if (a?.kind !== 'aiStep') {
      out.push(s);
      continue;
    }
    const parts = splitByNumber(a.instruction ?? '');
    if (parts.length <= 1) {
      out.push(s);
      continue;
    }
    expanded += parts.length - 1;
    parts.forEach((p, idx) => {
      out.push({
        ...s,
        action: {
          kind: 'aiStep',
          instruction: p,
          compiled: idx === 0 ? (a.compiled ?? null) : null,
        },
      });
    });
  }
  steps.length = 0;
  steps.push(...out);
  return { expanded };
}
```

- [ ] **Step 2: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/api test -- test/aiStepSplit.test.ts 2>&1 | tail -15`
Expected: 6 个用例全绿。

- [ ] **Step 3: 运行 typecheck**

Run: `pnpm --filter @itest/api typecheck 2>&1 | tail -5`
Expected: exit 0。

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/agent/aiStepSplit.ts
git commit -m "feat(api): aiStepSplit — split numbered instructions into multiple aiSteps"
```

---

## Task 3: aiStepVision 占位符解析（红）

**Files:**
- Create: `apps/api/src/agent/aiStepVision.ts`
- Create: `apps/api/test/aiStepVision.test.ts`

- [ ] **Step 1: 写测试**

创建 `apps/api/test/aiStepVision.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { planVision } from '../src/agent/aiStepVision.js';

describe('planVision', () => {
  it('returns useVision=false when no placeholder present', () => {
    const out = planVision('在搜索框输入"测试项目"');
    expect(out).toEqual({
      useVision: false,
      sourceSelector: undefined,
      outputSelector: undefined,
      cleanedInstruction: '在搜索框输入"测试项目"',
    });
  });

  it('extracts single #cssSelector as source', () => {
    const out = planVision('识别图片 #captchaImg 并输入');
    expect(out.useVision).toBe(true);
    expect(out.sourceSelector).toBe('#captchaImg');
    expect(out.outputSelector).toBeUndefined();
    expect(out.cleanedInstruction).toBe('识别图片  并输入');
  });

  it('extracts source + output placeholders in order', () => {
    const out = planVision('识别图片 #captchaImg 并输入到 #captchaInput');
    expect(out.sourceSelector).toBe('#captchaImg');
    expect(out.outputSelector).toBe('#captchaInput');
  });

  it('ignores # which is not start of placeholder (e.g. inside a quoted value)', () => {
    const out = planVision('点击"菜单 #1"按钮');
    expect(out.useVision).toBe(false);
    expect(out.cleanedInstruction).toBe('点击"菜单 #1"按钮');
  });

  it('throws on illegal characters in placeholder', () => {
    expect(() => planVision('识别图片 #captcha<img> 并输入')).toThrow(/InvalidVisionSelector/);
  });

  it('throws when more than two placeholders provided', () => {
    expect(() => planVision('识别 #a 填到 #b 比对 #c')).toThrow(/too many/);
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/api test -- test/aiStepVision.test.ts 2>&1 | tail -15`
Expected: 模块未找到，FAIL。

- [ ] **Step 3: 提交 RED**

```bash
git add apps/api/test/aiStepVision.test.ts
git commit -m "test(api): aiStepVision — placeholder extraction + validation"
```

---

## Task 4: aiStepVision 占位符解析（绿）

**Files:**
- Create: `apps/api/src/agent/aiStepVision.ts`

- [ ] **Step 1: 实现 planVision**

创建 `apps/api/src/agent/aiStepVision.ts`：

```ts
export interface VisionPlan {
  useVision: boolean;
  sourceSelector?: string;
  outputSelector?: string;
  cleanedInstruction: string;
}

export class InvalidVisionSelectorError extends Error {
  constructor(public readonly selector: string) {
    super(`InvalidVisionSelector: ${selector.slice(0, 50)}`);
    this.name = 'InvalidVisionSelectorError';
  }
}

export class TooManyVisionSelectorsError extends Error {
  constructor(public readonly count: number) {
    super(`TooManyVisionSelectors: ${count} placeholders in instruction`);
    this.name = 'TooManyVisionSelectorsError';
  }
}

const ALLOWED = /^[a-zA-Z0-9_.\-#>+~*:[\]"=\s]+$/;

/** 从 instruction 解析占位符；非法字符抛 InvalidVisionSelectorError；>2 占位符抛 TooManyVisionSelectorsError。 */
export function planVision(raw: string): VisionPlan {
  const re = /#([^\s"#]+)/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    matches.push(m[0]);
  }
  if (matches.length === 0) {
    return { useVision: false, cleanedInstruction: raw };
  }
  if (matches.length > 2) throw new TooManyVisionSelectorsError(matches.length);
  for (const sel of matches) {
    if (!ALLOWED.test(sel)) throw new InvalidVisionSelectorError(sel);
  }
  return {
    useVision: true,
    sourceSelector: matches[0],
    outputSelector: matches[1],
    cleanedInstruction: raw.replace(re, '').replace(/\s+/g, ' ').trim(),
  };
}
```

- [ ] **Step 2: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/api test -- test/aiStepVision.test.ts 2>&1 | tail -15`
Expected: 6 个用例全绿。

- [ ] **Step 3: 运行 typecheck**

Run: `pnpm --filter @itest/api typecheck 2>&1 | tail -5`
Expected: exit 0。

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/agent/aiStepVision.ts
git commit -m "feat(api): aiStepVision — placeholder parsing for #cssSelector"
```

---

## Task 5: LLMClient 扩展 image 参数（红）

**Files:**
- Modify: `apps/api/test/aiStepCompile.test.ts`

- [ ] **Step 1: 补 LLMRequest / LLMResult 形状测试**

打开 `apps/api/test/aiStepCompile.test.ts`，把 fakeClient 改成同时携带 vision 调用：

```ts
const fakeClient = (outputs: { steps?: unknown }[]): LLMClient => ({
  provider: 'mock',
  complete: async () => {
    const v = outputs.shift();
    return v ? { kind: 'json', value: v as Record<string, unknown> } : { kind: 'text', value: '' };
  },
});
```

在文件末尾追加：

```ts
import type { LLMClient, LLMRequest, LLMResult } from '../src/agent/llm-client.js';

describe('LLMClient shape — vision support', () => {
  it('LLMRequest accepts optional image', () => {
    const req: LLMRequest = {
      systemPrompt: 's',
      userMessage: 'u',
      image: { base64: 'AAA=', mime: 'image/png' },
    };
    expect(req.image?.mime).toBe('image/png');
  });

  it('LLMResult exposes vision flag', () => {
    const r: LLMResult = { kind: 'text', value: 'x', provider: 'mock', vision: false };
    expect(r.vision).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/api test -- test/aiStepCompile.test.ts 2>&1 | tail -15`
Expected: `LLMRequest` / `LLMResult` 类型未导出 → TS 编译或运行时错误。

- [ ] **Step 3: 提交 RED**

```bash
git add apps/api/test/aiStepCompile.test.ts
git commit -m "test(api): LLMClient shape — image parameter + vision flag"
```

---

## Task 6: LLMClient 扩展 image 参数（绿）

**Files:**
- Modify: `apps/api/src/agent/llm-client.ts`

- [ ] **Step 1: 拆分 provider 文件**

把 `apps/api/src/agent/llm-client.ts` 拆为 5 个文件：
- `llm-client.ts`：`LLMProvider` / `LLMConfig` / `LLMRequest` / `LLMResult` / `LLMClient` 类型 + `getLlmClient` 工厂
- `llm-mock.ts`：`MockClient`
- `llm-openai.ts`：`OpenAIClient`
- `llm-anthropic.ts`：`AnthropicClient`
- `llm-google.ts`：`GoogleClient`

新的 `llm-client.ts`：

```ts
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { GoogleGenerativeAI } from '@google/generative-ai';

export type LLMProvider = 'mock' | 'openai' | 'anthropic' | 'google';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface LLMRequest {
  systemPrompt: string;
  userMessage: string;
  /** 多模态输入：当前只支持单图；后续可扩 image[] */
  image?: { base64: string; mime: 'image/png' | 'image/jpeg' };
}

export type LLMCompleteResult =
  | { kind: 'json'; value: Record<string, unknown> }
  | { kind: 'text'; value: string };

export interface LLMResult extends LLMCompleteResult {
  provider: LLMProvider;
  vision: boolean;
}

export interface LLMClient {
  provider: LLMProvider;
  complete(req: LLMRequest): Promise<LLMResult>;
}

export function listProviders(): LLMProvider[] {
  return ['mock', 'openai', 'anthropic', 'google'];
}

/** 解析模型输出为 JSON。 */
export function tryParseJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed) as Record<string, unknown>; } catch { /* fall through */ }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1]!.trim()) as Record<string, unknown>; } catch { /* fall through */ }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>; } catch { /* fall through */ }
  }
  return null;
}

// 工厂函数：实际实现由各 provider 文件提供
export type LLMProviderFactory = (cfg: LLMConfig) => LLMClient;
export const PROVIDER_FACTORIES: Record<LLMProvider, LLMProviderFactory> = {} as never;

export function getLlmClient(config: LLMConfig): LLMClient {
  const factory = PROVIDER_FACTORIES[config.provider];
  return factory(config);
}

// 类型 re-export 让 llmSettings / aiStepCompile 不必跨多个文件改 import
export type { OpenAI as OpenAISDK, Anthropic as AnthropicSDK, GoogleGenerativeAI };
```

- [ ] **Step 2: 拆 MockClient 到 `llm-mock.ts`**

创建 `apps/api/src/agent/llm-mock.ts`：

```ts
import type { LLMClient, LLMRequest, LLMResult } from './llm-client.js';

export class MockClient implements LLMClient {
  provider = 'mock' as const;
  async complete(req: LLMRequest): Promise<LLMResult> {
    const base = this.build(req.userMessage);
    return { ...base, provider: 'mock', vision: !!req.image };
  }
  private build(userMessage: string): Omit<LLMResult, 'provider' | 'vision'> {
    if (userMessage.includes('vision-input')) {
      return { kind: 'text', value: '[mock-vision] ABC123' };
    }
    if (userMessage.includes('ai-step')) {
      return { kind: 'json', value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] } };
    }
    if (userMessage.includes('requirement') || userMessage.includes('需求')) {
      return {
        kind: 'json',
        value: {
          cases: [
            {
              title: 'mock 生成的用例',
              description: 'mock provider 自动产出',
              priority: 'P1',
              steps: [
                { order: 1, action: { kind: 'navigate', url: 'https://example.com' } },
                { order: 2, action: { kind: 'click', locator: [{ strategy: 'role', value: 'button[name="登录"]' }] } },
              ],
            },
          ],
        },
      };
    }
    if (userMessage.includes('case') || userMessage.includes('用例')) {
      return { kind: 'json', value: { steps: [{ order: 99, action: { kind: 'assertVisible', locator: [{ strategy: 'role', value: 'main' }] } }] } };
    }
    return { kind: 'text', value: '[mock] no specific response for this input' };
  }
}
```

- [ ] **Step 3: 拆 OpenAIClient 到 `llm-openai.ts`（带 image）**

创建 `apps/api/src/agent/llm-openai.ts`：

```ts
import OpenAI from 'openai';
import type { LLMClient, LLMConfig, LLMRequest, LLMResult } from './llm-client.js';
import { tryParseJson } from './llm-client.js';

export class OpenAIClient implements LLMClient {
  provider = 'openai' as const;
  private client: OpenAI;
  constructor(private cfg: LLMConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  }
  async complete(req: LLMRequest): Promise<LLMResult> {
    const model = this.cfg.model || 'gpt-4o-mini';
    const userContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text: req.userMessage },
    ];
    if (req.image) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${req.image.mime};base64,${req.image.base64}` },
      });
    }
    const resp = await this.client.chat.completions.create({
      model,
      messages: [
        ...(req.systemPrompt ? [{ role: 'system' as const, content: req.systemPrompt }] : []),
        { role: 'user' as const, content: userContent },
      ],
      response_format: { type: 'json_object' as const },
      temperature: 0.2,
    });
    const text = resp.choices[0]?.message?.content ?? '';
    const json = tryParseJson(text);
    return {
      kind: json ? 'json' : 'text',
      value: json ?? text,
      provider: 'openai',
      vision: !!req.image,
    };
  }
}
```

- [ ] **Step 4: 拆 AnthropicClient 到 `llm-anthropic.ts`（带 image）**

创建 `apps/api/src/agent/llm-anthropic.ts`：

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { LLMClient, LLMConfig, LLMRequest, LLMResult } from './llm-client.js';
import { tryParseJson } from './llm-client.js';

export class AnthropicClient implements LLMClient {
  provider = 'anthropic' as const;
  private client: Anthropic;
  constructor(private cfg: LLMConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  }
  async complete(req: LLMRequest): Promise<LLMResult> {
    const model = this.cfg.model || 'claude-sonnet-4-6';
    const userContent: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string } }
    > = [{ type: 'text', text: req.userMessage }];
    if (req.image) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: req.image.mime, data: req.image.base64 },
      });
    }
    const resp = await this.client.messages.create({
      model,
      max_tokens: 4096,
      system: req.systemPrompt || 'You are a helpful assistant. Reply with JSON only.',
      messages: [{ role: 'user', content: userContent }],
    });
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = tryParseJson(text);
    return {
      kind: json ? 'json' : 'text',
      value: json ?? text,
      provider: 'anthropic',
      vision: !!req.image,
    };
  }
}
```

- [ ] **Step 5: 拆 GoogleClient 到 `llm-google.ts`**

创建 `apps/api/src/agent/llm-google.ts`：

```ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { LLMClient, LLMConfig, LLMRequest, LLMResult } from './llm-client.js';
import { tryParseJson } from './llm-client.js';

export class GoogleClient implements LLMClient {
  provider = 'google' as const;
  private client: GoogleGenerativeAI;
  constructor(private cfg: LLMConfig) {
    this.client = new GoogleGenerativeAI(cfg.apiKey);
  }
  async complete(req: LLMRequest): Promise<LLMResult> {
    const model = this.cfg.model || 'gemini-2.0-flash';
    const m = this.client.getGenerativeModel({
      model,
      systemInstruction: req.systemPrompt || 'You are a helpful assistant. Reply with JSON only.',
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    });
    const parts: Array<{ text: string } | { inlineData: { mimeType: 'image/png' | 'image/jpeg'; data: string } }> = [
      { text: req.userMessage },
    ];
    if (req.image) {
      parts.push({ inlineData: { mimeType: req.image.mime, data: req.image.base64 } });
    }
    const resp = await m.generateContent(parts);
    const text = resp.response.text();
    const json = tryParseJson(text);
    return {
      kind: json ? 'json' : 'text',
      value: json ?? text,
      provider: 'google',
      vision: !!req.image,
    };
  }
}
```

- [ ] **Step 6: 在 llm-client.ts 末尾注册 factory**

把 `llm-client.ts` 末尾改为：

```ts
import { MockClient } from './llm-mock.js';
import { OpenAIClient } from './llm-openai.js';
import { AnthropicClient } from './llm-anthropic.js';
import { GoogleClient } from './llm-google.js';

export const PROVIDER_FACTORIES: Record<LLMProvider, LLMProviderFactory> = {
  mock: () => new MockClient(),
  openai: (cfg) => new OpenAIClient(cfg),
  anthropic: (cfg) => new AnthropicClient(cfg),
  google: (cfg) => new GoogleClient(cfg),
};

export function getLlmClient(config: LLMConfig): LLMClient {
  const factory = PROVIDER_FACTORIES[config.provider];
  return factory(config);
}
```

- [ ] **Step 7: 运行 typecheck**

Run: `pnpm --filter @itest/api typecheck 2>&1 | tail -10`
Expected: exit 0。

- [ ] **Step 8: 运行 aiStepCompile 单测 + LLMClient 单测，预期 GREEN**

Run: `pnpm --filter @itest/api test -- test/aiStepCompile.test.ts 2>&1 | tail -15`
Expected: 原有 5 + 新增 2 = 7 个用例全绿。

- [ ] **Step 9: 提交**

```bash
git add apps/api/src/agent/llm-client.ts apps/api/src/agent/llm-mock.ts apps/api/src/agent/llm-openai.ts apps/api/src/agent/llm-anthropic.ts apps/api/src/agent/llm-google.ts apps/api/test/aiStepCompile.test.ts
git commit -m "refactor(api): split llm-client into provider files + add image/vision fields"
```

---

## Task 7: aiStepCompile 兜底 + 视觉路径（红）

**Files:**
- Modify: `apps/api/test/aiStepCompile.test.ts`

- [ ] **Step 1: 在文件末尾追加 2 个用例**

打开 `apps/api/test/aiStepCompile.test.ts`，在文件末尾追加：

```ts
describe('compileAiStep — fallback on empty instruction', () => {
  it('uses step.name when instruction is empty', async () => {
    let captured = '';
    const client: LLMClient = {
      provider: 'mock',
      complete: async (req) => {
        captured = req.userMessage;
        return {
          kind: 'json',
          value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] },
          provider: 'mock',
          vision: false,
        };
      },
    };
    const out = await compileAiStep('', { name: '点击保存' }, client);
    expect(out).toHaveLength(1);
    expect(captured).toContain('点击保存');
    expect(captured).toContain('[fallback-by-name]');
  });

  it('throws when instruction empty and no name', async () => {
    const client: LLMClient = {
      provider: 'mock',
      complete: async () => ({ kind: 'text', value: '', provider: 'mock', vision: false }),
    };
    await expect(compileAiStep('', {}, client)).rejects.toThrow(/编译失败/);
  });
});

describe('compileAiStep — vision path', () => {
  it('forwards image to provider when placeholders are present', async () => {
    let captured: { image?: unknown; userMessage?: string } = {};
    const client: LLMClient = {
      provider: 'mock',
      complete: async (req) => {
        captured = { image: req.image, userMessage: req.userMessage };
        return {
          kind: 'text',
          value: '识别出的文本',
          provider: 'mock',
          vision: !!req.image,
        };
      },
    };
    const text = await compileAiStepVision(
      '识别图片 #captchaImg 并输入到 #captchaInput',
      { image: { base64: 'AAA=', mime: 'image/png' } },
      client,
    );
    expect(text).toBe('识别出的文本');
    expect(captured.image).toEqual({ base64: 'AAA=', mime: 'image/png' });
    expect(captured.userMessage).toContain('captchaInput');
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/api test -- test/aiStepCompile.test.ts 2>&1 | tail -25`
Expected: 编译路径未覆盖 image 与 fallback → 2 个新增用例 FAIL。

- [ ] **Step 3: 提交 RED**

```bash
git add apps/api/test/aiStepCompile.test.ts
git commit -m "test(api): compileAiStep — fallback by name + vision path"
```

---

## Task 8: aiStepCompile 兜底 + 视觉路径（绿）

**Files:**
- Modify: `apps/api/src/agent/aiStepCompile.ts`

- [ ] **Step 1: 引入新依赖**

打开 `apps/api/src/agent/aiStepCompile.ts`，把 import 段：

```ts
import { StepAction, type StepAction as StepActionType } from '@itest/shared';
import { resolveLlmClient } from './llmSettings.js';
import type { LLMClient } from './llm-client.js';
```

替换成：

```ts
import { StepAction, type StepAction as StepActionType } from '@itest/shared';
import { resolveLlmClient } from './llmSettings.js';
import type { LLMClient } from './llm-client.js';
import { planVision } from './aiStepVision.js';
```

- [ ] **Step 2: 把 compileAiStep 改成接 ctx.name**

把整段函数（19–46 行）替换成：

```ts
export async function compileAiStep(
  instruction: string,
  ctx: { url?: string; name?: string } = {},
  client?: LLMClient,
): Promise<StepActionType[]> {
  const llm = client ?? (await resolveLlmClient()).client;
  const effective = buildEffectiveInstruction(ctx, instruction);
  const attempt = async (hint: string): Promise<StepActionType[]> => {
    const userMessage = [
      'ai-step',
      ctx.url ? `页面 URL: ${ctx.url}` : '',
      `指令: ${effective.text}${effective.fallback ? ' [fallback-by-name]' : ''}`,
      hint,
    ].filter(Boolean).join('\n');
    const r = await llm.complete({ systemPrompt: SYSTEM_PROMPT, userMessage });
    const raw = r.kind === 'json' ? (r.value as { steps?: unknown }).steps : undefined;
    if (!Array.isArray(raw)) return [];
    const out: StepActionType[] = [];
    for (const item of raw) {
      const p = StepAction.safeParse(item);
      if (p.success && p.data.kind !== 'aiStep') out.push(p.data);
    }
    return out;
  };
  const first = await attempt('');
  if (first.length > 0) return first;
  const second = await attempt('上一次输出不合法：请只输出纯 JSON {"steps":[...]}，kind 必须从允许列表中取。');
  if (second.length > 0) return second;
  throw new Error(`AI 步骤编译失败: ${effective.text.slice(0, 50)}`);
}

function buildEffectiveInstruction(
  ctx: { name?: string },
  raw: string,
): { text: string; fallback: boolean } {
  const trimmed = raw.trim();
  if (trimmed) return { text: trimmed, fallback: false };
  const fallback = ctx.name?.trim();
  if (!fallback) throw new Error('AI 步骤缺少指令且无步骤名兜底');
  return { text: fallback, fallback: true };
}

/** 视觉路径：按 #cssSelector 占位符从 instruction 解析出 source/output；调用 provider；返回识别文本。 */
export async function compileAiStepVision(
  instruction: string,
  ctx: { image: { base64: string; mime: 'image/png' | 'image/jpeg' } },
  client?: LLMClient,
): Promise<string> {
  const llm = client ?? (await resolveLlmClient()).client;
  const plan = planVision(instruction);
  if (!plan.useVision) throw new Error('compileAiStepVision: no #cssSelector placeholder in instruction');
  const sys = `你是 OCR 助手。从图片中识别文本并只输出识别结果，不要解释，不要包含多余字符。`;
  const user = plan.outputSelector
    ? `页面元素: ${plan.sourceSelector}\n填写到: ${plan.outputSelector}\n${plan.cleanedInstruction}`
    : `页面元素: ${plan.sourceSelector}\n${plan.cleanedInstruction}`;
  const r = await llm.complete({ systemPrompt: sys, userMessage: user, image: ctx.image });
  const text = r.kind === 'text' ? r.value : JSON.stringify(r.value);
  const out = text.trim();
  if (!out) throw new Error('compileAiStepVision: provider returned empty result');
  return out;
}
```

- [ ] **Step 3: 调整 compileAiStepsInPlace**

把文件里 48–66 行的 `compileAiStepsInPlace` 整段替换成：

```ts
export async function compileAiStepsInPlace(
  steps: Array<{ action: unknown; url?: string; name?: string }>,
  client?: LLMClient,
): Promise<number[]> {
  const failed: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i]!.action as { kind?: string; instruction?: string; compiled?: unknown; name?: string };
    if (a?.kind !== 'aiStep') continue;
    try {
      a.compiled = await compileAiStep(
        a.instruction ?? '',
        { url: steps[i]!.url, name: steps[i]!.name },
        client,
      );
    } catch {
      a.compiled = null;
      failed.push(i);
    }
  }
  return failed;
}
```

- [ ] **Step 4: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/api test -- test/aiStepCompile.test.ts 2>&1 | tail -25`
Expected: 7 个原用例 + 3 个新用例全绿。

- [ ] **Step 5: 运行 typecheck**

Run: `pnpm --filter @itest/api typecheck 2>&1 | tail -5`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/agent/aiStepCompile.ts
git commit -m "feat(api): compileAiStep fallback-by-name + compileAiStepVision"
```

---

## Task 9: steps PUT 入口串联（红）

**Files:**
- Modify: `apps/api/test/cases.test.ts`

- [ ] **Step 1: 在文件末尾追加 2 个端到端用例**

打开 `apps/api/test/cases.test.ts`，在文件末尾追加：

```ts
describe('steps PUT — aiStep split + fallback', () => {
  it('splits numbered aiStep into multiple steps on PUT', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'split', groupId });
    const r = await request(app)
      .put(`/api/cases/${c.body.id}/steps`)
      .send({
        steps: [
          {
            source: 'manual',
            action: {
              kind: 'aiStep',
              instruction: '1. 输入\n2. 点击\n3. 打开详情',
              compiled: null,
            },
          },
        ],
      });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/cases/${c.body.id}`);
    expect(detail.body.steps).toHaveLength(3);
    expect(detail.body.steps.map((s: { action: { instruction: string } }) => s.action.instruction))
      .toEqual(['输入', '点击', '打开详情']);
  });

  it('falls back to step.name when instruction is empty', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'fallback', groupId });
    const r = await request(app)
      .put(`/api/cases/${c.body.id}/steps`)
      .send({
        steps: [
          {
            source: 'manual',
            name: '点击保存按钮',
            action: { kind: 'aiStep', instruction: '', compiled: null },
          },
        ],
      });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/cases/${c.body.id}`);
    expect(detail.body.steps).toHaveLength(1);
    expect(detail.body.steps[0].action.compiled).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/api test -- test/cases.test.ts 2>&1 | tail -25`
Expected: 2 个新用例 FAIL（步骤未被拆 / fallback 未触发）。

- [ ] **Step 3: 提交 RED**

```bash
git add apps/api/test/cases.test.ts
git commit -m "test(api): cases PUT — aiStep split + fallback-by-name"
```

---

## Task 10: steps PUT 入口串联（绿）

**Files:**
- Modify: `apps/api/src/routes/steps.ts`

- [ ] **Step 1: 引入 aiStepSplit**

打开 `apps/api/src/routes/steps.ts`，在 import 段尾追加：

```ts
import { splitAiStepsInPlace } from '../agent/aiStepSplit.js';
```

- [ ] **Step 2: 在 PUT handler 拆条前调用 splitAiStepsInPlace**

在 `stepsRoute.put('/:caseId/steps', ...)` 函数体最开头（Zod parse 之后、project 校验之前）插入：

```ts
  splitAiStepsInPlace(body.steps);
```

并把后续 `compileAiStepsInPlace(body.steps.map((s) => ({ action: s.action })))` 替换成：

```ts
  const failedAi = await compileAiStepsInPlace(
    body.steps.map((s) => ({ action: s.action, name: s.name })),
  );
```

- [ ] **Step 3: POST handler 同样接入**

打开 `stepsRoute.post('/:caseId/steps', ...)`，把：

```ts
  const failedAi = await compileAiStepsInPlace(body.steps.map((s) => ({ action: s.action })));
```

替换成：

```ts
  splitAiStepsInPlace(body.steps);
  const failedAi = await compileAiStepsInPlace(
    body.steps.map((s) => ({ action: s.action, name: undefined })),
  );
```

- [ ] **Step 4: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/api test -- test/cases.test.ts 2>&1 | tail -20`
Expected: 全部用例含新 2 个全绿。

- [ ] **Step 5: 运行 typecheck**

Run: `pnpm --filter @itest/api typecheck 2>&1 | tail -5`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/routes/steps.ts
git commit -m "feat(api): steps PUT/POST — split numbered aiSteps before compile"
```

---

## Task 11: cdp aiStep 视觉路径（红）

**Files:**
- Modify: `apps/api/test/execute-cdp.test.ts`

- [ ] **Step 1: 在文件末尾追加 1 个视觉场景用例**

打开 `apps/api/test/execute-cdp.test.ts`，在文件末尾追加：

```ts
describe('phase4 — aiStep vision path', () => {
  it('captures #selector → mock OCR → fills output #selector', async () => {
    // page.locator 返回 mock.first(locator)；用 #captchaImg 作为源
    mocked.__locator.mockClear();
    mocked.__getByText.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000040',
      [
        {
          order: 1,
          action: {
            kind: 'aiStep',
            instruction: '识别图片 #captchaImg 并输入到 #captchaInput',
            compiled: null,
          },
        },
      ],
      {
        reportId: 'r-vision-1',
        llmClient: {
          provider: 'mock',
          complete: async () => ({
            kind: 'text',
            value: '识别出的文本',
            provider: 'mock',
            vision: true,
          }),
        },
      },
    );
    expect(results[0]!.status).toBe('passed');
    // 至少调用过两次 locator：一次截取 #captchaImg，一次 fill #captchaInput
    expect(mocked.__locator.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
```

> **注意**：当前 `executeCaseReal` 不接受 `llmClient` 参数——需要在 Task 12 实现时同时给 `ExecContext` 加 `llmClient?: LLMClient` 字段。本测试文件本步只先加用例，运行时会类型不通过，因此先一并修改 `ExecContext` 接口为兼容字段（先在 Task 12 一起改也可）。

- [ ] **Step 2: 提交 RED（含 test + ExecContext 接口预备）**

打开 `apps/api/src/execute/cdp.ts`，把 `ExecContext` 接口尾追加：

```ts
  /** LLMClient 注入；缺省时按需 resolveLlmClient */
  llmClient?: import('../agent/llm-client.js').LLMClient;
```

并提交：

```bash
git add apps/api/test/execute-cdp.test.ts apps/api/src/execute/cdp.ts
git commit -m "test(api): cdp — aiStep vision path + ExecContext.llmClient"
```

---

## Task 12: cdp aiStep 视觉路径（绿）

**Files:**
- Modify: `apps/api/src/execute/cdp.ts`

- [ ] **Step 1: 引入视觉依赖**

打开 `apps/api/src/execute/cdp.ts`，在 import 段尾追加：

```ts
import { planVision } from '../agent/aiStepVision.js';
import { compileAiStepVision } from '../agent/aiStepCompile.js';
import { resolveLlmClient } from '../agent/llmSettings.js';
```

- [ ] **Step 2: 改写 case 'aiStep'**

把 `case 'aiStep'` 段（190–196 行附近）替换成：

```ts
    case 'aiStep': {
      const instruction = String(action.instruction ?? '');
      const plan = planVision(instruction);
      if (plan.useVision) {
        const client = opts.ctx.llmClient ?? (await resolveLlmClient()).client;
        const sourceLoc = page.locator(plan.sourceSelector!).first();
        await sourceLoc.waitFor({ state: 'visible', timeout: 5000 });
        const buffer = await sourceLoc.screenshot({ timeout: 5000 });
        const text = await compileAiStepVision(
          instruction,
          { image: { base64: buffer.toString('base64'), mime: 'image/png' } },
          client,
        );
        if (plan.outputSelector) {
          const targetLoc = page.locator(plan.outputSelector).first();
          await targetLoc.waitFor({ state: 'visible', timeout: 5000 });
          await targetLoc.fill(text, { timeout: 5000 });
        }
        return;
      }
      if (!action.compiled) throw new Error('AI 步骤未编译');
      for (const sub of action.compiled) {
        await dispatch(sub, opts);
      }
      return;
    }
```

- [ ] **Step 3: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/api test -- test/execute-cdp.test.ts 2>&1 | tail -25`
Expected: 原用例 + 新 1 个全绿。

- [ ] **Step 4: 运行 typecheck**

Run: `pnpm --filter @itest/api typecheck 2>&1 | tail -5`
Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/execute/cdp.ts
git commit -m "feat(api): cdp aiStep vision path — screenshot #selector → OCR → fill #output"
```

---

## Task 13: StepEditModal 使用边界 + 拆条提示

**Files:**
- Modify: `apps/web/src/components/StepEditModal.tsx`

- [ ] **Step 1: 加使用边界 state**

打开 `apps/web/src/components/StepEditModal.tsx`，在 `instruction` state 旁追加：

```ts
const [showBoundary, setShowBoundary] = useState(false);
const splitPreview = countNumberedSegments(instruction);

function countNumberedSegments(text: string): number {
  const lines = text.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (/^[ \t]*\d+[.\、][ \t]+\S+/.test(line)) count++;
  }
  return count;
}
```

- [ ] **Step 2: 在 aiStep 编辑区加提示 UI**

把 aiStep 编辑区：

```tsx
{kind === 'aiStep' && (
  <label style={labelStyle}>
    自然语言指令（保存后自动编译）
    <textarea style={{ ...inputStyle, fontFamily: 'inherit' }} rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
  </label>
)}
```

替换成：

```tsx
{kind === 'aiStep' && (
  <div className="flex flex-col gap-2">
    <label style={labelStyle}>
      自然语言指令（保存后自动编译）
      <textarea style={{ ...inputStyle, fontFamily: 'inherit' }} rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="可用 #cssSelector 引用页面元素，例: 识别图片 #captchaImg 并输入到 #captchaInput" />
    </label>
    {splitPreview >= 2 && (
      <p className="text-[11px]" style={{ color: 'var(--color-accent)' }}>
        检测到 {splitPreview} 条编号，保存时将自动拆为 {splitPreview} 条独立智能步骤
      </p>
    )}
    <button
      onClick={() => setShowBoundary((v) => !v)}
      style={{ fontSize: 11, padding: '4px 8px', borderRadius: 5, cursor: 'pointer', border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-muted)', alignSelf: 'flex-start' }}
      type="button"
    >
      {showBoundary ? '收起使用边界提示' : '查看使用边界'}
    </button>
    {showBoundary && (
      <div className="text-[11px] flex flex-col gap-1" style={{ color: 'var(--color-foreground-muted)' }}>
        <p>• 智能步骤适合复杂页面、动态选择、第一条结果等场景。</p>
        <p>• 不建议用于登录、支付、删除审批等高风险路径，也不用于发布准入的关键确定性步骤。</p>
        <p>• 强对抗验证码（滑块、点选、行为验证）不适用；仅适合测试环境中的简单图片验证码。</p>
        <p>• 关键结果请使用文本断言 / JSON 断言，不要把验证全部塞进智能步骤。</p>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 3: 运行 typecheck**

Run: `pnpm --filter @itest/web typecheck 2>&1 | tail -10`
Expected: exit 0。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/StepEditModal.tsx
git commit -m "feat(web): StepEditModal — aiStep boundary hint + split preview"
```

---

## Task 14: 录制 popup 加 #cssSelector 提示

**Files:**
- Modify: `apps/recorder/popup/panel.js`

- [ ] **Step 1: 改 ai 模式 hint 文案**

打开 `apps/recorder/popup/panel.js`，把 ai 模式 hint：

```js
    hint: '描述要执行的操作，保存用例时会编译成具体步骤：',
```

替换成：

```js
    hint: '描述要执行的操作，可用 #cssSelector 引用页面元素（如识别图片 #captchaImg），保存用例时会编译成具体步骤：',
```

- [ ] **Step 2: 提交**

```bash
git add apps/recorder/popup/panel.js
git commit -m "feat(recorder): popup ai-mode hint mentions #cssSelector placeholders"
```

---

## Task 15: 收尾验证

**Files:** 无

- [ ] **Step 1: 运行整个 monorepo verify**

Run: `pnpm verify 2>&1 | tail -30`
Expected：
- `apps/api/test/aiStepSplit.test.ts` 6 个用例全绿
- `apps/api/test/aiStepVision.test.ts` 6 个用例全绿
- `apps/api/test/aiStepCompile.test.ts` 含新增 fallback + vision 用例全绿
- `apps/api/test/llm-vision.test.ts`（若新增）全绿
- `apps/api/test/cases.test.ts` 含 PUT split + fallback 用例全绿
- `apps/api/test/execute-cdp.test.ts` 含 phase4 aiStep vision 用例全绿
- `apps/web` / `apps/recorder` / `packages/shared` 无回归

- [ ] **Step 2: 确认无未追踪改动**

Run: `git status`
Expected: `nothing to commit, working tree clean`。

- [ ] **Step 3: 总结性 commit（如 lint/typecheck 有 autofix）**

```bash
git diff --check || true
git status
# 若有自动修复则提交
git add -u
git diff --cached --quiet || git commit -m "chore: ai-step v2 lint + typecheck autofixes"
```

---

## 自审记录

- **Spec 覆盖**：
  - 拆条 → Task 1, 2, 9, 10
  - 兜底 → Task 7, 8, 9, 10
  - 使用边界 UI → Task 13
  - 视觉语法占位符 → Task 3, 4, 11, 12
  - OPENAI / ANTHROPIC 双 provider vision → Task 5, 6
  - 视觉 dispatch 验证码场景 → Task 11, 12
  - 录制 prompt 提示 → Task 14
- **占位扫描**：无 TBD / TODO / "fill in details"；每个代码块完整。
- **类型一致性**：`LLMRequest` / `LLMResult` 在五个文件统一；`planVision` 返回值在 aiStepCompile / cdp 共享；`splitAiStepsInPlace` 入参形状在 steps.ts POST / PUT 两处一致。
- **范围确认**：单 spec 双阶段，Task 切分清晰；Task 11–12 把视觉 dispatch 与测试同步提交，避免 ExecContext 接口不一致。