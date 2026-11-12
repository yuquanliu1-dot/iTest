/** Per-step AI usage accumulator: add after each LLM call in runAiTask / captcha / vision judgment; attached to aiUsage when the stepResult is assembled. */
export interface AiUsageStat {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  modelCallMs: number;
  retries: number;
  model?: string;
  /** Prompt tokens served from cache (not counted in promptTokens). 0 when the provider doesn't expose it. */
  cacheReadTokens?: number;
  /** Tokens newly written to establish the cache. 0 when the provider doesn't expose it. */
  cacheCreationTokens?: number;
}

/** Addend input aligned with the fields LLMResult/completeJson expose; all optional. */
export interface AiUsageAddend {
  usage?: {
    promptTokens: number;
    completionTokens: number;
    /** Prompt tokens served from cache (not counted in promptTokens). */
    cacheReadTokens?: number;
    /** Tokens newly written to establish the cache. */
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
        // Cache tokens accumulate separately (stays 0 when the provider doesn't expose them; old report structure unaffected).
        stat.cacheReadTokens = (stat.cacheReadTokens ?? 0) + (r.usage.cacheReadTokens ?? 0);
        stat.cacheCreationTokens = (stat.cacheCreationTokens ?? 0) + (r.usage.cacheCreationTokens ?? 0);
      }
      if (typeof r.durationMs === 'number') stat.modelCallMs += r.durationMs;
      if (typeof r.retries === 'number') stat.retries += r.retries;
      if (r.model) stat.model = r.model;
    },
  };
}
