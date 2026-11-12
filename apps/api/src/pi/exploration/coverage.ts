/**
 * 覆盖账本（pi 链路 C1）：已走路径 + 交互计数 + 子目标的机械累计。
 *
 * 覆盖度靠模型自觉是 legacy 的结构性短板——账本把它变成平台侧机械事实：
 * - 每次工具调用后记录当前 URL 的 path（去重、封顶）、按 kind 累计交互次数；
 * - 摘要随 observe 回灌「已覆盖、别重复」（对抗原地打转）；
 * - 终态快照落库（coverage_ledger 列），人工可据此评估这场探索盖住了多少页面。
 *
 * goals（子目标）来自 C2 章程分解：开跑前 LLM 拆出 2~12 条，写进账本并进系统提示词；
 * 完成情况由模型在 finish 时回告（id + done）——平台不猜「做没做到」。
 */
import type { Page } from 'playwright-core';

export interface CoverageLedgerSnapshot {
  paths: string[];
  interactions: Array<{ kind: string; count: number }>;
  goals: Array<{ id: string; text: string; done: boolean }>;
  updatedAt: string;
}

/** 路径封顶：长会话无界增长没意义，留档与回灌都只关心「去过哪些」。 */
export const COVERAGE_PATHS_MAX = 100;

/** 回灌摘要里列出的最近路径条数（全量在库里）。 */
const RENDER_PATHS_MAX = 8;

export interface CoverageTracker {
  /** 记录当前页面 path（去重）。 */
  recordUrl(page: Page): void;
  /** 交互计数（kind = 留痕的动作类型：click/fill/navigate/...）。 */
  recordInteraction(kind: string): void;
  /** 写入章程分解出的子目标（开跑前一次；重复调用覆盖旧值）。 */
  setGoals(goals: Array<{ id: string; text: string }>): void;
  /** 模型在 finish 时回告子目标完成情况（按 id 合并；未知 id 忽略）。 */
  markGoals(updates: Array<{ id: string; done: boolean }>): void;
  /** observe 回灌摘要（空账本返回空串）。 */
  render(): string;
  snapshot(): CoverageLedgerSnapshot;
}

/**
 * 终态覆盖摘要：这探索到底盖住了多少、还差什么。
 * 账本是平台侧机械事实（去了哪些页面、动过多少次、子目标完成几个）——
 * 探索深度不能只由「跑了几轮」衡量，得让盖住/没盖住的东西可见。
 */
export function coverageDigest(snapshot: CoverageLedgerSnapshot, maxUnfinished = 3): string {
  const interactions = snapshot.interactions.reduce((a, b) => a + b.count, 0);
  const done = snapshot.goals.filter((g) => g.done).length;
  const unfinished = snapshot.goals.filter((g) => !g.done);
  const parts = [`页面 ${snapshot.paths.length} 个、交互 ${interactions} 次`];
  if (snapshot.goals.length > 0) {
    parts.push(`子目标 ${done}/${snapshot.goals.length}`);
    if (unfinished.length > 0) {
      const list = unfinished.slice(0, maxUnfinished).map((g) => `${g.id} ${g.text}`).join('；');
      const more = unfinished.length > maxUnfinished ? `（另 ${unfinished.length - maxUnfinished} 条）` : '';
      parts.push(`未完成：${list}${more}`);
    }
  }
  return parts.join('｜');
}

export function createCoverageTracker(): CoverageTracker {
  const paths: string[] = [];
  const interactions = new Map<string, number>();
  let goals: Array<{ id: string; text: string; done: boolean }> = [];
  return {
    recordUrl(page: Page): void {
      try {
        const u = new URL(page.url());
        const p = `${u.pathname}${u.search}`.slice(0, 200);
        if (p && p !== '/' && !paths.includes(p) && paths.length < COVERAGE_PATHS_MAX) paths.push(p);
      } catch {
        // url 不可解析（about:blank 等）不记账
      }
    },
    recordInteraction(kind: string): void {
      interactions.set(kind, (interactions.get(kind) ?? 0) + 1);
    },
    setGoals(next: Array<{ id: string; text: string }>): void {
      goals = next.map((g) => ({ id: g.id, text: g.text, done: false }));
    },
    markGoals(updates: Array<{ id: string; done: boolean }>): void {
      for (const u of updates) {
        const g = goals.find((x) => x.id === u.id);
        if (g) g.done = u.done === true;
      }
    },
    render(): string {
      const total = [...interactions.values()].reduce((a, b) => a + b, 0);
      if (paths.length === 0 && total === 0 && goals.length === 0) return '';
      const kinds = [...interactions.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, c]) => `${k}×${c}`)
        .join('、');
      const recent = paths.slice(-RENDER_PATHS_MAX).join('、');
      const more = paths.length > RENDER_PATHS_MAX ? `（共 ${paths.length} 条路径）` : '';
      const parts = [`覆盖进度：去过 ${paths.length} 个页面：${recent}${more}｜交互 ${total} 次（${kinds}）。已看过的页面别原路重复探索，优先推进没去过的入口。`];
      if (goals.length > 0) {
        const done = goals.filter((g) => g.done).length;
        // 回灌里的子目标文本截断：全文在系统提示词与账本里，这里只给「哪条没做」的轮廓
        // （每次 observe 都回灌，条数多了不截会白烧 token）。
        const list = goals.map((g) => `${g.id}[${g.done ? 'x' : ' '}]${g.text.slice(0, 40)}`).join('｜');
        parts.push(`子目标 ${done}/${goals.length} 已完成：${list}。未完成的子目标继续推进。`);
      }
      return parts.join('\n');
    },
    snapshot(): CoverageLedgerSnapshot {
      return {
        paths: [...paths],
        interactions: [...interactions.entries()].map(([kind, count]) => ({ kind, count })),
        goals: goals.map((g) => ({ ...g })),
        updatedAt: new Date().toISOString(),
      };
    },
  };
}
