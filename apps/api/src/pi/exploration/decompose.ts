/**
 * Charter decomposition (C2): one LLM call before the exploration starts, splitting the charter into 2~12
 * individually verifiable sub-goals.
 *
 * Why decompose: the legacy charter was one blob of natural language; the model decomposed it itself each round →
 * sub-goals scattered through reasoning with no form, and coverage relied entirely on model self-discipline (the same
 * exploration would often dive straight into the first path while later checkpoints never got looked at).
 * After decomposition:
 * - Sub-goals go into the system prompt (appendSystemPromptOverride, compression-safe — pi compression only
 *   summarizes old messages and never touches the system prompt) → the exploration has a clear direction, and the
 *   observe feedback can also remind it which remain;
 * - Sub-goals land in coverage_ledger.goals → the final-state snapshot lets humans assess how much the exploration covered.
 *
 * Soft failure: decomposition is an enhancement, not a precondition — LLM down/timeout/garbage output → no sub-goals,
 * the exploration runs as usual (same semantics as code-scope parsing: a failed parse never capsizes the session).
 */
import { completeJson, type LLMClient } from '../../agent/llm-client.js';
import { resolveLlmClient } from '../../agent/llmSettings.js';
import { withTimeout } from '../../execute/explorationShared.js';
import { logger } from '../../logger.js';

/** Sub-goal count cap: beyond this it is no longer "decomposition", just shredding the charter.
 *  Breadth of coverage types (functional/security/boundary/UI-UX) is not fabricated by decomposition (decomposition
 *  only follows the charter) — it comes from the persona matrix running multiple paths in parallel, one perspective each. */
export const DECOMPOSE_MAX_GOALS = 12;
/** Decomposition call timeout (soft-failure semantics: timeout = no sub-goals). */
const DECOMPOSE_TIMEOUT_MS = 60_000;
/** Per-sub-goal text cap (goes into the prompt and the ledger; neither should bloat unboundedly). */
const GOAL_TEXT_MAX = 120;

const DECOMPOSE_SYSTEM_PROMPT = `你是测试章程分解器。给你一段探索式测试章程（charter），把它拆成可在页面上逐条验证的子目标：每条一个动作或检查点，动词开头，能看出「做到了还是没做到」。
只输出 JSON，不要输出其他内容：{"goals":[{"text":"<子目标>"}]}
- 条数 2~12 条（按章程实际宽度给，窄的章程给 1~2 条即可），按探索顺序排列
- 每条聚焦一个具体对象或行为（例如「打开新增对话框」「空值提交看是否被拒」「返回列表后筛选是否保持」），不要写「全面测试」「探索功能」这类空话
- 只依据章程本身分解，不臆造章程里没有的页面或功能`;

export interface ExplorationGoal {
  /** Stable ordinal (g1, g2...): the prompt, the ledger, and the finish report all share this id set. */
  id: string;
  text: string;
}

/** Model output → sub-goal list (shape tolerance + dedup + cap). Empty/dirty output = no sub-goals. */
export function parseGoals(value: unknown): ExplorationGoal[] {
  const raw = (() => {
    if (Array.isArray(value)) return value;
    const o = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    for (const k of ['goals', 'plan', 'subgoals', 'subGoals', '子目标', '目标']) {
      if (Array.isArray(o[k])) return o[k] as unknown[];
    }
    return [];
  })();
  const out: ExplorationGoal[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let text = '';
    if (typeof item === 'string') {
      text = item.trim();
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const v = [o.text, o.goal, o.title, o['子目标'], o['目标']].find(
        (x) => typeof x === 'string' && (x as string).trim(),
      );
      text = typeof v === 'string' ? v.trim() : '';
    }
    if (!text) continue;
    const key = text.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `g${out.length + 1}`, text: text.slice(0, GOAL_TEXT_MAX) });
    if (out.length >= DECOMPOSE_MAX_GOALS) break;
  }
  return out;
}

/**
 * Decomposes the charter → sub-goals. Never throws: every failure path returns an empty array (the exploration runs
 * as usual, without sub-goals).
 * deps.llm lets tests inject a stub (no real network).
 */
export async function decomposeCharter(
  input: { charter: string; persona?: string },
  deps?: { llm?: LLMClient },
): Promise<ExplorationGoal[]> {
  try {
    const client = deps?.llm ?? (await resolveLlmClient()).client;
    const persona = input.persona?.trim();
    const r = await withTimeout(
      completeJson(client, {
        systemPrompt: DECOMPOSE_SYSTEM_PROMPT,
        userMessage: `${persona ? `探索视角：${persona}\n\n` : ''}章程：\n${input.charter.trim().slice(0, 4000)}`,
      }),
      DECOMPOSE_TIMEOUT_MS,
      '章程分解超时',
    );
    const goals = parseGoals(r.value);
    logger.info({ goals: goals.length }, 'exploration charter decomposed');
    return goals;
  } catch (e) {
    logger.warn({ err: e }, 'exploration charter decomposition failed; continue without goals');
    return [];
  }
}
