import { finder } from '@medv/finder';
import { filterCssPath, isStableCssPath, stripRuntimeAria, isUtilityClass, isTransientStateClass } from './selector-filter.js';

export interface Locator {
  strategy: 'role' | 'testId' | 'text' | 'css';
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

/** 属性名（aria-label / title / placeholder）：仅供 role 候选（Playwright 可访问名计算包含这些
 *  属性）与 css 属性候选（[title="..."]）。**不得**进 text 候选——回放 getByText 只匹配文本节点，
 *  而纯图标按钮的 title/aria-label 恰恰来自悬停提示文案（规则查看 用例根因之一：text "查看"
 *  实为 title 属性，回放 count=0）。
 */
function getAttrName(el: Element): string | null {
  const attr = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('placeholder');
  if (attr && attr.trim()) return attr.trim();
  return null;
}

/** 子树可见文本——text 候选唯一合法来源：
 *   - 叶子元素或 button / a / summary 这类「自叶子 UI」取子树文本；其他 layout 容器返回 null，
 *     避免回放锁定整个父容器。
 *   - 含 volatile 尾巴（时间、计数）的直接丢弃——避免「13 天前」「待澄清 1」让下次重放失效。
 *   - 长度超过 50 时切到最近的词边界，避免切在词中间。
 */
function getSubtreeText(el: Element): string | null {
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

/** role 候选的 name：属性名优先（Playwright 可访问名计算含 aria-label/title），回退子树文本。 */
function getAccessibleName(el: Element): string | null {
  return getAttrName(el) ?? getSubtreeText(el);
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
      // 瞬态交互态 class（hover-row / is-hover / cell-hover 等）录制瞬间在 DOM 上——用户鼠标
      // 正悬在那——但回放无鼠标悬停必不存在。finder 主路径不经过 filterCssPath 清洗，
      // 必须在候选源头拦住（规则查看 用例根因：录制时 tr 带 .hover-row，回放 count=0）。
      className: (name) => !isTransientStateClass(name),
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

/** 沿父链向上找一个稳定锚点（data-testid / 稳定 id / 已知语义 class）。最多上溯 4 层。
 *  现在已无 xpath 候选产出,本函数仅供 nearestStableAnchorTest / 历史数据回放兜底使用。 */
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

/** 位置链段（:nth-of-type / :nth-child）出现 ≥3 次视为纯位置链——DOM 结构稍变即碎。 */
const POSITIONAL_SEGMENTS_RE = /:(?:nth-of-type|nth-child)\(/g;
const POSITIONAL_CHAIN_LIMIT = 3;

/** 元素自身「可辨识」class：非瞬态/非 utility / 非组件库通用前缀（el-/ant-/ivu-）。
 *  如 .icon-chakan 这类项目语义类——位置链碎掉后仍能按类命中目标。 */
function distinctiveOwnClasses(el: Element): string[] {
  const cls = el.getAttribute('class');
  if (!cls) return [];
  return cls
    .split(/\s+/)
    .filter((c) => c.length >= 3 && !isTransientStateClass(c) && !isUtilityClass(c) && !/^(?:el-|ant-|ivu-)/.test(c));
}

/** 位置链降权兜底：finder 在无锚点页面会产出深层 :nth-of-type 链；元素自身带可辨识 class
 *  （如 .icon-chakan）时补一个自身 class 候选，放在链**之后**——链活着时轮不到它（不抢
 *  唯一性更强的大链，避免静默操作第一个匹配元素）；链碎后它仍能命中同类元素（多行图标
 *  会命中多个，回放取首个），比整条链 count=0 直接失败强。 */
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
  const name = attrName ?? subtreeText;
  if (role && name) push({ strategy: 'role', value: `${role}[name="${name.replace(/"/g, '\\"')}"]` });

  const testId = getTestId(el);
  if (testId) push({ strategy: 'testId', value: testId });

  const tag = el.tagName.toLowerCase();
  // text 候选只收子树真实文本节点（getByText 只匹配文本节点）；svg / path 的 innerText
  // 经常是父容器文案或空串，同样不产。
  if (subtreeText && subtreeText.length <= 50 && tag !== 'svg' && tag !== 'path') {
    push({ strategy: 'text', value: subtreeText });
  }

  // placeholder / name：表单元素最高 ROI 的语义属性，独立提为 css 候选。
  // - placeholder 是设计/文案迭代的视觉标签，跨 layout 改动稳；
  // - name 是表单提交用的语义名，对 input/select/textarea 一律稳定。
  // 两都通过 css 通道产出，复用回放端 css 候选解析路径（locator-resolver.ts 的 css 分支），
  // 回放端零改动。value 在写入 css 属性选择器前要转义双引号/反斜杠。
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

  // 属性名兜底 css 候选：纯图标按钮的 aria-label/title 是 DOM 常驻属性（悬停 tooltip 文案的
  // 常见落点），css 属性选择器可稳定命中——但 getByText 永远看不到它们。仅在没有子树文本时
  // 给出（有子树文本时 text 候选已覆盖同名语义，且子树文本才是用户可见文案）。
  if (attrName && !subtreeText) {
    for (const attr of ['aria-label', 'title'] as const) {
      const v = el.getAttribute(attr);
      if (v && v.trim() && v.trim().length <= 50) {
        const safe = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        push({ strategy: 'css', value: `[${attr}="${safe}"]` });
      }
    }
  }

  const css = buildCssPath(el, options);
  push({ strategy: 'css', value: css });
  const ownClass = positionalOwnClassCandidate(css, el);
  if (ownClass) push({ strategy: 'css', value: ownClass });

  return out.slice(0, MAX_CANDIDATES);
}
