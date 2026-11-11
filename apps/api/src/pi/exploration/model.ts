/**
 * 探索会话（pi 链路）的模型解析与能力探针。
 *
 * 渠道选择：视觉渠道优先（探索是看图指认的任务），未配视觉渠道回落默认渠道。
 * synthesizeModel 已诚实声明 input:['text','image']——但网关别名静默剥图的事故
 * （图被换成占位文本）不能靠声明防住，靠视觉探针在读回唯一码上实证；读不出 →
 * 会话降级为纯文本元素清单模式（工具不附图），绝不静默让模型对着一堆剥图空转。
 *
 * 探针在开跑前做：渠道不支持工具调用时立刻给可行动报错并终止会话，
 * 而不是让它跑满轮次预算后才发现模型全程只会说话（2026-11-11 记忆项）。
 */
import type { Page } from 'playwright-core';
import { inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { settings } from '../../db/schema.js';
import { CHANNEL_KEYS, parseChannels } from '../../agent/llmSettings.js';
import { ENV_BY_PROVIDER, synthesizeModel } from '../modelBridge.js';
import { logger } from '../../logger.js';

/** 探索用 pi Model 描述符 + 渠道名（日志/用量统计用）。 */
export interface ExplorationModel {
  model: Record<string, unknown>;
  channelName: string;
  provider: string;
}

/** 从 settings 读渠道（视觉渠道优先，未配则默认渠道）→ pi Model 描述符 + 注入 provider env key。 */
export async function resolveExplorationModel(): Promise<ExplorationModel> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [CHANNEL_KEYS.channels, CHANNEL_KEYS.defaultChannel, CHANNEL_KEYS.visionChannel]));
  const map = new Map(rows.map((r) => [r.key, r.value as unknown]));
  const channels = parseChannels(map.get(CHANNEL_KEYS.channels));
  if (channels.length === 0) {
    throw new Error('尚未配置 LLM 渠道，请在设置中新增渠道');
  }
  const visionId = String(map.get(CHANNEL_KEYS.visionChannel) ?? '');
  const defaultId = String(map.get(CHANNEL_KEYS.defaultChannel) ?? '');
  const vision = channels.find((c) => c.id === visionId && c.apiKey && c.model);
  const channel = vision ?? channels.find((c) => c.id === defaultId) ?? channels[0]!;
  if (!channel.apiKey || !channel.model) {
    throw new Error(`LLM 渠道「${channel.name || channel.id}」缺少 API Key 或模型，请在设置中补全`);
  }
  const envKey = ENV_BY_PROVIDER[channel.provider];
  if (envKey && !process.env[envKey]) process.env[envKey] = channel.apiKey;
  const model = synthesizeModel(channel.provider, channel.model, channel.baseUrl ?? null);
  return { model, channelName: channel.name || channel.id, provider: channel.provider };
}

/**
 * 工具调用探针：给模型一个探针工具并要求调用。返回 null = 通过；非 null = 可行动错误文本。
 * 判据 = 响应含 toolCall 块——不支持原生工具调用的渠道（纯文本补全网关）回的是纯文本，
 * 这正是要拦的形态。探针失败必须立刻失败整个会话，不空跑轮次预算。
 */
export async function toolCallingProbeFailure(model: Record<string, unknown>): Promise<string | null> {
  const { complete, Type } = await import('@earendil-works/pi-ai/compat');
  try {
    const r = await complete(
      model as never,
      {
        systemPrompt: '你是探针。必须调用 report_probe 工具，不要输出任何文本。',
        messages: [{ role: 'user', content: '调用 report_probe 工具，status 参数填 "ok"。', timestamp: Date.now() }],
        tools: [
          { name: 'report_probe', description: '探针工具：调用它即视为支持工具调用', parameters: Type.Object({ status: Type.String() }) },
        ],
      },
      { maxTokens: 200 },
    );
    if (r.stopReason === 'error') return `模型调用失败：${r.errorMessage ?? '未知错误'}`;
    const hasCall = Array.isArray(r.content) && r.content.some((b) => b.type === 'toolCall');
    if (!hasCall) {
      return '当前 LLM 渠道不支持原生工具调用（模型只回文本）——探索式测试需要支持工具调用的模型，请到设置页更换渠道后再建探索会话。';
    }
    return null;
  } catch (e) {
    return `工具调用探针失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 视觉探针唯一码：探针图上渲染的文本，读回即证明模型真看到了图。 */
const VISION_PROBE_CODE = 'PX-7349';

/**
 * 视觉探针：浏览器渲染含唯一码的 data: URL 页面 → 截图 → 问模型读码。
 * 返回 null = 视觉可用；非 null = 降级说明（读不出 = 网关别名静默剥图/无视觉能力 → 文本模式）。
 * 降级不是失败——探索照常跑，只是工具不附图。
 */
export async function visionProbeFailure(page: Page, model: Record<string, unknown>): Promise<string | null> {
  const { complete } = await import('@earendil-works/pi-ai/compat');
  try {
    await page.goto(
      `data:text/html,<body style="margin:0"><div style="font:700 64px monospace;color:#000;background:#fff;padding:40px">${VISION_PROBE_CODE}</div></body>`,
      { timeout: 10_000 },
    );
    const buf = await page.screenshot({ timeout: 5000, type: 'png' });
    const r = await complete(
      model as never,
      {
        systemPrompt: '你是读码器。读出图片里的字符代码，只输出 JSON：{"code":"<字符>"}。',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
              { type: 'text', text: '读出这张图里的字符代码。' },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      { maxTokens: 100 },
    );
    if (r.stopReason === 'error') return `视觉探针调用失败：${r.errorMessage ?? '未知错误'}`;
    const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    if (!text.includes(VISION_PROBE_CODE)) {
      return `模型未能读出探针图上的唯一码（回复：${text.slice(0, 80)}）——该渠道的图像输入未生效（网关别名静默剥图或无视觉能力），探索会话降级为纯文本元素清单模式。`;
    }
    return null;
  } catch (e) {
    logger.warn({ err: e }, 'exploration vision probe error');
    return `视觉探针失败：${e instanceof Error ? e.message : String(e)}`;
  }
}
