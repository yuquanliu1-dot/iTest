import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

export type LLMProvider = 'mock' | 'openai' | 'anthropic' | 'google';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
}

export type LLMCompleteResult =
  | { kind: 'json'; value: Record<string, unknown> }
  | { kind: 'text'; value: string };

export interface LLMClient {
  provider: LLMProvider;
  complete(req: { systemPrompt: string; userMessage: string }): Promise<LLMCompleteResult>;
}

export function listProviders(): LLMProvider[] {
  return ['mock', 'openai', 'anthropic', 'google'];
}

class MockClient implements LLMClient {
  provider = 'mock' as const;
  async complete({ userMessage }: { systemPrompt: string; userMessage: string }): Promise<LLMCompleteResult> {
    if (userMessage.includes('ai-step')) {
      return {
        kind: 'json',
        value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] },
      };
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
      return {
        kind: 'json',
        value: {
          steps: [
            { order: 99, action: { kind: 'assertVisible', locator: [{ strategy: 'role', value: 'main' }] } },
          ],
        },
      };
    }
    return { kind: 'text', value: '[mock] no specific response for this input' };
  }
}

/** 解析模型输出为 JSON：优先直接 parse，去掉 ```json 围栏、回退提取首段 {...}。 */
function tryParseJson(raw: string): Record<string, unknown> | null {
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

class OpenAIClient implements LLMClient {
  provider = 'openai' as const;
  private client: OpenAI;
  constructor(private cfg: LLMConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey });
  }
  async complete({ systemPrompt, userMessage }: { systemPrompt: string; userMessage: string }): Promise<LLMCompleteResult> {
    const model = this.cfg.model || 'gpt-4o-mini';
    const resp = await this.client.chat.completions.create({
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: userMessage },
      ],
      response_format: { type: 'json_object' as const },
      temperature: 0.2,
    });
    const text = resp.choices[0]?.message?.content ?? '';
    const json = tryParseJson(text);
    return json ? { kind: 'json', value: json } : { kind: 'text', value: text };
  }
}

class AnthropicClient implements LLMClient {
  provider = 'anthropic' as const;
  private client: Anthropic;
  constructor(private cfg: LLMConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey });
  }
  async complete({ systemPrompt, userMessage }: { systemPrompt: string; userMessage: string }): Promise<LLMCompleteResult> {
    const model = this.cfg.model || 'claude-sonnet-4-6';
    const resp = await this.client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt || 'You are a helpful assistant. Reply with JSON only.',
      messages: [{ role: 'user', content: userMessage }],
    });
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = tryParseJson(text);
    return json ? { kind: 'json', value: json } : { kind: 'text', value: text };
  }
}

class GoogleClient implements LLMClient {
  provider = 'google' as const;
  private client: GoogleGenerativeAI;
  constructor(private cfg: LLMConfig) {
    this.client = new GoogleGenerativeAI(cfg.apiKey);
  }
  async complete({ systemPrompt, userMessage }: { systemPrompt: string; userMessage: string }): Promise<LLMCompleteResult> {
    const model = this.cfg.model || 'gemini-2.0-flash';
    const m = this.client.getGenerativeModel({
      model,
      systemInstruction: systemPrompt || 'You are a helpful assistant. Reply with JSON only.',
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    });
    const resp = await m.generateContent(userMessage);
    const text = resp.response.text();
    const json = tryParseJson(text);
    return json ? { kind: 'json', value: json } : { kind: 'text', value: text };
  }
}

export function getLlmClient(config: LLMConfig): LLMClient {
  switch (config.provider) {
    case 'mock': return new MockClient();
    case 'openai': return new OpenAIClient(config);
    case 'anthropic': return new AnthropicClient(config);
    case 'google': return new GoogleClient(config);
  }
}