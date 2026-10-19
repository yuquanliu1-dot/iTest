/**
 * 推荐追问生成:AI 回答落定后,拿该线程的服务端转写(pi session.messages,含 AI 全文)
 * 调一次轻量 LLM,产出 3 条「用户下一句大概会问什么」。
 *
 * 设计约束:
 * - 建议是锦上添花:生成类失败(超时/坏输出)兜底空列表,绝不打断对话流;
 *   确定性失败(LLM 未配置/线程无活跃会话)按 HttpError 透出,前端可区分提示。
 * - 转写取服务端 session.messages 而非请求入参:前端 react-pi 的消息里工具结果被
 *   truncateTextForDisplay 截过,拿截断文本生成会得到低质建议;服务端是全文真源。
 */
import { logger } from '../../logger.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { ENV_BY_PROVIDER, readLlmConfig, synthesizeModel } from '../modelBridge.js';
import { getSpaceThreadView } from './session.js';

const COUNT = 3;
/** 转写预算(字符)。够覆盖最近几轮问答,又不至于让生成请求本身变成长上下文调用。 */
const TRANSCRIPT_CHAR_BUDGET = 6_000;
/** 单次 LLM 调用的兜底超时:AbortController 未必被供应商适配器全程遵守,直接 races 更稳。 */
const LLM_TIMEOUT_MS = 12_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`suggestion llm timeout ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** pi AgentSession.messages 的防御式读取:只取 user/assistant 的 text part(工具调用/图片跳过),
 *  assistant 段取末条(循环会话里一轮可能有多段,最后一段才是给用户看的正文)。 */
export function buildTranscript(messages: readonly unknown[]): string {
  const lines: string[] = [];
  let lastAssistant = '';
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown };
    if (typeof m.role !== 'string') continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        const p = part as { type?: unknown; text?: unknown };
        if (p?.type === 'text' && typeof p.text === 'string') text += p.text;
      }
    }
    text = text.trim();
    if (!text) continue;
    if (m.role === 'user') { lines.push(`用户: ${text}`); lastAssistant = ''; }
    else if (m.role === 'assistant') lastAssistant = text;
  }
  if (lastAssistant) lines.push(`助手: ${lastAssistant}`);
  // 预算从最新往旧累加,整行丢弃超预算的旧行(行粒度,不切半句)。
  const kept: string[] = [];
  let budget = TRANSCRIPT_CHAR_BUDGET;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.length > budget) break;
    budget -= lines[i]!.length;
    kept.unshift(lines[i]!);
  }
  return kept.join('\n');
}

/** 解析模型输出:按行拆分,去序号/项目符号/引号包裹,取前 3 条非空。 */
export function parseSuggestionLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const s = raw
      .trim()
      .replace(/^[-*•]\s*/, '')
      .replace(/^\d+[.、)]\s*/, '')
      .replace(/^["「『]*/, '')
      .replace(/["」』]*$/, '')
      .trim();
    if (!s) continue;
    out.push(s);
    if (out.length >= COUNT) break;
  }
  return out;
}

const inflight = new Map<string, Promise<string[]>>();

/** 同线程并发去重(双开页面/重复触发共用一次生成);结束即清——建议只在「回答刚落定」
 *  时有意义,跨轮复用旧建议反而误导。HttpError(未配置/无会话)透出;其余失败兜底 []。 */
export function generateSpaceSuggestionsOnce(threadId: string): Promise<string[]> {
  const pending = inflight.get(threadId);
  if (pending) return pending;
  const p = generateSpaceSuggestions(threadId)
    .catch((e: unknown) => {
      if (e instanceof HttpError) throw e;
      logger.warn({ err: e, threadId }, 'suggestion generation failed');
      return [];
    })
    .finally(() => inflight.delete(threadId));
  inflight.set(threadId, p);
  return p;
}

async function generateSpaceSuggestions(threadId: string): Promise<string[]> {
  const view = getSpaceThreadView(threadId);
  // 无活跃会话(进程重启后未再发消息)时没有服务端转写可读——确定性 404,前端静默。
  if (!view) throw new HttpError(404, 'not_found', 'thread session not found');
  const transcript = buildTranscript(view.session.messages);
  // 空转写(建线程后还没发过消息)不值得报错/调模型:直接没建议。
  if (!transcript) return [];
  const cfg = await readLlmConfig();
  if (!cfg) throw new HttpError(502, 'llm_not_configured', 'LLM 未配置:请先到设置页配置模型');

  const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
  const { completeSimple } = await import('@earendil-works/pi-ai/compat');
  const base = (getBuiltinModel as unknown as (p: string, m: string) => Record<string, unknown> | undefined)(cfg.provider, cfg.model)
    ?? synthesizeModel(cfg.provider, cfg.model, cfg.baseUrl);
  const model = { ...base, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}) } as never;
  const envKey = ENV_BY_PROVIDER[cfg.provider];
  if (envKey && !process.env[envKey]) process.env[envKey] = cfg.apiKey;

  const zh = view.lang === 'zh-CN';
  const system = zh
    ? `你是测试平台的对话助手。根据下面的对话,预测用户接下来最可能发出的 ${COUNT} 条指令(如查询、创建用例、验证、编排计划)。每条一句话、用户口吻、不带序号,只输出这 ${COUNT} 行。`
    : `You are the chat assistant of a test platform. Based on the conversation below, predict the ${COUNT} most likely next user instructions (queries, creating cases, verifying, planning). One sentence each, in the user voice, no numbering, output exactly these ${COUNT} lines.`;
  const promptText = zh ? `${system}\n\n对话:\n${transcript}` : `${system}\n\nConversation:\n${transcript}`;

  const response = await withTimeout(
    completeSimple(model, { messages: [{ role: 'user', content: promptText, timestamp: Date.now() }] }, {
      maxTokens: 300,
      temperature: 0.7,
    }),
    LLM_TIMEOUT_MS,
  );
  if (response.stopReason === 'error') {
    logger.warn({ threadId, error: response.errorMessage }, 'suggestion llm stopped with error');
    return [];
  }
  const text = response.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
  return parseSuggestionLines(text);
}
