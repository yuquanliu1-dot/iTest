import { StepAction, type StepAction as StepActionType } from '@itest/shared';
import { resolveLlmClient } from './llmSettings.js';
import type { LLMClient } from './llm-client.js';
import { planVision } from './aiStepVision.js';
import { logger } from '../logger.js';

const SYSTEM_PROMPT = `你是测试自动化步骤编译器。把用户的自然语言操作指令编译为具体的 JSON 步骤数组。
只输出 JSON：{"steps": [...]}，不要输出其他内容。
每个步骤形如 {"kind": "...", ...}，允许的 kind：
navigate {url} | click {locator} | fill {locator, value} | hover {locator} |
waitFor {locator, timeoutMs?} | assertText {locator, equals} | assertVisible {locator} |
check {locator, checked} | select {locator, value} | extract {locator, varName}。
locator 是 [{"strategy": "...", "value": "..."}] 数组，规则：
- strategy 只能是 "role" | "text" | "testId" | "css" | "xpath"。
- role 的 value 形如 "textbox" 或 "textbox[name='用户名']"。role 必须小写。
- text 的 value 是元素可见文字。
- testId 的 value 是 data-testid 值。
- css 的 value 是 CSS 选择器。
- xpath 的 value 是 xpath 表达式。
- locator 数组里给出多个候选，回放时按顺序探测；至少 1 个。
navigate 的 url 必须是绝对 URL（如 http://localhost:5173/login），不要用相对路径。
value 字段：固定字符串直接给字符串；"Abc@123456" 之类密码占位直接用占位字符串。
不要输出 aiStep kind。`;

const BATCH_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

本次为批量编译：用户消息是编号指令列表，每行形如 "N. 指令: ... | 页面 URL: ..."。
只输出 JSON：{"results": [{"index": N, "steps": [...]}]}，必须覆盖输入的每一个编号；
每个 steps 数组的语义与单条编译相同。`;

/** 批量单次调用打包的指令条数上限（受 provider max_tokens 输出上限约束，避免 JSON 被截断）。 */
const BATCH_CHUNK = 20;

/**
 * 批量编译：把多条指令合并为一次 LLM 调用。返回 0-based 位置 → 编译结果；
 * 缺失/不合法的位置不在返回值里（由调用方逐条回退）。
 * 兼容：provider 返回单条形状 {"steps": [...]} 时视为第 0 条的结果。
 */
export async function compileAiStepsBatch(
  items: Array<{ text: string; url?: string }>,
  client?: LLMClient,
): Promise<Map<number, StepActionType[]>> {
  const llm = client ?? (await resolveLlmClient()).client;
  const userMessage = items
    .map((it, i) => `${i + 1}. 指令: ${it.text}${it.url ? ` | 页面 URL: ${it.url}` : ''}`)
    .join('\n');
  const r = await llm.complete({ systemPrompt: BATCH_SYSTEM_PROMPT, userMessage });
  const out = new Map<number, StepActionType[]>();
  const parseSteps = (raw: unknown): StepActionType[] => {
    const steps: StepActionType[] = [];
    if (!Array.isArray(raw)) return steps;
    for (const item of raw) {
      const p = StepAction.safeParse(item);
      if (p.success && p.data.kind !== 'aiStep') steps.push(p.data);
    }
    return steps;
  };
  if (r.kind === 'json') {
    const results = (r.value as { results?: unknown }).results;
    if (Array.isArray(results)) {
      for (const entry of results) {
        const e = entry as { index?: unknown; steps?: unknown };
        const idx = typeof e.index === 'number' ? e.index - 1 : -1;
        if (idx < 0 || idx >= items.length) continue;
        const steps = parseSteps(e.steps);
        if (steps.length > 0) out.set(idx, steps);
      }
      return out;
    }
    // 单条形状兜底：模型忽略批量格式时至少救回第 0 条
    const single = parseSteps((r.value as { steps?: unknown }).steps);
    if (single.length > 0 && items.length > 0) out.set(0, single);
  }
  return out;
}

/**
 * 把一条自然语言指令编译为具体 DSL 步骤。
 * instruction 为空时回退用 step.name 作指令（userMessage 标记 [fallback-by-name]）。
 * LLM 输出经 zod 校验，全部不合法时带提示重试一次；仍失败则抛错（调用方决定容错策略）。
 */
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
  if (!fallback) throw new Error('编译失败: AI 步骤缺少指令且无步骤名兜底');
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

/** 就地编译步骤数组里的 aiStep；返回编译失败的 index 列表。不抛错、不阻塞保存。
 * 指令按 BATCH_CHUNK 分块、块间并发走批量编译（单块一次 LLM 调用）；
 * 块失败或缺项的指令回退到单条编译（保留其一次重试语义）。 */
export async function compileAiStepsInPlace(
  steps: Array<{ action: unknown; url?: string; name?: string }>,
  client?: LLMClient,
  urlResolver?: (name?: string) => string | undefined,
): Promise<number[]> {
  let llm: LLMClient | null = client ?? null;
  if (!llm) {
    try {
      llm = (await resolveLlmClient()).client;
    } catch (e) {
      logger.warn({ err: e }, 'llm unresolved; skip ai-step compile');
    }
  }

  const failed: number[] = [];
  const pending: Array<{ index: number; text: string; url?: string; name?: string }> = [];
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i]!.action as { kind?: string; instruction?: string; compiled?: unknown };
    if (a?.kind !== 'aiStep') continue;
    let text: string;
    try {
      text = buildEffectiveInstruction(steps[i]!, a.instruction ?? '').text;
    } catch (e) {
      logger.warn({ err: e, instruction: a.instruction, index: i }, 'ai-step compile failed');
      a.compiled = null;
      failed.push(i);
      continue;
    }
    pending.push({ index: i, text, url: steps[i]!.url ?? urlResolver?.(steps[i]!.name), name: steps[i]!.name });
  }
  if (!llm || pending.length === 0) {
    for (const p of pending) {
      (steps[p.index]!.action as { compiled: unknown }).compiled = null;
      failed.push(p.index);
    }
    return failed;
  }

  const chunks: Array<typeof pending> = [];
  for (let i = 0; i < pending.length; i += BATCH_CHUNK) chunks.push(pending.slice(i, i + BATCH_CHUNK));
  await Promise.all(
    chunks.map(async (chunk) => {
      let batch = new Map<number, StepActionType[]>();
      try {
        batch = await compileAiStepsBatch(chunk, llm!);
      } catch {
        // 整块失败 → 全部逐条回退
      }
      for (let k = 0; k < chunk.length; k++) {
        const item = chunk[k]!;
        const a = steps[item.index]!.action as { compiled?: unknown };
        const got = batch.get(k);
        if (got) {
          a.compiled = got;
          continue;
        }
        try {
          a.compiled = await compileAiStep(item.text, { url: item.url, name: item.name }, llm!);
        } catch (e) {
          logger.warn({ err: e, instruction: item.text, index: item.index }, 'ai-step compile failed');
          a.compiled = null;
          failed.push(item.index);
        }
      }
    }),
  );
  return failed.sort((a, b) => a - b);
}
