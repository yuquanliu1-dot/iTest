/**
 * Source-level static locator analysis (L1 source enhancement): runs a source grep on compiled
 * candidate locators, producing structured facts about "how many times this anchor hits in the
 * source / whether it exists there at all", for the LLM to rank candidates and swap out
 * pseudo-unique anchors. Anchor-agnostic — no assumption about data-testid / class / any
 * framework — it only counts source hits of "any static anchor literal", valid for any project.
 *
 * Core principle "static ranking, runtime decides": this module only produces advisory facts,
 * never a hard verdict. Rules for the verdict (key to generalization):
 * - Exactly 1 hit     → unique (unique anchor, ranked first)
 * - More than 1 hit   → multiple (predicts a runtime AmbiguousLocator, ranked later/warned)
 * - 0 hits            → second-stage "de-parameterized" probe to disambiguate:
 *     · a loosened key (attribute name only / the literal itself) exists in the source →
 *       dynamic-suspect: the anchor is rendered by dynamic binding (:id="x" / v-for / template
 *       binding), confirmed at runtime, not falsely killed;
 *     · no loosened key either → not-found: no literal hit in source. Note this ≠ the anchor
 *       does not exist — for drawer-style rendering / runtime-concatenated ids (e.g. the
 *       Element-UI tab's id="tab-xxx"), a grep miss is the norm, so the summary wording stays
 *       neutral; the runtime hit is the deciding evidence (never a hard verdict).
 *
 * The count callback is injected (pure logic at the execute layer, unit-testable): production
 * wires repo_grep (see countRepoGrep in repo.ts), tests wire a fake counter.
 */
import type { Locator } from '@itest/shared';

export type LocatorVerdict = 'unique' | 'multiple' | 'not-found' | 'dynamic-suspect' | 'skipped';

/** Structured hit of one grep. count is the number of matched lines (at least the cap when truncated). */
export interface SourceCount {
  count: number;
  truncated: boolean;
  samplePaths: string[];
}

/** Static analysis report for a single candidate. sourceCount=null means skipped (nothing static to judge). */
export interface StaticLocatorReport {
  strategy: string;
  value: string;
  verdict: LocatorVerdict;
  sourceCount: number | null;
  sourceTruncated: boolean;
  samplePaths: string[];
}

export type LocatorCountFn = (pattern: string) => Promise<SourceCount>;
/** Batch counting callback: one traversal finds hit counts for all patterns. Patterns missing from the returned Map count as 0 hits. */
export type BatchLocatorCountFn = (patterns: string[]) => Promise<Map<string, SourceCount>>;

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const esc = (s: string): string => s.replace(RE_SPECIAL, '\\$&');

/** Attribute selector [name="val"] / [name='val'] / [name=val]. */
const CSS_ATTR_RE = /\[([^\]\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\]/;
const ID_RE = /#([A-Za-z_][\w-]*)/;
const CLASS_RE = /\.([A-Za-z_][\w-]*)/;
/** role value looks like button[name='登录']; testId looks like [data-testid="tab"] or a bare token. */
const ROLE_NAME_RE = /name=["']([^"']+)["']/;

/**
 * Maps a candidate locator to a pair of grep keys.
 * precise: exact anchor key (attribute name+value adjacent, or a bare token); used for the first probe.
 * loose: de-parameterized key for when precise misses (attribute candidates degrade to the attribute name only, marking dynamic binding); null if none.
 * Returns null → this strategy/shape has nothing static to judge (xpath, mobile anchors, bare-tag css).
 */
export function extractGrepKeys(strategy: string, value: string): { precise: string; loose: string | null } | null {
  switch (strategy) {
    case 'css': {
      const attr = CSS_ATTR_RE.exec(value);
      if (attr) {
        const name = attr[1]!;
        const val = attr[2] ?? attr[3] ?? attr[4] ?? '';
        if (val) {
          // Source-adjacent shapes: title="查看" / title='查看' / :title="'查看'" / {title:'查看'}
          return { precise: `${esc(name)}\\s*[:=]\\s*['"]{1,2}${esc(val)}`, loose: `\\b${esc(name)}\\b` };
        }
      }
      const id = ID_RE.exec(value);
      if (id) return { precise: esc(id[1]!), loose: null };
      const cls = CLASS_RE.exec(value);
      if (cls) return { precise: esc(cls[1]!), loose: null };
      return null; // Bare tag / pure combinator: nothing static to judge
    }
    case 'text': {
      const t = value.slice(0, 40).trim();
      return t ? { precise: esc(t), loose: null } : null;
    }
    case 'role': {
      const m = ROLE_NAME_RE.exec(value);
      if (m) return { precise: `name\\s*[:=]\\s*['"]{1,2}${esc(m[1]!)}`, loose: null };
      return null; // Pure role name (button etc.) has nothing static to judge
    }
    case 'testId': {
      if (value.startsWith('[')) {
        const b = extractGrepKeys('css', value);
        if (b) return b;
      }
      const t = value.trim();
      return t ? { precise: `data-testid\\s*[:=]\\s*['"]?${esc(t)}`, loose: 'data-testid' } : null;
    }
    // xpath legacy compat, mobile anchors (accessibilityId/label/predicate): not supported by web replay or nothing static to judge
    default:
      return null;
  }
}

const VERDICT_RANK: Record<LocatorVerdict, number> = {
  unique: 0,
  'dynamic-suspect': 1,
  multiple: 2,
  'not-found': 3,
  skipped: 4,
};

/** Stably re-sorts candidates by stability descending (unique → dynamic-suspect → multiple → not-found → skipped). */
export function reorderCandidates(reports: StaticLocatorReport[]): StaticLocatorReport[] {
  return [...reports].sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]);
}

/**
 * Runs static locator analysis on a set of candidates. count calls are deduplicated and cached per
 * pattern (the same entry is reused across candidates). Only produces advisory facts, never a hard verdict.
 *
 *  Counts per pattern (one process/IO per pattern). To reuse across candidates and cases use
 *  analyzeLocatorCandidatesBatch — same verdict logic, just counting from a single batch query.
 */
export async function analyzeLocatorCandidates(
  candidates: Locator[],
  count: LocatorCountFn,
): Promise<StaticLocatorReport[]> {
  const cache = new Map<string, Promise<SourceCount>>();
  const counted = (pattern: string): Promise<SourceCount> => {
    let p = cache.get(pattern);
    if (!p) {
      p = count(pattern).catch(() => ({ count: 0, truncated: false, samplePaths: [] }));
      cache.set(pattern, p);
    }
    return p;
  };
  return judgeCandidates(candidates, counted);
}

/**
 * Batch version: first collects all patterns the candidates need (precise + loose) in one deduplicated pass,
 *  hands them to batchCount for a single query, then runs the exact same verdicts as analyzeLocatorCandidates.
 *  The produced StaticLocatorReport shapes match field-by-field — downstream summarizeStaticReports / SSE
 *  events need zero changes.
 *
 *  One query is shared across candidates and cases; repeated patterns (e.g. different steps sharing
 *  [placeholder="账号"]) deduplicate naturally; the timing difference of only appending loose queries on
 *  candidates whose precise hit 0 is erased here: the verdict only cares whether count is 0/1/>1, and the
 *  precise=0 fact itself does not depend on query order.
 */
export async function analyzeLocatorCandidatesBatch(
  candidates: Locator[],
  batchCount: BatchLocatorCountFn,
): Promise<StaticLocatorReport[]> {
  const wanted = new Set<string>();
  for (const c of candidates) {
    const keys = extractGrepKeys(c.strategy, c.value);
    if (!keys) continue;
    wanted.add(keys.precise);
    if (keys.loose) wanted.add(keys.loose);
  }
  const table = (await batchCount([...wanted]).catch(() => new Map<string, SourceCount>()));
  const lookup = (pattern: string): SourceCount => table.get(pattern) ?? { count: 0, truncated: false, samplePaths: [] };
  return judgeCandidates(candidates, async (p) => lookup(p));
}

/** Verdicts for unique / multiple / not-found / dynamic-suspect, shared by both count injection styles. */
async function judgeCandidates(
  candidates: Locator[],
  counted: (pattern: string) => Promise<SourceCount>,
): Promise<StaticLocatorReport[]> {
  const reports: StaticLocatorReport[] = [];
  for (const c of candidates) {
    const keys = extractGrepKeys(c.strategy, c.value);
    if (!keys) {
      reports.push({ strategy: c.strategy, value: c.value, verdict: 'skipped', sourceCount: null, sourceTruncated: false, samplePaths: [] });
      continue;
    }
    const precise = await counted(keys.precise);
    if (precise.count > 1) {
      reports.push({ strategy: c.strategy, value: c.value, verdict: 'multiple', sourceCount: precise.count, sourceTruncated: precise.truncated, samplePaths: precise.samplePaths });
      continue;
    }
    if (precise.count === 1) {
      reports.push({ strategy: c.strategy, value: c.value, verdict: 'unique', sourceCount: 1, sourceTruncated: precise.truncated, samplePaths: precise.samplePaths });
      continue;
    }
    // precise hit 0: de-parameterized second-stage probe, distinguishing "dynamically rendered" from "no literal trace in source"
    if (keys.loose) {
      const loose = await counted(keys.loose);
      if (loose.count > 0) {
        reports.push({ strategy: c.strategy, value: c.value, verdict: 'dynamic-suspect', sourceCount: 0, sourceTruncated: false, samplePaths: loose.samplePaths });
        continue;
      }
    }
    reports.push({ strategy: c.strategy, value: c.value, verdict: 'not-found', sourceCount: 0, sourceTruncated: false, samplePaths: [] });
  }
  return reports;
}

/** Compresses the analysis into a one-line summary for the LLM/humans. */
export function summarizeStaticReports(reports: StaticLocatorReport[]): string | null {
  if (reports.length === 0) return null;
  const parts: string[] = [];
  const mult = reports.filter((r) => r.verdict === 'multiple').map((r) => `${r.strategy}:${r.value}`);
  if (mult.length > 0) parts.push(`源码命中多处（回放歧义风险）: ${mult.join('、')}`);
  const nf = reports.filter((r) => r.verdict === 'not-found').map((r) => `${r.strategy}:${r.value}`);
  // Wording deliberately neutral: the source grep only covers literals, and drawer-style rendering /
  // runtime-concatenated attribute names (Element-UI generating id="tab-xxx" for tabs and the like) missing
  // from a grep is the norm. Worded as "suspected fabrication", the AI would take it as "this selector is fake"
  // and drop candidates already proven to hit at runtime — observed on prod228 on 2026-10-13: #tab-autodo truly
  // existed at runtime, yet this hint steered the AI into rewriting the step and burning two more verification
  // rounds before squeaking through. Static facts only inform ranking; the runtime hit is the deciding evidence.
  if (nf.length > 0) parts.push(`源码无字面命中（仅供排序参考，运行时命中与否以实测为准）: ${nf.join('、')}`);
  const dyn = reports.filter((r) => r.verdict === 'dynamic-suspect').map((r) => `${r.strategy}:${r.value}`);
  if (dyn.length > 0) parts.push(`源码未字面命中但存在动态绑定（以运行时为准）: ${dyn.join('、')}`);
  return parts.length > 0 ? parts.join('；') : null;
}