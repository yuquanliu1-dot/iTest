/**
 * 章程分解（C2）：探索开跑前 1 次 LLM 调用，把章程拆成 2~12 条可逐条验证的子目标。
 *
 * 为什么拆：legacy 的章程是一整段自然语言，模型每轮自行拆解 → 子目标散在推理里没有形式，
 * 覆盖度全靠模型自觉（同一场探索常常一头扎进第一条路径，后面的检查点根本没看）。
 * 分解之后：
 * - 子目标进 system prompt（appendSystemPromptOverride，压缩安全——pi 压缩只摘要旧消息、
 *   不动 system prompt）→ 探索有明确的推进方向，observe 回灌时也能提醒还剩哪些；
 * - 子目标落 coverage_ledger.goals → 终态快照供人工评估这场探索盖住了多少。
 *
 * 软失败：分解是增强不是前置条件——LLM 挂了/超时/输出垃圾 → 无子目标，探索照常跑
 * （与代码范围解析同款语义：解析失败不掀翻会话）。
 */
import { completeJson, type LLMClient } from '../../agent/llm-client.js';
import { resolveLlmClient } from '../../agent/llmSettings.js';
import { withTimeout } from '../../execute/explorationShared.js';
import { logger } from '../../logger.js';

/** 子目标条数上限：再多就不是「分解」，是把章程切碎了。
 *  12 条 = 「功能 + 边界 + 安全 + UI/UX」四类各占几条的量级（2026-11-12 用户口径）。 */
export const DECOMPOSE_MAX_GOALS = 12;
/** 分解调用超时（软失败口径：超时 = 无子目标）。 */
const DECOMPOSE_TIMEOUT_MS = 60_000;
/** 单条子目标文本上限（进提示词与账本，都不无限膨胀）。 */
const GOAL_TEXT_MAX = 120;

const DECOMPOSE_SYSTEM_PROMPT = `你是测试章程分解器。给你一段探索式测试章程（charter），把它拆成可在页面上逐条验证的子目标：每条一个动作或检查点，动词开头，能看出「做到了还是没做到」。
只输出 JSON，不要输出其他内容：{"goals":[{"text":"<子目标>"}]}
- 条数 2~12 条（按章程实际宽度给，窄的章程给 1~2 条即可），按探索顺序排列
- 每条聚焦一个具体对象或行为（例如「打开新增对话框」「空值提交看是否被拒」「返回列表后筛选是否保持」），不要写「全面测试」「探索功能」这类空话
- 只依据章程本身分解，不臆造章程里没有的页面或功能`;

export interface ExplorationGoal {
  /** 稳定序号（g1、g2…）：提示词、账本、finish 回告共用同一套 id。 */
  id: string;
  text: string;
}

/** 模型输出 → 子目标列表（形状容错 + 去重 + 封顶）。空/脏输出 = 无子目标。 */
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
 * 分解章程 → 子目标。永不抛错：任何失败路径都返回空数组（探索照常跑，无子目标）。
 * deps.llm 供测试注入桩（不打真网络）。
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
