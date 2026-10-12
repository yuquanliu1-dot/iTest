/**
 * 源码静态定位分析（L1 源码增强）：对 compiled 候选 locator 跑源码 grep，
 * 给出「该锚点在源码里命中几次 / 在不在源码里」的结构化事实，供 LLM 排行候选、
 * 换掉伪唯一锚点。锚点无关——不假设 data-testid / class / 任何框架——只统计
 * 「任意静态锚点字面量」的源码命中数，对任何项目成立。
 *
 * 核心原则「静态排行，运行时拍板」：本模块只产出 advisory 事实，绝不判死。
 * 判 verdict 的规则（泛化关键）：
 * - 命中恰好 1 → unique（唯一锚点，排前）
 * - 命中 > 1   → multiple（预测运行时 AmbiguousLocator，排后/告警）
 * - 命中 0     → 二级「去参化」探测区分：
 *     · loosened 键（属性只保留属性名 / 字面量本身）在源码里有 → dynamic-suspect：
 *       锚点由动态绑定渲染（:id="x" / v-for / 模板绑定），运行时确认，不误杀；
 *     · loosened 也没有 → not-found：疑似臆造 / 脚手架改名（仍不判死，留运行时裁决）。
 *
 * count 回调注入式（execute 层纯逻辑可单测）：生产接 repo_grep（见 repo.ts 的
 * countRepoGrep），测试接假计数器。
 */
import type { Locator } from '@itest/shared';

export type LocatorVerdict = 'unique' | 'multiple' | 'not-found' | 'dynamic-suspect' | 'skipped';

/** 一次 grep 的结构化命中。count 为命中行数（截断时至少达上限）。 */
export interface SourceCount {
  count: number;
  truncated: boolean;
  samplePaths: string[];
}

/** 单候选静态分析报告。sourceCount=null 表示 skipped（无静态可判）。 */
export interface StaticLocatorReport {
  strategy: string;
  value: string;
  verdict: LocatorVerdict;
  sourceCount: number | null;
  sourceTruncated: boolean;
  samplePaths: string[];
}

export type LocatorCountFn = (pattern: string) => Promise<SourceCount>;

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const esc = (s: string): string => s.replace(RE_SPECIAL, '\\$&');

/** 属性选择器 [name="val"] / [name='val'] / [name=val]。 */
const CSS_ATTR_RE = /\[([^\]\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\]/;
const ID_RE = /#([A-Za-z_][\w-]*)/;
const CLASS_RE = /\.([A-Za-z_][\w-]*)/;
/** role value 形如 button[name='登录']；testId 形如 [data-testid="tab"] 或裸 token。 */
const ROLE_NAME_RE = /name=["']([^"']+)["']/;

/**
 * 把候选 locator 映射为 grep 键对。
 * precise：精确锚点键（属性名+值邻接，或裸 token），首探测用它。
 * loose：precise 落空后的去参化键（属性候选退化为仅属性名，标记动态绑定），无则 null。
 * 返回 null → 该策略/形态无静态可判（xpath、移动端锚点、裸标签 css）。
 */
export function extractGrepKeys(strategy: string, value: string): { precise: string; loose: string | null } | null {
  switch (strategy) {
    case 'css': {
      const attr = CSS_ATTR_RE.exec(value);
      if (attr) {
        const name = attr[1]!;
        const val = attr[2] ?? attr[3] ?? attr[4] ?? '';
        if (val) {
          // 源码邻接形态:title="查看" / title='查看' / :title="'查看'" / {title:'查看'}
          return { precise: `${esc(name)}\\s*[:=]\\s*['"]{1,2}${esc(val)}`, loose: `\\b${esc(name)}\\b` };
        }
      }
      const id = ID_RE.exec(value);
      if (id) return { precise: esc(id[1]!), loose: null };
      const cls = CLASS_RE.exec(value);
      if (cls) return { precise: esc(cls[1]!), loose: null };
      return null; // 裸标签 / 纯组合器:无静态可判
    }
    case 'text': {
      const t = value.slice(0, 40).trim();
      return t ? { precise: esc(t), loose: null } : null;
    }
    case 'role': {
      const m = ROLE_NAME_RE.exec(value);
      if (m) return { precise: `name\\s*[:=]\\s*['"]{1,2}${esc(m[1]!)}`, loose: null };
      return null; // 纯 role 名（button 等）无静态可判
    }
    case 'testId': {
      if (value.startsWith('[')) {
        const b = extractGrepKeys('css', value);
        if (b) return b;
      }
      const t = value.trim();
      return t ? { precise: `data-testid\\s*[:=]\\s*['"]?${esc(t)}`, loose: 'data-testid' } : null;
    }
    // xpath 历史兼容、移动端锚点(accessibilityId/label/predicate):web 回放不支持或无静态可判
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

/** 按稳定度降序稳定重排候选（unique → dynamic-suspect → multiple → not-found → skipped）。 */
export function reorderCandidates(reports: StaticLocatorReport[]): StaticLocatorReport[] {
  return [...reports].sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]);
}

/**
 * 对一组候选跑静态定位分析。count 调用按 pattern 去重缓存（同一条目在候选间复用）。
 * 只产出 advisory 事实，不判死。
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
    // precise 命中 0：去参化二级探测，区分「动态渲染」与「疑似臆造」
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

/** 把分析结果压缩成给 LLM/人类的一行摘要。 */
export function summarizeStaticReports(reports: StaticLocatorReport[]): string | null {
  if (reports.length === 0) return null;
  const parts: string[] = [];
  const mult = reports.filter((r) => r.verdict === 'multiple').map((r) => `${r.strategy}:${r.value}`);
  if (mult.length > 0) parts.push(`源码命中多处（回放歧义风险）: ${mult.join('、')}`);
  const nf = reports.filter((r) => r.verdict === 'not-found').map((r) => `${r.strategy}:${r.value}`);
  if (nf.length > 0) parts.push(`源码未命中（疑似臆造或脚手架改名）: ${nf.join('、')}`);
  const dyn = reports.filter((r) => r.verdict === 'dynamic-suspect').map((r) => `${r.strategy}:${r.value}`);
  if (dyn.length > 0) parts.push(`源码未字面命中但存在动态绑定（以运行时为准）: ${dyn.join('、')}`);
  return parts.length > 0 ? parts.join('；') : null;
}