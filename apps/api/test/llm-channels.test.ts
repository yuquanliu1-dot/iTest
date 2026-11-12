import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import type { LLMClient, LLMRequest, LLMResult } from '../src/agent/llm-client.js';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  // This file indirectly holds db/client.js's singleton pool via llmSettings.js — close it before stopping the container (same handling as pi-model-bridge.test.ts).
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE settings`);
});

// ── VisionRoutingClient pure unit tests (fake dual clients, no db/network) ──

function fakeClient(provider: 'openai' | 'anthropic' | 'google', tag: string): LLMClient & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  return {
    provider,
    calls,
    complete: async (req: LLMRequest) => {
      calls.push(req);
      return { kind: 'text', value: tag, provider, vision: false } as LLMResult;
    },
  };
}

describe('VisionRoutingClient', () => {
  it('单图字段 image → 路由 vision，结果原样透传', async () => {
    const { VisionRoutingClient } = await import('../src/agent/llmSettings.js');
    const main = fakeClient('openai', 'main');
    const vision = fakeClient('anthropic', 'vision');
    const client = new VisionRoutingClient(main, vision);
    const req: LLMRequest = { systemPrompt: 's', userMessage: 'u', image: { base64: 'xx', mime: 'image/png' } };
    const r = await client.complete(req);
    expect(r.value).toBe('vision');
    expect(main.calls).toHaveLength(0);
    expect(vision.calls).toHaveLength(1);
    expect(vision.calls[0]).toBe(req);
  });

  it('messages 含 image block → 路由 vision', async () => {
    const { VisionRoutingClient } = await import('../src/agent/llmSettings.js');
    const main = fakeClient('openai', 'main');
    const vision = fakeClient('anthropic', 'vision');
    const client = new VisionRoutingClient(main, vision);
    const req: LLMRequest = {
      systemPrompt: 's',
      userMessage: '',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', base64: 'xx', mime: 'image/jpeg' }] },
      ],
    };
    expect((await client.complete(req)).value).toBe('vision');
    expect(main.calls).toHaveLength(0);
  });

  it('纯文本 → 路由 main', async () => {
    const { VisionRoutingClient } = await import('../src/agent/llmSettings.js');
    const main = fakeClient('openai', 'main');
    const vision = fakeClient('anthropic', 'vision');
    const client = new VisionRoutingClient(main, vision);
    const r = await client.complete({ systemPrompt: 's', userMessage: 'hello' });
    expect(r.value).toBe('main');
    expect(vision.calls).toHaveLength(0);
  });

  it('provider getter 返回 main 的 provider', async () => {
    const { VisionRoutingClient } = await import('../src/agent/llmSettings.js');
    const client = new VisionRoutingClient(fakeClient('openai', 'm'), fakeClient('anthropic', 'v'));
    expect(client.provider).toBe('openai');
  });
});

// ── resolveLlmClient channel resolution (reads the settings table) ──

async function insertSettings(rows: Array<[string, unknown]>) {
  for (const [key, value] of rows) {
    await pool.query(`INSERT INTO settings(key, value) VALUES ($1, $2)`, [key, JSON.stringify(value)]);
  }
}

const CHANNELS = [
  { id: 'ch-a', name: '文本渠道', provider: 'anthropic', apiKey: 'sk-aaa', model: 'claude-sonnet-4-6', baseUrl: 'https://gw.example.com', maxTokens: 16384 },
  { id: 'ch-b', name: '视觉渠道', provider: 'openai', apiKey: 'sk-bbb', model: 'qwen-vl' },
];

describe('resolveLlmClient 渠道解析', () => {
  it('新结构生效：config 来自默认渠道（含 maxTokens/baseUrl）', async () => {
    await insertSettings([
      ['llm_channels', CHANNELS],
      ['llm_default_channel', 'ch-a'],
    ]);
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    const { config, client } = await resolveLlmClient();
    expect(config).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-aaa',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://gw.example.com',
      maxTokens: 16384,
    });
    expect(client.constructor.name).not.toBe('VisionRoutingClient');
  });

  it('llm_default_channel 缺失 → 取 channels[0]', async () => {
    await insertSettings([['llm_channels', CHANNELS]]);
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    const { config } = await resolveLlmClient();
    expect(config.apiKey).toBe('sk-aaa');
  });

  it('llm_default_channel 指向不存在的渠道 → 容错取 channels[0]', async () => {
    await insertSettings([
      ['llm_channels', CHANNELS],
      ['llm_default_channel', 'ch-gone'],
    ]);
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    const { config } = await resolveLlmClient();
    expect(config.apiKey).toBe('sk-aaa');
  });

  it('旧版 5 键不再被读取（已由启动迁移折成渠道）→ 抛「尚未配置渠道」', async () => {
    await insertSettings([
      ['llm_provider', 'openai'],
      ['llm_api_key', 'sk-legacy'],
      ['llm_model', 'gpt-4o-mini'],
    ]);
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    await expect(resolveLlmClient()).rejects.toThrow(/尚未配置 LLM 渠道/);
  });

  it('llm_channels 为空数组 → 抛「尚未配置渠道」', async () => {
    await insertSettings([['llm_channels', []]]);
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    await expect(resolveLlmClient()).rejects.toThrow(/尚未配置 LLM 渠道/);
  });

  it('默认渠道缺 apiKey → 抛错', async () => {
    await insertSettings([
      ['llm_channels', [{ ...CHANNELS[0], apiKey: '' }]],
      ['llm_default_channel', 'ch-a'],
    ]);
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    await expect(resolveLlmClient()).rejects.toThrow(/缺少 API Key/);
  });

  it('未配置 → 抛「尚未配置 LLM 渠道」', async () => {
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    await expect(resolveLlmClient()).rejects.toThrow(/尚未配置 LLM 渠道/);
  });
});

describe('resolveLlmClient 视觉渠道', () => {
  it('vision 指向另一渠道 → 返回 VisionRoutingClient，config 仍是默认渠道', async () => {
    await insertSettings([
      ['llm_channels', CHANNELS],
      ['llm_default_channel', 'ch-a'],
      ['llm_vision_channel', 'ch-b'],
    ]);
    const { resolveLlmClient, VisionRoutingClient } = await import('../src/agent/llmSettings.js');
    const { config, client } = await resolveLlmClient();
    expect(config.apiKey).toBe('sk-aaa');
    expect(client).toBeInstanceOf(VisionRoutingClient);
  });

  it('vision 与默认同渠道 → 不包 wrapper', async () => {
    await insertSettings([
      ['llm_channels', CHANNELS],
      ['llm_default_channel', 'ch-a'],
      ['llm_vision_channel', 'ch-a'],
    ]);
    const { resolveLlmClient, VisionRoutingClient } = await import('../src/agent/llmSettings.js');
    const { client } = await resolveLlmClient();
    expect(client).not.toBeInstanceOf(VisionRoutingClient);
  });

  it('vision 指向不存在的渠道 → 忽略', async () => {
    await insertSettings([
      ['llm_channels', CHANNELS],
      ['llm_default_channel', 'ch-a'],
      ['llm_vision_channel', 'ch-gone'],
    ]);
    const { resolveLlmClient, VisionRoutingClient } = await import('../src/agent/llmSettings.js');
    const { client } = await resolveLlmClient();
    expect(client).not.toBeInstanceOf(VisionRoutingClient);
  });

  it('vision 渠道缺 apiKey → 忽略', async () => {
    await insertSettings([
      ['llm_channels', [CHANNELS[0], { ...CHANNELS[1], apiKey: '' }]],
      ['llm_default_channel', 'ch-a'],
      ['llm_vision_channel', 'ch-b'],
    ]);
    const { resolveLlmClient, VisionRoutingClient } = await import('../src/agent/llmSettings.js');
    const { client } = await resolveLlmClient();
    expect(client).not.toBeInstanceOf(VisionRoutingClient);
  });

  it('只有旧键（无渠道）→ 抛错，不包 wrapper', async () => {
    await insertSettings([
      ['llm_provider', 'openai'],
      ['llm_api_key', 'sk-legacy'],
      ['llm_model', 'gpt-4o-mini'],
      ['llm_vision_channel', 'ch-b'],
    ]);
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    await expect(resolveLlmClient()).rejects.toThrow(/尚未配置 LLM 渠道/);
  });
});

describe('parseChannels / maskApiKey / parseMaxTokens', () => {
  it('parseChannels 过滤畸形元素（非数组/缺 id/provider 非法）', async () => {
    const { parseChannels } = await import('../src/agent/llmSettings.js');
    expect(parseChannels('not-array')).toEqual([]);
    expect(
      parseChannels([
        { id: 'ok', name: 'n', provider: 'openai', apiKey: 'k', model: 'm' },
        { id: '', provider: 'openai' },
        { id: 'x', provider: 'bogus' },
        null,
        'str',
      ]),
    ).toEqual([{ id: 'ok', name: 'n', provider: 'openai', apiKey: 'k', model: 'm' }]);
  });

  it('parseMaxTokens：正整数生效，乱码/0/负数/小数忽略', async () => {
    const { parseMaxTokens } = await import('../src/agent/llmSettings.js');
    expect(parseMaxTokens('16384')).toBe(16384);
    expect(parseMaxTokens(8192)).toBe(8192);
    expect(parseMaxTokens('abc')).toBeUndefined();
    expect(parseMaxTokens('0')).toBeUndefined();
    expect(parseMaxTokens('-5')).toBeUndefined();
    expect(parseMaxTokens('1.5')).toBeUndefined();
    expect(parseMaxTokens(null)).toBeUndefined();
  });

  it('maskApiKey：长 key 留首尾 4 位，短 key 全掩，空串返回空', async () => {
    const { maskApiKey } = await import('../src/agent/llmSettings.js');
    expect(maskApiKey('sk-secret-abcd1234')).toBe('sk-s****1234');
    expect(maskApiKey('short')).toBe('****');
    expect(maskApiKey('')).toBe('');
  });
});
