import Anthropic from '@anthropic-ai/sdk';
import type { LLMClient, LLMCompleteResult, LLMConfig, LLMMessage, LLMRequest, LLMResult } from './llm-client.js';
import { tryParseJson } from './llm-client.js';
import { langDirective } from './langDirective.js';

/** 滚动缓存断点：system 与最后一条消息各打一个。缓存按前缀匹配，断点只打在
 *  system 上时，多轮累积的前缀从第 2 轮起全部 miss（2026-10-14 网关实测 2%）；
 *  打在最后一条消息上后命中率 86~94%。低于 1024 token 的前缀会被忽略，不报错。 */
const EPHEMERAL = { type: 'ephemeral' } as const;

function buildMessages(req: LLMRequest): Anthropic.MessageParam[] {
  const msgs: LLMMessage[] = req.messages ?? [
    {
      role: 'user',
      content: [
        ...(req.image ? [{ type: 'image' as const, base64: req.image.base64, mime: req.image.mime }] : []),
        { type: 'text' as const, text: req.userMessage },
      ],
    },
  ];
  const last = msgs.length - 1;
  return msgs.map((m, i) => ({
    role: m.role,
    content: m.content.map((b, bi) => {
      // 滚动断点：打在最后一条消息的最后一个 block 上（system 上的那个断点
      // 只覆盖 system，不覆盖逐轮增长的历史）。
      const cc = i === last && bi === m.content.length - 1 ? { cache_control: EPHEMERAL } : {};
      return b.type === 'image'
        ? { type: 'image' as const, source: { type: 'base64' as const, media_type: b.mime, data: b.base64 }, ...cc }
        : { type: 'text' as const, text: b.text, ...cc };
    }),
  }));
}

export class AnthropicClient implements LLMClient {
  provider = 'anthropic' as const;
  private client: Anthropic;
  constructor(private cfg: LLMConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  }
  async complete(req: LLMRequest): Promise<LLMResult> {
    const model = this.cfg.model || 'claude-sonnet-4-6';
    const systemPrompt = req.lang ? `${req.systemPrompt}\n${langDirective(req.lang)}` : req.systemPrompt;
    const t0 = Date.now();
    const resp = await this.client.messages.create({
      model,
      max_tokens: 4096,
      system: [{ type: 'text', text: systemPrompt || 'You are a helpful assistant. Reply with JSON only.', cache_control: EPHEMERAL }],
      messages: buildMessages(req),
    });
    const durationMs = Date.now() - t0;
    // 网关安全策略静默拦截时可能返回 200 但无 content（output_tokens 0、无 stop_reason）。
    // 不防守会让下面 .filter 抛裸 TypeError，且被 failureClassifier 的 SlowLoad 兜底吞掉。
    if (!Array.isArray(resp.content)) {
      const err = new Error(
        `LLM 网关返回空响应(无 content,可能被安全策略静默拦截):provider=${this.provider},model=${model},output_tokens=${resp.usage?.output_tokens ?? 0},input_tokens=${resp.usage?.input_tokens ?? 0},durationMs=${durationMs}`,
      );
      err.name = 'LLMProviderError';
      throw err;
    }
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = tryParseJson(text);
    const base: LLMCompleteResult = json ? { kind: 'json', value: json } : { kind: 'text', value: text };
    // promptTokens 只含本次新计算的 token；命中缓存的部分单列在 cacheReadTokens，
    // 两者相加才是真实计费量（报告据此展示缓存命中，避免"token 变少"被误读为省了 prompt）。
    const usage = {
      promptTokens: resp.usage?.input_tokens ?? 0,
      completionTokens: resp.usage?.output_tokens ?? 0,
      cacheReadTokens: resp.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: resp.usage?.cache_creation_input_tokens ?? 0,
    };
    const hasImage = req.image ? true : (req.messages?.some((m) => m.content.some((b) => b.type === 'image')) ?? false);
    return { ...base, provider: 'anthropic', vision: hasImage, usage, durationMs, model };
  }
}
