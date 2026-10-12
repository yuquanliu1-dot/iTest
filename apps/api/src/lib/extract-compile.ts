import { safeRegex } from '@itest/shared';
import { resolveLlmClient } from '../agent/llmSettings.js';
import { completeJson } from '../agent/llm-client.js';

const SYSTEM_PROMPT = `你是文本片段抽取助手。用户给一段原始文本和自然语言描述，你输出一个 JavaScript 正则（仅一条）与捕获组编号。
要求：
1. 正则必须能在原始文本中匹配出描述的片段，且仅匹配出该片段。
2. 输出 JSON：{"pattern": "<regex>", "group": <1-based int> 或 0 表示整个 match>}
3. 不输出其它内容。
4. 不要使用灾难性回溯结构（如 (a+)+）。`;

export interface CompileExtractResult {
  pattern: string;
  group: number;
}

/** 调 LLM 生成正则。生成后做 safeRegex 校验；不合法抛错由调用方处理。 */
export async function compileExtractRegex(
  description: string,
  sampleText: string,
): Promise<CompileExtractResult> {
  const { client } = await resolveLlmClient();
  const userMessage = [
    'extract-compile',
    `原始文本: ${sampleText}`,
    `描述: ${description}`,
  ].join('\n');
  const r = await completeJson(client, { systemPrompt: SYSTEM_PROMPT, userMessage });
  const raw = r.value as { pattern?: unknown; group?: unknown };
  if (typeof raw.pattern !== 'string') {
    throw new Error('extract-compile: LLM 输出不合法');
  }
  const pattern = raw.pattern;
  const group = typeof raw.group === 'number' ? raw.group : 0;
  const ok = safeRegex(pattern);
  if (!ok.ok) throw new Error(`extract-compile: 生成的正则不安全 (${ok.reason})`);
  return { pattern, group };
}
