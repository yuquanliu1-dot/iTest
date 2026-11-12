/**
 * Coverage ledger (pi chain C1): mechanical accumulation of visited paths + interaction counts + sub-goals.
 *
 * Coverage relying on model self-discipline was legacy's structural shortcoming — the ledger turns it into
 * platform-side mechanical facts:
 * - After each tool call, record the current URL's path (deduplicated, capped) and accumulate interaction counts per kind;
 * - The digest is fed back with observe as "already covered, do not repeat" (counters spinning in place);
 * - The final-state snapshot is persisted (coverage_ledger column), letting humans assess how much of the site this exploration covered.
 *
 * goals (sub-goals) come from C2 charter decomposition: the LLM extracts 2~12 items before the run, written into the
 * ledger and the system prompt; completion is reported back by the model at finish (id + done) — the platform does not guess "done or not".
 */
import type { Page } from 'playwright-core';

export interface CoverageLedgerSnapshot {
  paths: string[];
  interactions: Array<{ kind: string; count: number }>;
  goals: Array<{ id: string; text: string; done: boolean }>;
  updatedAt: string;
}

/** Path cap: unbounded growth over long sessions is pointless; both archival and feedback only care about "which pages were visited". */
export const COVERAGE_PATHS_MAX = 100;

/** Number of recent paths listed in the feedback digest (the full set lives in the DB). */
const RENDER_PATHS_MAX = 8;

export interface CoverageTracker {
  /** Records the current page path (deduplicated). */
  recordUrl(page: Page): void;
  /** Interaction count (kind = the action-trail action type: click/fill/navigate/...). */
  recordInteraction(kind: string): void;
  /** Writes the sub-goals decomposed from the charter (once before the run; repeated calls overwrite old values). */
  setGoals(goals: Array<{ id: string; text: string }>): void;
  /** The model reports sub-goal completion at finish (merged by id; unknown ids ignored). */
  markGoals(updates: Array<{ id: string; done: boolean }>): void;
  /** Feedback digest for observe (returns an empty string for an empty ledger). */
  render(): string;
  snapshot(): CoverageLedgerSnapshot;
}

/**
 * Final-state coverage digest: how much this exploration actually covered and what is missing.
 * The ledger is platform-side mechanical fact (which pages were visited, how many actions taken, how many sub-goals done) —
 * exploration depth cannot be measured by "how many rounds ran"; the covered/uncut things must be made visible.
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
        // Unparseable url (about:blank etc.) is not recorded
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
        // Sub-goal text in the feedback is truncated: the full text lives in the system prompt and the ledger; this
        // only outlines "which ones are not done" (it feeds back on every observe; untruncated lists would burn tokens for nothing).
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
