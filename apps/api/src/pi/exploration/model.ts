/**
 * Model resolution and capability probes for exploration sessions (pi chain).
 *
 * Channel selection: the vision channel takes precedence (exploration is a look-at-image-and-identify task);
 * without a configured vision channel it falls back to the default channel. synthesizeModel honestly declares
 * input:['text','image'] — but the gateway-alias silently stripping images incident (image replaced by placeholder
 * text) cannot be prevented by a declaration; it is proven by the vision probe reading back a unique code. If the
 * code cannot be read → the session degrades to plain-text element-list mode (tools attach no images), never silently
 * letting the model spin against stripped images.
 *
 * Probes run before the start: when the channel does not support tool calls, the session fails immediately with an
 * actionable error, instead of burning the full turn budget before discovering the model could only talk all along
 * (2026-11-11 memory item).
 */
import type { Page } from 'playwright-core';
import { inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { settings } from '../../db/schema.js';
import { CHANNEL_KEYS, parseChannels } from '../../agent/llmSettings.js';
import { ENV_BY_PROVIDER, synthesizeModel } from '../modelBridge.js';
import { logger } from '../../logger.js';

/** pi Model descriptor for exploration + channel name (for logs/usage stats). */
export interface ExplorationModel {
  model: Record<string, unknown>;
  channelName: string;
  provider: string;
}

/** Reads the channel from settings (vision channel first, default channel otherwise) → pi Model descriptor + injects the provider env key. */
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
 * Tool-calling probe: hands the model a probe tool and asks it to call it. Returns null = pass; non-null = actionable error text.
 * The criterion = the response contains a toolCall block — channels without native tool calling (plain-text
 * completion gateways) answer in plain text, which is exactly the shape to intercept. A probe failure must fail the
 * whole session immediately, without burning the turn budget.
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

/** Vision probe unique code: the text rendered on the probe image; reading it back proves the model truly saw the image. */
const VISION_PROBE_CODE = 'PX-7349';

/**
 * Vision probe: the browser renders a page containing the unique code → screenshot → ask the model to read the code.
 * Returns null = vision available; non-null = degradation explanation (unreadable = gateway alias silently strips
 * images / no vision capability → text mode).
 * Degradation is not failure — the exploration runs as usual; tools just attach no images.
 */
export async function visionProbeFailure(page: Page, model: Record<string, unknown>): Promise<string | null> {
  const { complete } = await import('@earendil-works/pi-ai/compat');
  try {
    // setContent instead of a data: URL — an unescaped data URL (bare spaces/quotes) renders as a blank document in
    // chromium; proven on prod228: the screenshot came back all white → the model faithfully read an empty code →
    // the session was wrongly degraded to plain-text mode.
    await page.setContent(
      `<body style="margin:0"><div style="font:700 64px monospace;color:#000;background:#fff;padding:40px">${VISION_PROBE_CODE}</div></body>`,
      { timeout: 10_000, waitUntil: 'load' },
    );
    // 15s: a cold-started headless browser's first screenshot can be far slower than 5s (prod228 proved a 5s timeout wrongly degraded to text mode).
    const buf = await page.screenshot({ timeout: 15_000, type: 'png' });
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
      // 500: reasoning models burn thinking budget first when hesitating over an image; at 100 the reply hits the
      // length cap and comes back empty → the probe misjudges "no vision". A few hundred extra tokens cost far less
      // than one wrongful degradation.
      { maxTokens: 500 },
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
