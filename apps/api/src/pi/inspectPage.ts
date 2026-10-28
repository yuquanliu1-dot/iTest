/**
 * 抓取被测页面并提取可交互元素清单，供 inspect_page 工具把"页面实际代码"
 * 注入 LLM 上下文。launch 模式与 execute/cdp.ts 一致（CHROMIUM_PATH 覆盖），
 * DOM 提取沿用 domFallback.ts 的 page.evaluate 注入惯例。
 * 防护：仅 http/https + goto 超时 + 元素数/输出长度上限（内网被测地址是核心场景，不做私网拦截）。
 * extractPageElements 供 verify_case 失败页/成功页快照复用（成功页清单约束 agent 下一步只引用真实控件）。
 */
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';

const GOTO_TIMEOUT_MS = 20_000;
const SETTLE_MS = 800;
/** 浏览器端原始候选上限：只防跑飞（大表格页可能上千节点），排序/去重在 TS 侧做。 */
const RAW_MAX_CANDIDATES = 800;
/** 最终输出给模型的元素条目上限（去重后）。 */
const MAX_ELEMENTS = 90;
/** 纯 [role] 容器（treeitem/row/gridcell 等数据节点）保留上限：同质、信息量低，但成百上千。 */
const MAX_ROLE_LIKE = 12;
/** 复选框/单选（多为表格行选择框）保留上限：无文案、高度同质。 */
const MAX_BULK_CONTROLS = 6;
const MAX_OUTPUT_CHARS = 30_000;

/**
 * DOM 提取必须以字符串表达式传给 page.evaluate：tsx/esbuild(keepNames) 会往编译后的
 * 函数体注入 __name(...) 辅助调用，Playwright 按 fn.toString() 序列化回调送到浏览器
 * 执行时浏览器里没有 __name，直接 ReferenceError。字符串形式原样求值，不受影响。
 */
const EXTRACT_JS = `(() => {
  const rawMax = ${RAW_MAX_CANDIDATES};
  const title = document.title || '';
  const nodes = document.querySelectorAll(
    'a, button, input, select, textarea, summary, [contenteditable="true"], [role], [data-testid]',
  );
  const visible = (el) => {
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const pick = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const tid = el.getAttribute('data-testid');
    if (tid) return '[data-testid="' + tid + '"]';
    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    const aria = el.getAttribute('aria-label');
    if (aria) return el.tagName.toLowerCase() + '[aria-label="' + aria + '"]';
    const text = (el.innerText || el.getAttribute('placeholder') || '').trim().slice(0, 30);
    if (text) return 'text=' + text;
    return el.tagName.toLowerCase();
  };
  const candidates = [];
  let overflow = false;
  for (const el of Array.from(nodes)) {
    if (candidates.length >= rawMax) { overflow = true; break; }
    if (!visible(el)) continue;
    candidates.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      id: el.id || '',
      name: el.getAttribute('name') || '',
      role: el.getAttribute('role') || '',
      text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      placeholder: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      titleAttr: el.getAttribute('title') || '',
      testid: el.getAttribute('data-testid') || '',
      editable: el.getAttribute('contenteditable') === 'true',
      selector: pick(el),
    });
  }
  const bodyLen = document.body ? document.body.innerText.length : 0;
  return { title, bodyLen, candidates, overflow };
})()`;

/** 浏览器端采回的原始候选元素（EXTRACT_JS 产物；字段为空串表示属性缺席）。 */
export interface RawElementCandidate {
  tag: string;
  type: string;
  id: string;
  name: string;
  role: string;
  text: string;
  placeholder: string;
  aria: string;
  titleAttr: string;
  testid: string;
  editable: boolean;
  selector: string;
}

/** 分档：action=动作控件（按钮/输入/下拉/链接…）；structure=纯 [role] 容器（treeitem/row 等数据节点）；
 *  bulk=复选框/单选（多为表格行选择框，无文案、高度同质）。 */
type CandidateTier = 'action' | 'structure' | 'bulk';

const CONTROL_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
/** role 值本身即可操作的容器（下拉选项/tab/菜单项等）：无论标签是什么都按动作控件对待。 */
const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'option', 'tab',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'textbox', 'searchbox', 'slider', 'spinbutton',
]);
const TIER_RANK: Record<CandidateTier, number> = { action: 0, structure: 1, bulk: 2 };

function tierOf(c: RawElementCandidate): CandidateTier {
  if (c.role && ACTIONABLE_ROLES.has(c.role)) return 'action';
  const isControlTag = CONTROL_TAGS.has(c.tag) || !!c.testid || c.editable;
  if (!isControlTag) return 'structure';
  if (c.tag === 'input' && (c.type === 'checkbox' || c.type === 'radio')) return 'bulk';
  return 'action';
}

/** 元素信息量评分（档内排序用）：有可读文案/占位/aria 的控件排前面，匿名垫底。 */
function scoreOf(c: RawElementCandidate): number {
  let s = 0;
  if (c.text) s += 25;
  if (c.placeholder) s += 20;
  if (c.aria) s += 18;
  if (c.titleAttr) s += 12;
  if (c.tag === 'select' || c.tag === 'textarea') s += 20;
  if (c.tag === 'input') s += 10;
  if (c.tag === 'button' || c.tag === 'a') s += 10;
  if (c.testid) s += 20;
  if (c.id) s += 6;
  if (c.name) s += 6;
  return s;
}

function formatCandidate(c: RawElementCandidate, dup: number): string {
  const parts = [
    '- ' + c.tag + (c.id ? '#' + c.id : '') + (c.type ? '[type=' + c.type + ']' : ''),
    c.name ? 'name=' + c.name : '',
    c.role ? 'role=' + c.role : '',
    c.text ? '"' + c.text + '"' : '',
    c.placeholder ? 'placeholder="' + c.placeholder + '"' : '',
    c.aria ? 'aria-label="' + c.aria + '"' : '',
    c.titleAttr ? 'title="' + c.titleAttr + '"' : '',
    '选择器: ' + c.selector + (dup > 1 ? ' ×' + dup : ''),
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * 元素清单降噪排序（信噪比重构，2026-10-28）：
 * 旧实现按 DOM 序直出、300 条硬截断——树表格页上 200+ 个 role=treeitem 行与无名复选框
 * 把工具栏按钮（新建/删除/导入/导出/查询）挤到清单末尾，甚至被输出长度上限吃掉；
 * 拿不到真实控件清单的 agent 会臆造页面上不存在的筛选项。
 * 规则：
 * 1. 同选择器去重折叠（×N 计数）——无名复选框/重复行按钮不再逐条罗列；
 * 2. 分档限额：动作控件全保留，纯 [role] 容器 ≤ MAX_ROLE_LIKE，复选框/单选 ≤ MAX_BULK_CONTROLS；
 * 3. 档内按信息量（文案/占位/aria…）降序，跨档合并后仍受 MAX_ELEMENTS 总限；
 * 4. 被省略的量与类别摘要随清单返回（suppressed/suppressedSummary），判断「同类目标是否存在」仍可用。
 */
export function rankPageElements(raw: RawElementCandidate[]): {
  elements: string[];
  suppressed: number;
  suppressedSummary: string;
} {
  interface Ranked {
    cand: RawElementCandidate;
    tier: CandidateTier;
    score: number;
    count: number;
  }
  const bySelector = new Map<string, Ranked>();
  for (const c of raw) {
    const tier = tierOf(c);
    const score = scoreOf(c);
    const key = c.selector || c.tag;
    const prev = bySelector.get(key);
    if (!prev) {
      bySelector.set(key, { cand: c, tier, score, count: 1 });
      continue;
    }
    prev.count += 1;
    if (score > prev.score) {
      prev.cand = c;
      prev.score = score;
    }
    if (TIER_RANK[tier] < TIER_RANK[prev.tier]) prev.tier = tier;
  }
  const buckets: Record<CandidateTier, Ranked[]> = { action: [], structure: [], bulk: [] };
  for (const e of bySelector.values()) buckets[e.tier].push(e);
  const caps: Record<CandidateTier, number> = { action: MAX_ELEMENTS, structure: MAX_ROLE_LIKE, bulk: MAX_BULK_CONTROLS };
  const kept: Ranked[] = [];
  const suppressedClass = new Map<string, number>();
  let suppressed = 0;
  for (const tier of ['action', 'structure', 'bulk'] as const) {
    buckets[tier].sort((a, b) => b.score - a.score);
    buckets[tier].forEach((e, i) => {
      if (i < caps[tier] && kept.length < MAX_ELEMENTS) {
        kept.push(e);
        return;
      }
      suppressed += e.count;
      const cls = e.cand.role ? `role=${e.cand.role}` : e.cand.type ? `${e.cand.tag}[type=${e.cand.type}]` : e.cand.tag;
      suppressedClass.set(cls, (suppressedClass.get(cls) ?? 0) + e.count);
    });
  }
  kept.sort((a, b) => b.score - a.score);
  const elements = kept.map((e) => formatCandidate(e.cand, e.count));
  const suppressedSummary = [...suppressedClass.entries()].map(([k, n]) => `${k} ×${n}`).join('、');
  return { elements, suppressed, suppressedSummary };
}

export interface PageElementSnapshot {
  url: string;
  title: string;
  bodyLen: number;
  elements: string[];
  truncated: boolean;
  /** 因同类上限/总量上限被省略的元素个数（含同选择器折叠前的重复条数）。 */
  suppressed?: number;
  /** 被省略元素的类别摘要（如「role=treeitem ×88」）：判断「同类目标是否存在」时把这些类别计入。 */
  suppressedSummary?: string;
  /** 页面可见候选元素总数（去重/限额前）：页面质量自评用，避免去重把真实页面误判成空壳。 */
  candidateCount?: number;
}

export type PageQuality = 'ok' | 'low';

/** 页面抓取质量自评:判断"抓到的是真实功能页还是空壳/错误页",供 inspect_page 告知模型 URL 是否可信。
 *  判据是页面自身特征(可交互元素数 / body 文本长度),不绑定任何具体目标系统——
 *  空壳页(登录外壳、404、未挂载的微前端容器)在任意系统都表现为这两项极低。
 *  阈值:可交互元素 < 5 或 body 文本 < 100 字符判为低质量。元素数取去重前候选总数
 *  （candidateCount）——去重/限额后的清单长度不代表页面真实密度。 */
export function assessPageQuality(
  snap: Pick<PageElementSnapshot, 'title' | 'bodyLen' | 'elements' | 'candidateCount'>,
): PageQuality {
  const n = Math.max(snap.elements.length, snap.candidateCount ?? 0);
  if (n < 5 || snap.bodyLen < 100) return 'low';
  return 'ok';
}

/** 在已打开的页面上提取可交互元素清单（inspect_page 与 verify_case 页面快照共用：
 *  失败页给 agent 修 locator，成功页给 agent 讨论「下一步用哪个真实控件」）。 */
export async function extractPageElements(page: Page, url?: string): Promise<PageElementSnapshot> {
  const raw = (await page.evaluate(EXTRACT_JS)) as {
    title: string;
    bodyLen: number;
    candidates: RawElementCandidate[];
    overflow: boolean;
  };
  const ranked = rankPageElements(raw.candidates ?? []);
  return {
    url: url ?? page.url(),
    title: raw.title,
    bodyLen: raw.bodyLen,
    elements: ranked.elements,
    truncated: raw.overflow || ranked.suppressed > 0,
    suppressed: ranked.suppressed,
    suppressedSummary: ranked.suppressedSummary,
    candidateCount: (raw.candidates ?? []).length,
  };
}

/** 失败页结构证据：阻断性浮层清单。
 *
 *  2026-10-17 归因重构后，missingIds（期望容器缺失判定）退役：它靠解析 css strategy 的
 *  #id/[id=] 形态提取期望容器，换 text=/role/xpath/testId 就失效（打地鼠路线）。容器是否缺席
 *  改为由 failureDiagnosis.probeLocatorHits 对每条 locator 候选做实时命中探测（形态无关）+ 元素清单
 *  联合交给 LLM 归因。此处只保留浮层清单：只凭角色/类名特征（role=dialog、class 含
 *  dialog/drawer/message-box/modal/popup/mask/overlay），不绑定任何具体系统的文案——
 *  「可能弹、可能不弹」的条件性浮层（草稿恢复、权限确认）在任何系统都表现为这类 DOM 特征。
 */
export interface PageEvidence {
  /** 覆盖页面上、可能遮挡交互的浮层（弹窗/抽屉/遮罩）。每条：标签 + 可定位选择器 + 文本片段 */
  overlays: Array<{ tag: string; selector: string; text: string }>;
}

/** 浮层候选选择器：覆盖常见的模态/抽屉/消息框/遮罩实现。只用 DOM 特征，不写具体文案。 */
const EVIDENCE_OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [class*="dialog"], [class*="drawer"], [class*="message-box"], ' +
  '[class*="modal"], [class*="popup"], [class*="mask"], [class*="overlay"]';

/** keepNames 约束（同 EXTRACT_JS）：返回字符串表达式原样送浏览器求值，避免 __name 辅助函数注入。 */
const EVIDENCE_JS = `(() => {
  const nodes = document.querySelectorAll('${EVIDENCE_OVERLAY_SELECTOR}');
  const seen = new Set();
  const overlays = [];
  for (const el of Array.from(nodes)) {
    if (overlays.length >= 5) break;
    const rects = el.getClientRects();
    if (rects.length === 0) continue;
    const r = rects[0];
    if (r.width < 20 || r.height < 20) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    const cls = (typeof el.className === 'string' ? el.className : '')
      .split(/\\s+/).filter(Boolean).slice(0, 3).map((c) => '.' + CSS.escape(c)).join('');
    const sel = tag + (el.id ? '#' + CSS.escape(el.id) : cls);
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const key = sel + '|' + text.slice(0, 20);
    if (seen.has(key)) continue;
    seen.add(key);
    overlays.push({ tag, selector: sel, text });
  }
  return { overlays };
})()`;

/** 在已打开的页面上采集结构证据（verify_case / solidify_case 失败页复用）。异常一律静默降级为空证据。 */
export async function extractPageEvidence(page: Page): Promise<PageEvidence> {
  try {
    return (await page.evaluate(EVIDENCE_JS)) as PageEvidence;
  } catch {
    return { overlays: [] };
  }
}

export async function inspectPage(rawUrl: string, opts?: { storageState?: unknown }): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`URL 无法解析: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`仅支持 http/https，收到 ${url.protocol}`);
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  try {
    // 内网被测环境普遍用自签名证书,必须忽略校验,否则 inspect_page 在核心场景下不可用
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      ...(opts?.storageState ? { storageState: opts.storageState as never } : {}),
    });
    const page = await context.newPage();
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);

    const snap = await extractPageElements(page, url.toString());
    const quality = assessPageQuality(snap);
    const density = Math.max(snap.elements.length, snap.candidateCount ?? 0);
    const qualityLine = quality === 'low'
      ? `抓取质量: 低(可交互元素 ${density} 个,正文 ${snap.bodyLen} 字符)——该 URL 可能无效、是空壳页(未渲染的微前端容器)、登录页或 404。请勿基于此清单编造用例,先核对 URL 是否正确;若不确定,跟用户确认目标页面的真实路径。`
      : `抓取质量: 正常(可交互元素 ${density} 个,正文 ${snap.bodyLen} 字符;清单已去重降噪,保留 ${snap.elements.length} 条)`;
    const lines = [
      `页面: ${url.toString()}`,
      `标题: ${snap.title || '(无)'}`,
      qualityLine,
      '注意: 此快照仅为页面初始状态。点击/提交后才出现的元素（结果区、错误提示等）不在清单中——断言这类元素必须先触发相应操作，或断言清单中其稳定的父容器；清单里不存在的 testid/id 绝对禁止编造。',
      `可交互元素 (${snap.elements.length}${snap.suppressed ? `，另有 ${snap.suppressed} 个同类元素已折叠省略${snap.suppressedSummary ? `(${snap.suppressedSummary})` : ''}` : ''}):`,
      ...snap.elements,
    ];
    let out = lines.join('\n');
    if (out.length > MAX_OUTPUT_CHARS) out = `${out.slice(0, MAX_OUTPUT_CHARS)}\n…(输出超长已截断)`;
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}
