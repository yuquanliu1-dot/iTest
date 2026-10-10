const STATE_CLASSES = new Set([
  'active', 'selected', 'disabled', 'hover', 'focus',
  'loading', 'open', 'show', 'checked', 'expanded',
  'collapsed', 'current',
]);
/** UI 组件库的运行时交互态 class：录制瞬间存在——用户鼠标正悬在行/按钮上——回放（无鼠标悬停）
 *  必然不存在，固化进 css 链回放必 count=0（规则查看 用例根因：el-table 悬停行 .hover-row）。
 *  Element-UI：hover-row（表格悬停行）/ current-row（高亮行）/ is-hover / is-active；
 *  通用命名：hovering / focused / mouse-in。 */
const TRANSIENT_STATE_CLASS_RE = /^(?:hover-row|current-row|hovering|focused|mouse-in)$/i;
/** 后缀族：cell-hover / row-hover / ant-table-cell-row-hover / tab-active / btn-selected 等——
 *  以 -hover/-focus/-active/-selected 结尾的 class 几乎全是交互态样式钩子，按瞬态丢弃。 */
const TRANSIENT_CLASS_TAIL_RE = /-(?:hover|focus|active|selected)$/i;

/** class 是否运行时瞬态（STATE_CLASSES 精确集 + UI 库瞬态族）：录制存在、回放必无。
 *  selector-core 的 finder className 过滤与本文件的两条清洗路径（hasUnstableClass / filterSegment）
 *  共用同一口径——finder 产物不掺瞬态类，兜底清洗也能把它们剥掉。 */
export function isTransientStateClass(cls: string): boolean {
  return STATE_CLASSES.has(cls) || TRANSIENT_STATE_CLASS_RE.test(cls) || TRANSIENT_CLASS_TAIL_RE.test(cls);
}
/** Radix / shadcn 等组件库在运行时挂的状态属性。`data-[state=open]:animate-in` 这类属性选择器
 *  在 buildCssPath 时会被当成 class 段保留下来，但每次 state 切换都会变化，必须当作 STATE 丢掉。
 *  扁平切分后会出现四种 token：
 *    `.data-`（首段 class 段，已被 splitCssTokens 合并为 `.data-[state=open]`）
 *    `.data-[state=...]`（含完整 attribute 的 class 段）
 *    `[state=open]`（属性选择器段）
 *    `:animate-in` / `:fade-out-0`（跟在 attribute 后的 variant selector）
 *  都需要命中后丢弃。 */
const STATE_ATTR_RE = /^data-\[state=|^\[state=|\[state=/i;
const STATE_ATTR_CLASS_RE = /^data-$/;
/** Tailwind v3 / v4 arbitrary value 里数字类（如 `col-5`、`grid-cols-3`、`w-1/2`、`basis-1/3`）合并后
 *  偶尔会留下纯数字 class。语义为零，直接废。 */
const NUMERIC_CLASS_RE = /^\d+$/;
const RUNTIME_ID_RE = /(?:^|[_-])(?:el|ant|ivu|bv)?[_-]?[a-f0-9]{6,}$/i;
const BV_ID_RE = /__BV_[a-z0-9_]+/i;
/** Tailwind UI 用的运行时 id：`radix-:r37:` / `radix-:r1ab:` 等短 base36 串，长度不够 6 位 hex 进 RUNTIME_ID_RE。 */
const RADIX_ID_RE = /^radix-(:r[a-z0-9]+:)?$/i;
/** Tailwind v4 animation utilities（animate-in / animate-out / fade-in-50 / fade-out-0 等）。
 *  这些类被 `:` 切出来时没有 `.` / `[` 前缀，统一在 `:` 分支按 ANIMATION_RE 兜底。 */
const ANIMATION_RE = /^(?:fade|zoom|spin|slide)-(?:in|out)(?:-\d+)?$|^animate-(?:in|out)(?:-\d+)?$/;
const IVU_PREFIX = /^ivu-/;
const EL_HEX_TAIL = /^el-[a-f0-9]{4,}/;
const ANT_HEX_TAIL = /^ant-[a-f0-9]{4,}/;

/** Tailwind 工具类前缀（按 Tailwind v3/v4 公用子集）。匹配形如 `flex`、`w-1/2`、`hover:bg-blue-500`。 */
const TW_PREFIXES = [
  'bg', 'text', 'p', 'py', 'px', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe',
  'm', 'my', 'mx', 'mt', 'mr', 'mb', 'ml', 'ms', 'me',
  'w', 'h', 'min-w', 'max-w', 'min-h', 'max-h',
  'size', 'flex', 'inline-flex', 'grid', 'inline-grid', 'gap', 'gap-x', 'gap-y',
  'rounded', 'rounded-s', 'rounded-e', 'rounded-t', 'rounded-r', 'rounded-b', 'rounded-l', 'rounded-tl', 'rounded-tr', 'rounded-br', 'rounded-bl',
  'border', 'border-x', 'border-y', 'border-t', 'border-r', 'border-b', 'border-l', 'border-s', 'border-e',
  'shadow', 'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl', 'shadow-2xl', 'shadow-inner', 'shadow-none',
  'opacity', 'transition', 'duration', 'ease', 'delay', 'animate',
  'font', 'leading', 'tracking', 'italic', 'underline', 'line-through', 'no-underline', 'antialiased',
  'min', 'max',
  'absolute', 'relative', 'fixed', 'sticky', 'static',
  'top', 'bottom', 'left', 'right', 'inset', 'inset-x', 'inset-y', 'start', 'end',
  'z',
  'overflow', 'overflow-x', 'overflow-y',
  'cursor', 'select', 'whitespace', 'truncate',
  'space-x', 'space-y',
  'divide', 'divide-x', 'divide-y',
  'placeholder',
  'outline', 'ring', 'ring-offset',
  'fill', 'stroke',
  'backdrop',
  'justify', 'justify-start', 'justify-end', 'justify-center', 'justify-between', 'justify-around', 'justify-evenly',
  'items', 'items-start', 'items-end', 'items-center', 'items-baseline', 'items-stretch',
  'self', 'self-auto', 'self-start', 'self-end', 'self-center', 'self-stretch',
  'order',
  'content', 'content-center', 'content-start', 'content-end', 'content-between', 'content-around', 'content-evenly', 'content-baseline',
  'col', 'col-auto', 'col-span', 'col-start', 'col-end',
  'row', 'row-auto', 'row-span', 'row-start', 'row-end',
  'aspect', 'aspect-auto', 'aspect-square', 'aspect-video',
  'origin',
  'scale', 'scale-x', 'scale-y', 'rotate', 'translate', 'translate-x', 'translate-y', 'skew', 'skew-x', 'skew-y',
  'sr',
  'isolate', 'isolation',
  'object', 'object-contain', 'object-cover', 'object-fill', 'object-none', 'object-scale-down',
  'caret',
  'accent',
  'pointer', 'pointer-events', 'pointer-none',
  'appearance',
  'user', 'user-select',
  'resize',
  'touch',
  'overscroll', 'overscroll-x', 'overscroll-y',
  'scroll', 'scroll-smooth',
  'drag', 'drag-none',
  'column',
  'break',
  'hyphens',
  'tab', 'tab-size',
];
/** Tailwind 工具类值段规则（用于 TW_RE 与 arbitrary 值分支）。Tailwind v3/v4 值通常是：
 *  - 颜色 / 数字：`bg-blue-500`、`text-[14px]`、`mt-2`
 *  - arbitrary 方括号：`text-[14px]`、`w-[1rem]`、`bg-[#7c5cfc]`、`grid-cols-[1fr_2fr]`、`mt-[-2px]`
 *  - 关键：方括号是值的一部分，`a-z`/`a-z0-9`/连字符外允许 `[...]` / 负号 / `#` / `_`。
 *  把 `(?:-(?:[a-z0-9]+(?:-[a-z0-9]+)*))?` 扩展到允许任意方括号/负号/十六进制值。 */
const TW_VALUE_RE = String.raw`(?:-(?:[a-z0-9#_\[\]/.\-]+(?:-[a-z0-9#_\[\]/.\-]+)*))?`;
const TW_RE = new RegExp(`^(?:${TW_PREFIXES.join('|')})${TW_VALUE_RE}$`);

/** 项目语义类反例：不会被 isUtilityClass 误判。
 *  Tailwind 工具前缀 `m`/`my`/`mt` 会匹配 `my-component` / `mt-card` 等任意 `xx-yy` 模式，必须把
 *  这些可能与项目语义类碰撞的 token 列出来保留。`my` 和 `mt` 是 iTest 源码里真出现过的语义前缀
 *  （MyProjects / MyReports），`mx`/`mr`/`ml` 也保留扩展位。 */
const SEMANTIC_KEEP = new Set([
  'glass-card', 'glass-panel', 'project-card', 'group-nav-tile', 'main-content', 'group',
  // 项目语义前缀：被 `m`/`my`/`mt`/`mx`/`mr`/`mb`/`ml` 误判的项目类
  'my-component', 'my-projects', 'my-reports', 'mt-card', 'mt-form', 'mx-table', 'mr-item', 'mb-section', 'ml-aside',
]);

/** 判断一个 class 是否 Tailwind 工具类（CSS 候选应剥离以减少重渲染失效面）。 */
export function isUtilityClass(cls: string): boolean {
  if (SEMANTIC_KEEP.has(cls)) return false;
  // Tailwind 任意值：`text-[14px]` / `w-[1rem]` / `mt-[-2px]` / `bg-[#7c5cfc]` / `grid-cols-[1fr_2fr]`。
  // className 拿到的是合法 CSS 字面量，方括号内的内容是稳定标识，仍然属于 utility。
  if (/^[a-z-]+-\[[^\]]+\]$/.test(cls)) return true;
  // Tailwind 变体前缀：`hover:bg-blue-500` / `disabled:cursor-not-allowed` / `md:flex-row` / `dark:bg-zinc-900`。
  // 任意层数的变体都允许。去掉变体后再走前缀判断。
  const base = stripVariantPrefixes(cls);
  if (base !== cls && TW_RE.test(base)) return true;
  return TW_RE.test(cls);
}

/** 递归去掉 Tailwind 变体前缀（`hover:` / `disabled:` / `md:` / `dark:` / `group-hover:` 等），保留最后一段。
 *  仅用于辅助 isUtilityClass，不要求对所有变体完备——命中不到就当作非 utility。 */
function stripVariantPrefixes(cls: string): string {
  let cur = cls;
  for (let i = 0; i < 4; i++) {
    const idx = cur.indexOf(':');
    if (idx <= 0) break;
    const head = cur.slice(0, idx);
    // 单段变体必须是纯小写字母 + 短横线（如 `hover` / `md` / `dark` / `group-hover`）。
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(head)) break;
    cur = cur.slice(idx + 1);
  }
  return cur;
}

export function isStableCssPath(path: string): boolean {
  if (hasUnstableClass(path)) return false;
  const idMatch = path.match(/#([\w:-]+)/);
  if (idMatch) {
    const id = idMatch[1]!;
    if (/^\d+$/.test(id)) return false;
    if (BV_ID_RE.test(id)) return false;
    if (RUNTIME_ID_RE.test(id)) return false;
    if (IVU_PREFIX.test(id)) return false;
    if (RADIX_ID_RE.test(id)) return false;
  }
  return true;
}

export function hasUnstableClass(path: string): boolean {
  return path
    .split(' > ')
    .flatMap((seg) => splitCssTokens(seg))
    .some((tok) => {
      // `[state=open]:animate-in` 这类被 buildCssPath 拼到 className 后又被扁平切分出来的
      // 属性选择器段：token 以 `[` 开头，里面命中 STATE_ATTR_RE（`data-[state=...` 或
      // `[state=...`）一律视为状态 class 丢弃。
      if (STATE_ATTR_RE.test(tok)) return true;
      // splitCssTokens 切出来的 Radix variant selector（如 `:animate-in`）：以 `:` 开头，
      // 去掉 `:` 后如果是 Tailwind v4 animation utility（animate-in / fade-out-0 / zoom-in-50 等），
      // 按 unstable 丢弃。其它 Tailwind variant（`hover:` / `md:` / `dark:`）的 base 走 isUtilityClass。
      if (tok.startsWith(':')) {
        const variant = tok.slice(1);
        return ANIMATION_RE.test(variant) || isUtilityClass(variant);
      }
      if (!tok.startsWith('.')) return false;
      const cls = tok.slice(1);
      return (
        isTransientStateClass(cls) ||
        STATE_ATTR_CLASS_RE.test(cls) ||
        (IVU_PREFIX.test(cls) && !/^ivu-btn|^ivu-select/.test(cls)) ||
        EL_HEX_TAIL.test(cls) ||
        ANT_HEX_TAIL.test(cls) ||
        NUMERIC_CLASS_RE.test(cls) ||
        isUtilityClass(cls)
      );
    });
}

export function filterCssPath(path: string): string {
  return path
    .split(' > ')
    .map((segment) => filterSegment(segment))
    .filter((s) => s.length > 0)
    .join(' > ');
}

function filterSegment(seg: string): string {
  // 去掉运行时 id（如 #login-7f9c3a）— 整段只剩 tag 时仍保留片段。
  let cleaned = stripRuntimeId(seg);
  const parts = splitCssTokens(cleaned);
  const kept = parts.filter((tok) => {
    if (STATE_ATTR_RE.test(tok)) return false;
    // `[state=open]:animate-in` 这类 Radix variant selector（`:animate-in` 跟在属性段后面）
    // 没有 `.` / `[` 前缀，会被 split 切成独立 token。Tailwind v4 animation utility（`animate-in`
    // / `fade-out-0` / `zoom-in-50` 等）同样以 `:` 切出，统一按 ANIMATION_RE + isUtilityClass 丢掉。
    if (tok.startsWith(':')) {
      const variant = tok.slice(1);
      return !(ANIMATION_RE.test(variant) || isUtilityClass(variant));
    }
    if (!tok.startsWith('.')) return true;
    const cls = tok.slice(1);
    if (isTransientStateClass(cls)) return false;
    if (NUMERIC_CLASS_RE.test(cls)) return false;
    if (STATE_ATTR_CLASS_RE.test(cls)) return false;
    if (IVU_PREFIX.test(cls) && !/^ivu-btn|^ivu-select/.test(cls)) return false;
    if (EL_HEX_TAIL.test(cls)) return false;
    if (ANT_HEX_TAIL.test(cls)) return false;
    if (isUtilityClass(cls)) return false;
    return true;
  });
  const joined = kept.join('');
  return stripRuntimeAria(joined);
}

/** 把 css 选择器段切成 `[tag, .class1, .class2, [attr], #id]` token 数组。
 *  与原 `split(/(?=[.#[])/)` 不同：本函数遇到 `[` 时识别 Tailwind arbitrary value
 *  (`text-[14px]` / `bg-[#7c5cfc]`) 合并为一个整体，避免后续 utility 判定时被切碎。
 *  - `[name=value]` / `[data-state="open"]` 这类纯属性选择器保留原样。 */
function splitCssTokens(seg: string): string[] {
  const out: string[] = [];
  let i = 0;
  const isDelim = (c: string) => c === '.' || c === '#' || c === '[';
  while (i < seg.length) {
    if (isDelim(seg[i]!)) {
      // 任意值：`xxx-[value]` 中方括号需要被合并进 class
      if (seg[i] === '.' && seg[i + 1] !== undefined) {
        // 扫描一个 className（含 `-[...]` 任意值）直到下一个分隔符
        const start = i;
        i += 1; // 跳过 '.'
        while (i < seg.length && !isDelim(seg[i]!)) i += 1;
        // 如果 class 名以 `-` 结尾且后面紧跟 `[`，把方括号内容一起吞下
        if (seg[i] === '[') {
          const close = seg.indexOf(']', i);
          if (close !== -1) {
            i = close + 1;
          }
        }
        out.push(seg.slice(start, i));
        continue;
      }
      if (seg[i] === '[') {
        const close = seg.indexOf(']', i);
        if (close === -1) {
          out.push(seg.slice(i));
          i = seg.length;
        } else {
          out.push(seg.slice(i, close + 1));
          i = close + 1;
        }
        continue;
      }
      // #id：扫到非 word 字符
      const start = i;
      i += 1;
      while (i < seg.length && /[\w-]/.test(seg[i]!)) i += 1;
      out.push(seg.slice(start, i));
      continue;
    }
    // tag / 连续非分隔符
    const start = i;
    while (i < seg.length && !isDelim(seg[i]!)) i += 1;
    out.push(seg.slice(start, i));
  }
  return out;
}

function stripRuntimeId(seg: string): string {
  return seg.replace(/#([\w:-]+)/g, (m, id) => {
    if (/^\d+$/.test(id)) return '';
    if (BV_ID_RE.test(id)) return '';
    if (RUNTIME_ID_RE.test(id)) return '';
    if (IVU_PREFIX.test(id)) return '';
    if (RADIX_ID_RE.test(id)) return '';
    return m;
  });
}

export function stripRuntimeAria(path: string): string {
  return path
    .replace(/\[aria-controls="[^"]*"\]/g, '')
    .replace(/\[aria-describedby="[^"]*"\]/g, '')
    .replace(/\[aria-activedescendant="[^"]*"\]/g, '');
}