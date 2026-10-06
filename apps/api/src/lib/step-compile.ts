import { StepAction } from '@itest/shared';
import { resolveLlmClient } from '../agent/llmSettings.js';
import { STEP_DSL_SPEC } from '../agent/prompts/step-dsl-spec.js';
import { normalizeCompiledStep } from '../pi/tools.js';
import { z } from 'zod';

/**
 * 自然语言指令 → StepAction[] DSL 的轻量编译入口。
 * - 复用 extract-compile 的"轻量、纯 prompt 调用、无工具"模式。
 * - 与 stage-tools 不同：stage-case 由 LLM 在多轮对话里按上下文直接产出 compiled;
 *   本接口是用户主动触发(StepEditDrawer 的"AI 编译"按钮)的"补编译"通道。
 * - 输出归一化:沿用 pi/tools.ts 的 normalizeCompiledStep(空数组→null、locator 形状修复)。
 */
export async function compileStepDsl(
  instruction: string,
  context?: unknown[],
): Promise<StepAction[] | null> {
  const trimmed = instruction.trim();
  if (!trimmed) throw new Error('compile-step: instruction is empty');

  const systemPrompt = `你是 Step DSL 编译助手。用户给你一句中文/英文自然语言步骤描述，你把它编译成 StepAction[] 数组（按回放可识别的 DSL）。
DSL 规格：
${STEP_DSL_SPEC}

要求：
1. 严格输出一个 JSON 对象:{"compiled": <StepAction[]> | null}
   - compiled 是数组;无法编译(太模糊/必须看图才能定位)时填 null。
   - null 与 [] 不同:[] 表示"已编译但为空",会被回放视作未编译;null 表示"放弃",前端会切回自然语言编辑态。
2. locator 必须是数组,形如 [{"strategy":"role","value":"button[name='登录']"}],strategy 只能 role|text|testId|css|xpath;role 的 value 形如 "textbox[name='用户名']" 且必须小写。
3. 优先 role/text 定位;无 context 信息时不要臆造 testId。context(若提供)含本步骤之前的 compiled,可借鉴其 locator 风格。
4. 关键路径末尾用 assertVisible / assertText 收尾;navigate 步骤本身不要补断言。
5. 只能输出 JSON,不要其它内容。`;

  const userParts = [
    `instruction: ${trimmed}`,
  ];
  if (context && context.length > 0) {
    userParts.push(`context(之前的 compiled): ${JSON.stringify(context)}`);
  }
  const userMessage = userParts.join('\n');

  const { client } = await resolveLlmClient();
  const r = await client.complete({ systemPrompt, userMessage });
  if (r.kind !== 'json') {
    throw new Error('compile-step: LLM 输出非 JSON');
  }
  const obj = r.value as { compiled?: unknown };
  if (obj.compiled === null || obj.compiled === undefined) {
    throw new Error('compile-step: LLM 表示放弃编译(无法可靠定位)');
  }
  if (!Array.isArray(obj.compiled)) {
    throw new Error('compile-step: compiled 字段不是数组');
  }

  // 归一化:locator 形状修复、空数组 → null。
  const normalized = obj.compiled.map(normalizeCompiledStep);
  // zod 兜底:任一条不合法直接报错,前端回退编辑态。
  const list = z.array(StepAction).min(1).safeParse(normalized);
  if (!list.success) {
    throw new Error(`compile-step: 编译结果不合法 (${list.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
  }
  return list.data;
}
