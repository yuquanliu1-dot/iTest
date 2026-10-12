/** 单步 AI 用量累加器：runAiTask / 验证码 / 视觉判定每轮 LLM 调用后 add，stepResult 组装时挂到 aiUsage。 */
export interface AiUsageStat {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  modelCallMs: number;
  retries: number;
  model?: string;
}

/** add 入参对齐 LLMResult/completeJson 透出的字段，均可缺省。 */
export interface AiUsageAddend {
  usage?: { promptTokens: number; completionTokens: number };
  durationMs?: number;
  retries?: number;
  model?: string;
}

export interface AiUsageAccumulator {
  stat: AiUsageStat;
  add(r: AiUsageAddend): void;
}

export function newAiUsage(): AiUsageAccumulator {
  const stat: AiUsageStat = { calls: 0, promptTokens: 0, completionTokens: 0, modelCallMs: 0, retries: 0 };
  return {
    stat,
    add(r) {
      stat.calls += 1;
      if (r.usage) {
        stat.promptTokens += r.usage.promptTokens;
        stat.completionTokens += r.usage.completionTokens;
      }
      if (typeof r.durationMs === 'number') stat.modelCallMs += r.durationMs;
      if (typeof r.retries === 'number') stat.retries += r.retries;
      if (r.model) stat.model = r.model;
    },
  };
}
