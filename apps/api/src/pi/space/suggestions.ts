/**
 * Suggested follow-up generation: after an AI answer lands, take the thread's server-side transcript
 * (pi session.messages, with the AI's full text), call a lightweight LLM once, and produce 3 items of
 * "what the user will most likely ask next".
 *
 * Design constraints:
 * - Suggestions are a nice-to-have: generation-type failures (timeout/bad output) fall back to an empty
 *   list and never break the conversation flow; deterministic failures (LLM unconfigured / thread has no
 *   active session) surface as HttpError so the frontend can show a distinct hint.
 * - The transcript comes from the server's session.messages, not the request body: in react-pi's
 *   frontend messages, tool results have been truncated by truncateTextForDisplay — generating from
 *   truncated text yields low-quality suggestions; the server is the full-text source of truth.
 */
import { logger } from '../../logger.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { ENV_BY_PROVIDER, readLlmConfig, synthesizeModel } from '../modelBridge.js';
import { getSpaceThreadView } from './session.js';

const COUNT = 3;
/** Transcript budget (characters): enough to cover the most recent few Q&A rounds, without turning the generation request itself into a long-context call. */
const TRANSCRIPT_CHAR_BUDGET = 6_000;
/** Fallback timeout for a single LLM call: AbortController is not necessarily honored end-to-end by provider adapters; racing directly is more robust. */
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

/** Defensive read of pi AgentSession.messages: keep only text parts of user/assistant messages (tool calls/images skipped);
 *  for assistant segments take the last one (a loop session round may have multiple segments; the last is the body actually shown to the user). */
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
  // Budget accumulates from newest to oldest; whole lines over budget are dropped (line granularity, never half a sentence).
  const kept: string[] = [];
  let budget = TRANSCRIPT_CHAR_BUDGET;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.length > budget) break;
    budget -= lines[i]!.length;
    kept.unshift(lines[i]!);
  }
  return kept.join('\n');
}

/** Parse model output: split by lines, strip numbering/bullets/quote wrapping, take the first 3 non-empty. */
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

/** Per-thread concurrency dedup (two open pages / repeated triggers share one generation); cleared as soon as it ends —
 *  suggestions only mean something right after an answer lands; reusing stale ones across rounds misleads. HttpError (unconfigured/no session) surfaces; other failures fall back to []. */
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
  // With no active session (none after a process restart until a new message is sent) there is no server transcript to read — deterministic 404, silent on the frontend.
  if (!view) throw new HttpError(404, 'not_found', 'thread session not found');
  const transcript = buildTranscript(view.session.messages);
  // An empty transcript (thread created but no message sent yet) is not worth an error / a model call: no suggestions, period.
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
