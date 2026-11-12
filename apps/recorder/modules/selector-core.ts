import { finder } from '@medv/finder';
import { filterCssPath, isStableCssPath, stripRuntimeAria, isUtilityClass, isTransientStateClass } from './selector-filter.js';

export interface Locator {
  strategy: 'role' | 'testId' | 'text' | 'css';
  value: string;
}

const MAX_CANDIDATES = 5;

/** Stable semantic classes in the iDO project usable as XPath anchors (recording leans on them to cancel root-level sibling reorders). */
const STABLE_CLASS_RE = /^(?:glass-card|glass-panel|project-card|group-nav-tile)$/;
/** Stable id: reasonable length, no runtime hex / __BV_ / ivu- prefix hits. */
const STABLE_ID_RE = /^(?!.*(?:el-|ant-|ivu-|__BV_))[a-zA-Z][\w-]{1,40}$/;

/** Stable set of known iDO semantic classes — deriveSemantic's fallback when there is no data-testid/name. */
const SEMANTIC_CLASSES = new Set([
  'glass-card', 'glass-panel', 'project-card', 'group-nav-tile', 'main-content', 'group',
]);

/** "Time / count" tail regex that text candidates should drop. Matches `13 天前`, `活跃 1`, `2 hours ago`, etc. */
const VOLATILE_TAIL_RE = /\d+\s*(?:天|小时|分钟|秒|months?|days?|hours?|minutes?|seconds?|周|week)\s*(?:前|ago)|活跃\s*\d+|待澄清\s*\d+/i;

function getAccessibleRole(el: Element): string | null {
  const role = el.getAttribute('role');
  if (role) return role;
  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    return type === 'submit' || type === 'button' ? 'button' : 'textbox';
  }
  return null;
}

function normalize(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Attribute names (aria-label / title / placeholder): only for role candidates (Playwright's accessible-name
 *  computation includes these attributes) and css attribute candidates ([title="..."]). Must **never** enter text
 *  candidates — replay's getByText only matches text nodes, while a pure icon button's title/aria-label comes exactly
 *  from hover tooltip copy (one root cause of the 规则查看 case: text "查看" was actually the title attribute, replay count=0).
 */
function getAttrName(el: Element): string | null {
  const attr = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('placeholder');
  if (attr && attr.trim()) return attr.trim();
  return null;
}

/** Subtree visible text — the only legitimate source for text candidates:
 *   - Leaf elements or "self-leaf UI" like button / a / summary take the subtree text; other layout containers return null,
 *     so replay never locks onto a whole parent container.
 *   - Text with a volatile tail (time, count) is dropped outright — so "13 天前" or "待澄清 1" can't invalidate the next replay.
 *   - When longer than 50, cut at the nearest word boundary to avoid slicing mid-word.
 */
function getSubtreeText(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  if (!isLeaf(el)) {
    // Only "self-leaf UI" elements like button / a / summary build a name from subtree text; other layout containers
    // (div / section / dialog etc.) return null, so replay never locks onto a whole parent container.
    if (tag !== 'button' && tag !== 'a' && tag !== 'summary') return null;
  }
  const raw = normalize((el as HTMLElement).innerText ?? el.textContent);
  if (!raw) return null;
  if (VOLATILE_TAIL_RE.test(raw)) return null;
  if (raw.length <= 50) return raw;
  const slice = raw.slice(0, 50);
  const lastSpace = slice.lastIndexOf(' ');
  return lastSpace > 20 ? slice.slice(0, lastSpace) : slice;
}

/** label-associated text (<label for=id> / wrapping label): the accessible-name source when an input's subtree has no text.
 *  Only enters role candidates — getByRole's accessible-name computation includes label association; **never text
 *  candidates**: getByText only matches text nodes and the label text lives outside the target element, so replay would
 *  inevitably count=0 (same root cause as the 规则查看 case). */
function getLabelText(el: Element): string | null {
  const first = (el as HTMLInputElement).labels?.[0];
  if (!first) return null;
  const raw = normalize(first.innerText ?? first.textContent);
  if (!raw || raw.length > 50 || VOLATILE_TAIL_RE.test(raw)) return null;
  return raw;
}

/** The name for role candidates: attribute names first (Playwright's accessible-name computation includes aria-label/title),
 *  then label-associated text, falling back to subtree text. */
function getAccessibleName(el: Element): string | null {
  return getAttrName(el) ?? getLabelText(el) ?? getSubtreeText(el);
}

/** Having element child nodes means non-leaf. SVG elements and their children follow the same rule — svg/path innerText
 *  is usually the parent container's text or an empty string. */
function isLeaf(el: Element): boolean {
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 1) return false;
  }
  return true;
}

function getTestId(el: Element): string | null {
  return el.getAttribute('data-testid') ?? el.getAttribute('data-test-id');
}

/** Recording options: configured by popup / panel and passed into generateLocators. Empty options use the historical default (data-testid). */
export interface GenerateLocatorsOptions {
  preferredDataAttribute?: string;
}

/** Generates CSS selectors with @medv/finder: climbs from the leaf upward, ranking each level by cumulative penalty over
 *  #id / [attr] / .class / tagName / * with unique verification. Naturally stable on utility-heavy pages (Tailwind / shadcn /
 *  antd) — a stable class's (glass-card / project-card etc.) penalty total is usually shorter than piles of Tailwind
 *  utilities, so stable anchors are preferred automatically and blacklist scrubbing is no longer needed.
 *
 *  iTest semantic extensions:
 *  - idName excludes runtime ids (__BV_ / ivu- / pure-hex tails / radix short ids) so selectors aren't polluted by random suffixes.
 *  - attr prefers project-convention data-* attributes (default data-testid, overridable via options.preferredDataAttribute);
 *    the whole selector parent chain uses [data-testid="..."], falling back to #id / .class / tagName when absent.
 *  - When no unique path is found (root is an iframe / ShadowRoot boundary), falls back to a hand-built path so steps are never lost. */
function buildCssPath(el: Element, options: GenerateLocatorsOptions = {}): string {
  const preferred = options.preferredDataAttribute ?? 'data-testid';
  try {
    return finder(el, {
      root: document.body,
      // Transient interaction-state classes (hover-row / is-hover / cell-hover etc.) exist in the DOM at recording time —
      // the user's mouse is right there — but can never exist at replay with no mouse hovering. finder's main path doesn't
      // go through filterCssPath scrubbing, so they must be blocked at the candidate source (root cause of the 规则查看
      // case: the tr carried .hover-row at recording time, replay count=0).
      className: (name) => !isTransientStateClass(name),
      idName: (name) =>
        !/^\d+$/.test(name) &&
        !/__BV_/.test(name) &&
        !/^ivu-/.test(name) &&
        !/(?:^|[_-])(?:el|ant|ivu|bv)?[_-]?[a-f0-9]{6,}$/i.test(name) &&
        !/^radix-(?::r[a-z0-9]+:)?$/i.test(name),
      // preferredDataAttribute: when the user specifies it explicitly, promote preferred to #id's level (finder penalty=2)
      // and turn off the generic `/^data-/` whitelist — otherwise, with multiple data-* on the parent chain, finder would
      // still pick data-testid and the preferred option would be a no-op. data-testid / data-qa / data-id / data-test-id
      // are kept as fallbacks because finder falls back to these stable attributes when no candidate in the parent chain
      // yields a unique selector.
      //
      // Note: data-testid stays in the whitelist permanently — when preferred isn't data-testid it's still among the
      // candidates, and finder's penalty ranking will prefer preferred (same-name penalty is 2 for both, but preferred is
      // hit first during traversal). This requires preferred to appear earlier in the attr callback so the
      // `name === preferred` branch returns true before `name === 'data-testid'` (V8 callback short-circuit, preferred wins).
      attr: (name) =>
        name === preferred ||
        name === 'data-testid' ||
        name === 'data-test-id' ||
        name === 'data-qa' ||
        name === 'data-id' ||
        name === 'role' ||
        name === 'name' ||
        name === 'aria-label',
      seedMinLength: 3,
      optimizedMinLength: 2,
      timeoutMs: 300,
    });
  } catch (e) {
    // On timeout / no unique selector, fall back to the hand-built path; filterCssPath scrubs it once more.
    const raw = buildCssPathFallback(el);
    return isStableCssPath(raw) ? raw : stripRuntimeAria(filterCssPath(raw)) || raw;
  }
}

/** Fallback when @medv/finder can't find a unique path: flatten tag + stable classes from leaf to html, then hand to filterCssPath for scrubbing. */
function buildCssPathFallback(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName.toLowerCase() !== 'html') {
    const tag = cur.tagName.toLowerCase();
    const id = cur.id ? `#${cur.id}` : '';
    const cls = cur.className && typeof cur.className === 'string' ? `.${cur.className.split(/\s+/).join('.')}` : '';
    parts.unshift(`${tag}${id}${cls}`);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

/** Walks up the parent chain for a stable anchor (data-testid / stable id / known semantic class). Max 4 levels up.
 *  No xpath candidates are produced anymore; this function remains only for nearestStableAnchorTest / historical-data replay fallback. */
function nearestStableAnchor(el: Element): Element | null {
  let cur: Element | null = el.parentElement;
  let depth = 0;
  while (cur && depth < 4) {
    const id = cur.id;
    if (id && STABLE_ID_RE.test(id)) return cur;
    if (cur.getAttribute('data-testid')) return cur;
    const cls = (cur.getAttribute('class') || '').split(/\s+/);
    if (cls.some((c) => STABLE_CLASS_RE.test(c))) return cur;
    cur = cur.parentElement;
    depth += 1;
  }
  return null;
}

function buildXPath(el: Element): string {
  if (el.id && STABLE_ID_RE.test(el.id)) return `//*[@id="${el.id}"]`;
  const anchor = nearestStableAnchor(el);
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== anchor && cur.tagName.toLowerCase() !== 'html') {
    const parent: Element | null = cur.parentElement;
    if (!parent) break;
    const curTag = cur.tagName;
    const sameTag = Array.from(parent.children).filter((c: Element) => c.tagName === curTag);
    parts.unshift(`${cur.tagName.toLowerCase()}[${sameTag.indexOf(cur) + 1}]`);
    cur = parent;
  }
  if (anchor) {
    const idPart = anchor.id ? `[@id="${anchor.id}"]` : '';
    const clsHit = (anchor.getAttribute('class') || '').split(/\s+/).find((c) => STABLE_CLASS_RE.test(c));
    const clsPart = clsHit ? `[@class="${clsHit}"]` : '';
    return `//${anchor.tagName.toLowerCase()}${idPart}${clsPart}/${parts.join('/')}`;
  }
  return `/${parts.join('/')}`;
}

/**
 * Derives a "semantic locator" (`intentLocator`) from the given element: the replay-side locator-resolver prefers it.
 *  - data-testid / name first (most stable).
 *  - Next: the first stable class that is neither STATE_CLASSES nor a utility class.
 *  - Last resort: aria-label / title.
 *  - contextText always uses the normalized innerText, max 60 chars.
 */
export function deriveSemantic(el: Element): { semanticRole: string; contextText?: string } | undefined {
  const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id');
  const name = el.getAttribute('name');
  if (testId || name) {
    const ctx = normalize((el as HTMLElement).innerText ?? el.textContent).slice(0, 60) || undefined;
    return { semanticRole: (testId ?? name)!, contextText: ctx };
  }
  const cls = (el.getAttribute('class') || '').split(/\s+/).find(
    (c) =>
      /^[a-z][a-z0-9-]{2,30}$/.test(c) &&
      SEMANTIC_CLASSES.has(c) &&
      !isUtilityClass(c),
  );
  if (cls) {
    const ctx = normalize((el as HTMLElement).innerText ?? el.textContent).slice(0, 60) || undefined;
    return { semanticRole: cls, contextText: ctx };
  }
  const label = el.getAttribute('aria-label') ?? el.getAttribute('title');
  if (label) {
    const ctx = normalize((el as HTMLElement).innerText ?? el.textContent).slice(0, 60) || undefined;
    return { semanticRole: label.trim(), contextText: ctx };
  }
  return undefined;
}

/** ≥3 positional segments (:nth-of-type / :nth-child) counts as a pure positional chain — it shatters with the slightest DOM change. */
const POSITIONAL_SEGMENTS_RE = /:(?:nth-of-type|nth-child)\(/g;
const POSITIONAL_CHAIN_LIMIT = 3;

/** The element's own "distinctive" classes: not transient / not utility / not a component-library generic prefix (el-/ant-/ivu-).
 *  E.g. project semantic classes like .icon-chakan — even after the positional chain shatters, they can still hit the target by class. */
function distinctiveOwnClasses(el: Element): string[] {
  const cls = el.getAttribute('class');
  if (!cls) return [];
  return cls
    .split(/\s+/)
    .filter((c) => c.length >= 3 && !isTransientStateClass(c) && !isUtilityClass(c) && !/^(?:el-|ant-|ivu-)/.test(c));
}

/** Positional-chain downrank fallback: finder produces deep :nth-of-type chains on anchor-less pages; when the element
 *  carries its own distinctive class (e.g. .icon-chakan), add a self-class candidate placed **after** the chain — it's
 *  never used while the chain is alive (it doesn't steal from the stronger unique chain, avoiding silently operating on
 *  the first matched element); after the chain shatters it can still hit same-kind elements (multi-row icons will match
 *  several and replay takes the first) — better than the whole chain failing with count=0. */
export function positionalOwnClassCandidate(css: string, el: Element): string | null {
  const count = (css.match(POSITIONAL_SEGMENTS_RE) ?? []).length;
  if (count < POSITIONAL_CHAIN_LIMIT) return null;
  const own = distinctiveOwnClasses(el);
  return own.length > 0 ? `.${own.join('.')}` : null;
}

export function generateLocators(el: Element, options: GenerateLocatorsOptions = {}): Locator[] {
  const out: Locator[] = [];
  const seen = new Set<string>();

  const push = (loc: Locator) => {
    const key = `${loc.strategy}:${loc.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(loc);
  };

  const role = getAccessibleRole(el);
  const attrName = getAttrName(el);
  const subtreeText = getSubtreeText(el);
  // Accessible-name chain: attribute names → label-associated text → subtree text (getAccessibleName). Label association
  // only enters role candidates — getByRole's accessible-name computation includes label association, while getByText
  // can't match label text outside the target element.
  const name = getAccessibleName(el);
  if (role && name) push({ strategy: 'role', value: `${role}[name="${name.replace(/"/g, '\\"')}"]` });

  const testId = getTestId(el);
  if (testId) push({ strategy: 'testId', value: testId });

  const tag = el.tagName.toLowerCase();
  // text candidates only accept real subtree text nodes (getByText only matches text nodes); svg / path innerText
  // is often the parent container's copy or an empty string — also skipped.
  if (subtreeText && subtreeText.length <= 50 && tag !== 'svg' && tag !== 'path') {
    push({ strategy: 'text', value: subtreeText });
  }

  // placeholder / name: the highest-ROI semantic attributes for form elements, promoted to independent css candidates.
  // - placeholder is the visual label of design/copy iteration, stable across layout changes;
  // - name is the semantic name used for form submission, stable across input/select/textarea.
  // Both are produced via the css channel, reusing the replay-side css candidate resolution path (locator-resolver.ts's
  // css branch) — zero replay-side changes. Double quotes / backslashes must be escaped before writing the css attribute selector.
  const placeholder = el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) {
    const safe = placeholder.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    push({ strategy: 'css', value: `[placeholder="${safe}"]` });
  }
  const nameAttr = el.getAttribute('name');
  if (nameAttr && nameAttr.trim()) {
    const safe = nameAttr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    push({ strategy: 'css', value: `[name="${safe}"]` });
  }

  const css = buildCssPath(el, options);
  push({ strategy: 'css', value: css });

  // Attribute-name fallback css candidates: a pure icon button's aria-label/title is a DOM-resident attribute (the common
  // home of hover tooltip copy) that css attribute selectors hit reliably — but getByText can never see them. Only given
  // when there's no subtree text (with subtree text, the text candidate already covers the same semantics, and the subtree
  // text is what the user actually sees).
  // Must come after the finder chain: every row of a table's action column has icons with the same title, so candidates
  // like [title="查看"] naturally multi-match; the strongest-unique chain goes first, and replay's first probe hits the
  // right element (规则查看 backtest: [title] ranked first made .first() grab the .hidden-columns hidden clone).
  if (attrName && !subtreeText) {
    for (const attr of ['aria-label', 'title'] as const) {
      const v = el.getAttribute(attr);
      if (v && v.trim() && v.trim().length <= 50) {
        const safe = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        push({ strategy: 'css', value: `[${attr}="${safe}"]` });
      }
    }
  }

  const ownClass = positionalOwnClassCandidate(css, el);
  if (ownClass) push({ strategy: 'css', value: ownClass });

  return out.slice(0, MAX_CANDIDATES);
}
