import { StepAction, type StepAction as StepActionType } from '@itest/shared';
import { resolveLlmClient } from './llmSettings.js';
import type { LLMClient } from './llm-client.js';

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
 * LLM 输出经 zod 校验，全部不合法时带提示重试一次；仍失败则抛错（调用方决定容错策略）。
 */
export async function compileAiStep(
  instruction: string,
  ctx: { url?: string } = {},
  client?: LLMClient,
): Promise<StepActionType[]> {
  const llm = client ?? (await resolveLlmClient()).client;
  const attempt = async (hint: string): Promise<StepActionType[]> => {
    const userMessage = [
      'ai-step',
      ctx.url ? `页面 URL: ${ctx.url}` : '',
      `指令: ${instruction}`,
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
  throw new Error(`AI 步骤编译失败: ${instruction.slice(0, 50)}`);
}

/** 就地编译步骤数组里的 aiStep；返回编译失败的 index 列表。不抛错、不阻塞保存。 */
export async function compileAiStepsInPlace(
  steps: Array<{ action: unknown; url?: string }>,
  client?: LLMClient,
): Promise<number[]> {
  const failed: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i]!.action as { kind?: string; instruction?: string; compiled?: unknown };
    if (a?.kind !== 'aiStep') continue;
    try {
      a.compiled = await compileAiStep(a.instruction ?? '', { url: steps[i]!.url }, client);
    } catch {
      a.compiled = null;
      failed.push(i);
    }
  }
  return failed;
}
