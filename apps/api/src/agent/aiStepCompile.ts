import { StepAction, type StepAction as StepActionType } from '@itest/shared';
import { resolveLlmClient } from './llmSettings.js';
import type { LLMClient } from './llm-client.js';
import { planVision } from './aiStepVision.js';

const SYSTEM_PROMPT = `你是测试自动化步骤编译器。把用户的自然语言操作指令编译为具体的 JSON 步骤数组。
只输出 JSON：{"steps": [...]}，不要输出其他内容。
每个步骤形如 {"kind": "...", ...}，允许的 kind：
navigate {url} | click {locator} | fill {locator, value} | hover {locator} |
waitFor {locator, timeoutMs?} | assertText {locator, equals} | assertVisible {locator} |
check {locator, checked} | select {locator, value} | extract {locator, varName}。
locator 是 [{"strategy": "role|text|testId|css|xpath", "value": "..."}] 数组，优先使用 role 和 text。
不要输出 aiStep kind。`;

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

/** 就地编译步骤数组里的 aiStep；返回编译失败的 index 列表。不抛错、不阻塞保存。 */
export async function compileAiStepsInPlace(
  steps: Array<{ action: unknown; url?: string; name?: string }>,
  client?: LLMClient,
): Promise<number[]> {
  const failed: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i]!.action as { kind?: string; instruction?: string; compiled?: unknown };
    if (a?.kind !== 'aiStep') continue;
    try {
      a.compiled = await compileAiStep(a.instruction ?? '', { url: steps[i]!.url, name: steps[i]!.name }, client);
    } catch {
      a.compiled = null;
      failed.push(i);
    }
  }
  return failed;
}
