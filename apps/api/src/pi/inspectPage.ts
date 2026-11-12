/**
 * Fetches the SUT page and extracts the interactive element list for the inspect_page tool to
 * inject "the page's actual code" into LLM context. The launch mode matches execute/cdp.ts
 * (CHROMIUM_PATH override); DOM extraction follows the page.evaluate injection convention of
 * domFallback.ts.
 * Guards: http/https only + goto timeout + element/output length caps (intranet SUT addresses
 * are the core scenario; no private-network blocking).
 * extractPageElements is reused by verify_case failure-page/success-page snapshots (the
 * success-page list constrains the agent's next step to referencing only real controls).
 */
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';

const GOTO_TIMEOUT_MS = 20_000;
const SETTLE_MS = 800;
/** Browser-side raw candidate cap: only guards against runaway (large table pages can have thousands of nodes); sorting/dedup happen on the TS side. */
const RAW_MAX_CANDIDATES = 800;
/** Cap on element entries finally output to the model (after dedup). */
const MAX_ELEMENTS = 90;
/** Keep cap for pure [role] containers (treeitem/row/gridcell data nodes): homogeneous, low information, but in the hundreds or thousands. */
const MAX_ROLE_LIKE = 12;
/** Keep cap for checkboxes/radios (mostly table row selectors): no text, highly homogeneous. */
const MAX_BULK_CONTROLS = 6;
const MAX_OUTPUT_CHARS = 30_000;

/**
 * DOM extraction must be passed to page.evaluate as a string expression: tsx/esbuild(keepNames)
 * injects __name(...) helper calls into compiled function bodies; when Playwright serializes the
 * callback via fn.toString() and ships it to the browser, __name does not exist there — instant
 * ReferenceError. The string form is evaluated as-is and is unaffected.
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

/** Raw candidate elements collected from the browser (EXTRACT_JS product; an empty-string field means the attribute is absent). */
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

/** Tiers: action = actionable controls (buttons/inputs/dropdowns/links…); structure = pure [role] containers
 *  (treeitem/row data nodes); bulk = checkboxes/radios (mostly table row selectors, no text, highly homogeneous). */
type CandidateTier = 'action' | 'structure' | 'bulk';

const CONTROL_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
/** Containers whose role itself is actionable (dropdown options/tabs/menu items etc.): treated as action controls regardless of tag. */
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

/** Element information score (for within-tier sorting): controls with readable text/placeholder/aria rank first; anonymous ones sink. */
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
 * Element-list denoising sort (signal-to-noise rework, 2026-10-28):
 * The old implementation emitted in DOM order with a hard 300-entry cut — on tree-table pages
 * 200+ role=treeitem rows and nameless checkboxes pushed toolbar buttons (new/delete/import/
 * export/query) to the end of the list, or into the output-length cap;
 * an agent without the real control list would fabricate filters that do not exist on the page.
 * Rules:
 * 1. Same-selector dedup folding (×N count) — nameless checkboxes/repeated row buttons are no longer listed one by one;
 * 2. Tier caps: action controls all kept, pure [role] containers ≤ MAX_ROLE_LIKE, checkboxes/radios ≤ MAX_BULK_CONTROLS;
 * 3. Within-tier descending by information (text/placeholder/aria…); after cross-tier merge the MAX_ELEMENTS total cap still applies;
 * 4. The omitted count and class summary return with the list (suppressed/suppressedSummary), so "does a same-class target exist" stays answerable.
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
  /** Number of elements omitted by class caps/total cap (including pre-fold duplicates of the same selector). */
  suppressed?: number;
  /** Class summary of omitted elements (e.g. "role=treeitem ×88"): count these classes when judging whether a same-class target exists. */
  suppressedSummary?: string;
  /** Total visible candidate elements on the page (before dedup/caps): used for page quality self-assessment, so dedup cannot mistake a real page for an empty shell. */
  candidateCount?: number;
}

export type PageQuality = 'ok' | 'low';

/** Page fetch quality self-assessment: decides "real functional page vs empty shell/error page", letting
 *  inspect_page tell the model whether the URL is trustworthy.
 *  The criteria are the page's own features (interactive element count / body text length), bound to no
 *  specific target system — empty shells (login shell, 404, unmounted micro-frontend container) score
 *  extremely low on both in any system.
 *  Threshold: interactive elements < 5 or body text < 100 chars means low quality. Element count uses the
 *  pre-dedup candidate total (candidateCount) — the post-dedup/cap list length does not reflect real density. */
export function assessPageQuality(
  snap: Pick<PageElementSnapshot, 'title' | 'bodyLen' | 'elements' | 'candidateCount'>,
): PageQuality {
  const n = Math.max(snap.elements.length, snap.candidateCount ?? 0);
  if (n < 5 || snap.bodyLen < 100) return 'low';
  return 'ok';
}

/** Extracts the interactive element list from an already-open page (shared by inspect_page and verify_case
 *  page snapshots: failure pages give the agent locators to fix; success pages give the agent real controls
 *  to discuss "which real control to use next"). */
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

/** Failure-page structural evidence: list of blocking overlays.
 *
 *  After the 2026-10-17 attribution rework, missingIds (expected-container-missing verdict) is retired:
 *  it extracted the expected container by parsing css strategy's #id/[id=] shapes and broke the moment
 *  text=/role/xpath/testId were used (a whack-a-mole path). Whether a container is absent is now probed
 *  live per locator candidate by failureDiagnosis.probeLocatorHits (shape-agnostic), jointly fed to the
 *  LLM with the element list for attribution. Only the overlay list remains here: role/class-name features
 *  only (role=dialog, class containing dialog/drawer/message-box/modal/popup/mask/overlay), bound to no
 *  specific system's copy — conditional overlays ("may pop, may not pop": draft recovery, permission
 *  confirmation) present as exactly these DOM features in any system.
 */
export interface PageEvidence {
  /** Overlays on the page that may block interaction (dialogs/drawers/masks). Each: tag + locatable selector + text snippet */
  overlays: Array<{ tag: string; selector: string; text: string }>;
}

/** Overlay candidate selectors: cover common modal/drawer/message-box/mask implementations. DOM features only, no system-specific copy. */
const EVIDENCE_OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [class*="dialog"], [class*="drawer"], [class*="message-box"], ' +
  '[class*="modal"], [class*="popup"], [class*="mask"], [class*="overlay"]';

/** keepNames constraint (same as EXTRACT_JS): the returned string expression is evaluated by the browser as-is, avoiding __name helper injection. */
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

/** Collects structural evidence from an already-open page (reused by verify_case / solidify_case failure pages). Any exception silently degrades to empty evidence. */
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
    // Intranet SUT environments commonly use self-signed certificates; validation must be ignored or inspect_page is unusable in the core scenario
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
