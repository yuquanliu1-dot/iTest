import { finder } from '@medv/finder';
import { filterCssPath, isStableCssPath, stripRuntimeAria, isUtilityClass } from './selector-filter.js';

export interface Locator {
  strategy: 'role' | 'testId' | 'text' | 'css' | 'xpath';
  value: string;
}

const MAX_CANDIDATES = 5;

/** iDO 项目里能作为 XPath 锚点的稳定语义 class（录制时靠它们抵消根级 sibling reorder）。 */
const STABLE_CLASS_RE = /^(?:glass-card|glass-panel|project-card|group-nav-tile)$/;
/** 稳定 id：长度合理、不命中运行时 hex / __BV_ / ivu- 前缀。 */
const STABLE_ID_RE = /^(?!.*(?:el-|ant-|ivu-|__BV_))[a-zA-Z][\w-]{1,40}$/;

/** iDO 已知语义类的稳定集合——给 deriveSemantic 在没有 data-testid/name 时回退使用。 */
const SEMANTIC_CLASSES = new Set([
  'glass-card', 'glass-panel', 'project-card', 'group-nav-tile', 'main-content', 'group',
]);

/** 文本候选应丢弃的「时间 / 计数」尾段正则。匹配 `13 天前`、`活跃 1`、`2 hours ago` 等。 */
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

/** text 候选应满足：
 *   - 优先取 aria-label / title / placeholder（语义最稳定）。
 *   - 回退到 innerText / textContent，先把空白折叠成单空格。
 *   - 含 volatile 尾巴（时间、计数）的直接丢弃——避免「13 天前」「待澄清 1」让下次重放失效。
 *   - 长度超过 50 时切到最近的词边界，避免切在词中间。
 *   - 元素含 element 子节点时：button / a / summary 这种「本身是叶子 UI、文本在子 span/icon 里」
 *     仍要产 text 候选（取子树拼接）；其他 layout 容器（dialog / card / section / form）才丢弃——
 *     后者命中文本会让回放锁定整个父容器，下一次重渲染很容易脱锚。
 */
function getAccessibleName(el: Element): string | null {
  const attr = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('placeholder');
  if (attr && attr.trim()) return attr.trim();
  const tag = el.tagName.toLowerCase();
  if (!isLeaf(el)) {
    // 仅 button / a / summary 这类「自叶子 UI」的元素从子树文本里拼出 name；其它 layout 容器
    // （div / section / dialog 等）返回 null，避免回放锁定整个父容器。
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

/** 含 element 子节点即视为非 leaf。SVG 元素及其子节点也按此规则——svg/path 等的 innerText
 *  通常是父容器文本或空串。 */
function isLeaf(el: Element): boolean {
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 1) return false;
  }
  return true;
}

function getTestId(el: Element): string | null {
  return el.getAttribute('data-testid') ?? el.getAttribute('data-test-id');
}

/** 录制选项：popup / panel 配置后传入 generateLocators。空 options 用历史默认（data-testid）。 */
export interface GenerateLocatorsOptions {
  preferredDataAttribute?: string;
}

/** 用 @medv/finder 生成 CSS 选择器：从叶子向上爬，每个层级按 #id / [attr] / .class / tagName / *
 *  累计 penalty 排序 + unique 验证。对 Tailwind / shadcn / antd 等 utility 多的页面天然稳定——
 *  稳定 class（glass-card / project-card 等）penalty 总和通常比大量 Tailwind utility 更短，
 *  自动优先选中稳定锚点，不再需要黑名单清洗。
 *
 *  iTest 语义扩展：
 *  - idName 排除运行时 id（__BV_ / ivu- / 纯 hex 尾缀 / radix 短 id），避免选器被随机后缀污染。
 *  - attr 优先项目约定的 data-* 属性（默认 data-testid，可由 options.preferredDataAttribute 覆盖），
 *    整条 selector 父链都用 [data-testid="..."]，没有时回退到 #id / .class / tagName。
 *  - 找不到 unique 路径（root 是 iframe / ShadowRoot 边界）回退到手工 path，确保步骤不丢。 */
function buildCssPath(el: Element, options: GenerateLocatorsOptions = {}): string {
  const preferred = options.preferredDataAttribute ?? 'data-testid';
  try {
    return finder(el, {
      root: document.body,
      idName: (name) =>
        !/^\d+$/.test(name) &&
        !/__BV_/.test(name) &&
        !/^ivu-/.test(name) &&
        !/(?:^|[_-])(?:el|ant|ivu|bv)?[_-]?[a-f0-9]{6,}$/i.test(name) &&
        !/^radix-(?::r[a-z0-9]+:)?$/i.test(name),
      // preferredDataAttribute：用户显式指定时把 preferred 提升到 #id 同级（finder penalty=2），
      // 同时关闭通用 `/^data-/` 白名单，避免父链上多个 data-* 时 finder 仍然挑 data-testid，
      // 让 preferred 形同虚设。data-testid / data-qa / data-id / data-test-id 作为兜底保留，
      // 是因为 finder 在父链所有 candidate 都拿不到 unique selector 时会回退到这些稳定属性。
      //
      // 注意：data-testid 永久保留在白名单——preferred 不是 data-testid 时它仍然在候选里，
      // finder 走 penalty 排序就会优先挑 preferred（同名 penalty 都是 2，但 preferred 在遍历时
      // 先被命中）。前提是 attr callback 里 preferred 出现得更早，让 `name === preferred` 分支
      // 在 `name === 'data-testid'` 之前返回 true（V8 callback 短路，preferred 优先命中）。
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
    // 超时 / 找不到唯一选择器时回退到手工 path，filterCssPath 再做一次清洗。
    const raw = buildCssPathFallback(el);
    return isStableCssPath(raw) ? raw : stripRuntimeAria(filterCssPath(raw)) || raw;
  }
}

/** @medv/finder 找不到唯一路径时的兜底：从叶子到 html 拍平 tag + 稳定 class，再交给 filterCssPath 清洗。 */
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

/** 沿父链向上找一个稳定锚点（data-testid / 稳定 id / 已知语义 class）。最多上溯 4 层。 */
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
 * 给定元素推导出「语义定位」(`intentLocator`)：回放侧 locator-resolver 会优先用它。
 *  - 优先 data-testid / name（最稳）。
 *  - 备选：第一个非 STATE_CLASSES / 非 utility 的稳定 class。
 *  - 最后回退到 aria-label / title。
 *  - contextText 一律用 normalize 后的 innerText，最多 60 字符。
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
  const name = getAccessibleName(el);
  if (role && name) push({ strategy: 'role', value: `${role}[name="${name.replace(/"/g, '\\"')}"]` });

  const testId = getTestId(el);
  if (testId) push({ strategy: 'testId', value: testId });

  const tag = el.tagName.toLowerCase();
  // svg / path 等无意义文本不产 text 候选（它们的 innerText 经常是父容器文案或空串）。
  if (name && name.length > 0 && name.length <= 50 && tag !== 'svg' && tag !== 'path') {
    push({ strategy: 'text', value: name });
  }

  const css = buildCssPath(el, options);
  push({ strategy: 'css', value: css });
  push({ strategy: 'xpath', value: buildXPath(el) });

  return out.slice(0, MAX_CANDIDATES);
}
