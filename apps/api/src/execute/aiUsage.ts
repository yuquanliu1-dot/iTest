/** 单步 AI 用量累加器：runAiTask / 验证码 / 视觉判定每轮 LLM 调用后 add，stepResult 组装时挂到 aiUsage。 */
export interface AiUsageStat {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  modelCallMs: number;
  retries: number;
  model?: string;
  /** 命中缓存的 prompt token 数（不含在 promptTokens 内）。provider 未透出时为 0。 */
  cacheReadTokens?: number;
  /** 为建立缓存新写入的 token 数。provider 未透出时为 0。 */
  cacheCreationTokens?: number;
}

/** add 入参对齐 LLMResult/completeJson 透出的字段，均可缺省。 */
export interface AiUsageAddend {
  usage?: {
    promptTokens: number;
    completionTokens: number;
    /** 命中缓存的 prompt token 数（不含在 promptTokens 内）。 */
    cacheReadTokens?: number;
    /** 为建立缓存新写入的 token 数。 */
    cacheCreationTokens?: number;
  };
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
        // 缓存 token 单独累加（provider 不透出时保持 0，不影响老报告结构）。
        stat.cacheReadTokens = (stat.cacheReadTokens ?? 0) + (r.usage.cacheReadTokens ?? 0);
        stat.cacheCreationTokens = (stat.cacheCreationTokens ?? 0) + (r.usage.cacheCreationTokens ?? 0);
      }
      if (typeof r.durationMs === 'number') stat.modelCallMs += r.durationMs;
      if (typeof r.retries === 'number') stat.retries += r.retries;
      if (r.model) stat.model = r.model;
    },
  };
}
