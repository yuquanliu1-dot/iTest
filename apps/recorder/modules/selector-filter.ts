const STATE_CLASSES = new Set([
  'active', 'selected', 'disabled', 'hover', 'focus',
  'loading', 'open', 'show', 'checked', 'expanded',
  'collapsed', 'current',
]);
/** UI component libraries' runtime interaction-state classes: present at recording time — the user's mouse is hovering
 *  the row/button — but necessarily absent at replay (no mouse hover), so solidifying them into a css chain guarantees
 *  replay count=0 (root cause of the 规则查看 case: el-table hovered row .hover-row).
 *  Element-UI: hover-row (table hovered row) / current-row (highlighted row) / is-hover / is-active;
 *  generic naming: hovering / focused / mouse-in. */
const TRANSIENT_STATE_CLASS_RE = /^(?:hover-row|current-row|hovering|focused|mouse-in)$/i;
/** Suffix family: cell-hover / row-hover / ant-table-cell-row-hover / tab-active / btn-selected etc. —
 *  classes ending in -hover/-focus/-active/-selected are almost all interaction-state style hooks; dropped as transient. */
const TRANSIENT_CLASS_TAIL_RE = /-(?:hover|focus|active|selected)$/i;
/** Element-UI runtime positional classes: `el-table_{component instance index}` / `el-table_{instance index}_column_{column index}`.
 *  Instance index = the Nth el-table component created in this page load; column index = the column's registration order
 *  within the table — micro-app mount timing, conditional columns/column config, any rendering difference between the
 *  recording and replay sides makes them mismatch (root cause of the asset-management asset-edit case:
 *  `.has-gutter .el-table_1_column_4 > .cell` replayed count=0, while the "主识别IP" header was clearly on the page).
 *  Note BEM-style names like `el-table__header-wrapper` / `el-table__row` carry no `_数字` index and don't match this pattern. */
const RUNTIME_POSITIONAL_CLASS_RE = /^el-table_\d+(?:_column_\d+)?$/i;
/** Element-UI header-row layout-state class: rendered only when a horizontal gutter (scrollbar spacer column) exists;
 *  widen the viewport / the scrollbar disappears and it's gone — same family as hover-row's "present at recording, maybe absent at replay". */
const LAYOUT_GUTTER_CLASS_RE = /^has-gutter$/i;

/** Whether a class is a runtime transient/positional class (STATE_CLASSES exact set + UI library transient family +
 *  Element-UI runtime positional/layout states): present at recording, necessarily absent at replay or drifting across sessions.
 *  selector-core's finder className filter and this file's two scrub paths (hasUnstableClass / filterSegment) share the
 *  same convention — finder output carries no transient classes, and the fallback scrubbing can strip them too. */
export function isTransientStateClass(cls: string): boolean {
  return (
    STATE_CLASSES.has(cls) ||
    TRANSIENT_STATE_CLASS_RE.test(cls) ||
    TRANSIENT_CLASS_TAIL_RE.test(cls) ||
    RUNTIME_POSITIONAL_CLASS_RE.test(cls) ||
    LAYOUT_GUTTER_CLASS_RE.test(cls)
  );
}
/** State attributes attached at runtime by component libraries like Radix / shadcn. Attribute selectors like
 *  `data-[state=open]:animate-in` get kept as class segments by buildCssPath, but they change on every state toggle and
 *  must be dropped as STATE. After flat splitting, four kinds of token appear:
 *    `.data-` (leading class segment, already merged by splitCssTokens into `.data-[state=open]`)
 *    `.data-[state=...]` (class segment containing the full attribute)
 *    `[state=open]` (attribute-selector segment)
 *    `:animate-in` / `:fade-out-0` (variant selector following the attribute)
 *  All must be matched and dropped. */
const STATE_ATTR_RE = /^data-\[state=|^\[state=|\[state=/i;
const STATE_ATTR_CLASS_RE = /^data-$/;
/** Numeric classes (e.g. `col-5`, `grid-cols-3`, `w-1/2`, `basis-1/3`) occasionally left over after merging Tailwind v3/v4
 *  arbitrary values. Zero semantics — discard outright. */
const NUMERIC_CLASS_RE = /^\d+$/;
const RUNTIME_ID_RE = /(?:^|[_-])(?:el|ant|ivu|bv)?[_-]?[a-f0-9]{6,}$/i;
const BV_ID_RE = /__BV_[a-z0-9_]+/i;
/** Runtime ids used by Tailwind UI: short base36 strings like `radix-:r37:` / `radix-:r1ab:` — too short to reach RUNTIME_ID_RE's 6-hex-digit threshold. */
const RADIX_ID_RE = /^radix-(:r[a-z0-9]+:)?$/i;
/** Tailwind v4 animation utilities (animate-in / animate-out / fade-in-50 / fade-out-0 etc.).
 *  These classes have no `.` / `[` prefix when split out by `:`; uniformly handled in the `:` branch via ANIMATION_RE. */
const ANIMATION_RE = /^(?:fade|zoom|spin|slide)-(?:in|out)(?:-\d+)?$|^animate-(?:in|out)(?:-\d+)?$/;
const IVU_PREFIX = /^ivu-/;
const EL_HEX_TAIL = /^el-[a-f0-9]{4,}/;
const ANT_HEX_TAIL = /^ant-[a-f0-9]{4,}/;

/** Tailwind utility class prefixes (per the common Tailwind v3/v4 subset). Matches shapes like `flex`, `w-1/2`, `hover:bg-blue-500`. */
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
/** Tailwind utility value-segment rule (used by TW_RE and the arbitrary-value branch). Tailwind v3/v4 values are usually:
 *  - colors / numbers: `bg-blue-500`, `text-[14px]`, `mt-2`
 *  - arbitrary brackets: `text-[14px]`, `w-[1rem]`, `bg-[#7c5cfc]`, `grid-cols-[1fr_2fr]`, `mt-[-2px]`
 *  - key point: the bracket is part of the value; beyond `a-z`/`a-z0-9`/hyphens, `[...]` / minus / `#` / `_` are allowed.
 *  `(?:-(?:[a-z0-9]+(?:-[a-z0-9]+)*))?` is extended to allow arbitrary brackets/minus/hex values. */
const TW_VALUE_RE = String.raw`(?:-(?:[a-z0-9#_\[\]/.\-]+(?:-[a-z0-9#_\[\]/.\-]+)*))?`;
const TW_RE = new RegExp(`^(?:${TW_PREFIXES.join('|')})${TW_VALUE_RE}$`);

/** Project semantic-class counterexamples that isUtilityClass must not misjudge.
 *  Tailwind utility prefixes `m`/`my`/`mt` match any `xx-yy` pattern like `my-component` / `mt-card`, so tokens that could
 *  collide with project semantic classes must be listed here and kept. `my` and `mt` are semantic prefixes that really
 *  occurred in iTest source (MyProjects / MyReports); `mx`/`mr`/`ml` are kept as extension slots too. */
const SEMANTIC_KEEP = new Set([
  'glass-card', 'glass-panel', 'project-card', 'group-nav-tile', 'main-content', 'group',
  // project semantic prefixes: project classes misjudged by `m`/`my`/`mt`/`mx`/`mr`/`mb`/`ml`
  'my-component', 'my-projects', 'my-reports', 'mt-card', 'mt-form', 'mx-table', 'mr-item', 'mb-section', 'ml-aside',
]);

/** Whether a class is a Tailwind utility (css candidates should strip these to shrink the re-render invalidation surface). */
export function isUtilityClass(cls: string): boolean {
  if (SEMANTIC_KEEP.has(cls)) return false;
  // Tailwind arbitrary values: `text-[14px]` / `w-[1rem]` / `mt-[-2px]` / `bg-[#7c5cfc]` / `grid-cols-[1fr_2fr]`.
  // className holds a legal CSS literal; the bracket content is a stable identifier and still counts as a utility.
  if (/^[a-z-]+-\[[^\]]+\]$/.test(cls)) return true;
  // Tailwind variant prefixes: `hover:bg-blue-500` / `disabled:cursor-not-allowed` / `md:flex-row` / `dark:bg-zinc-900`.
  // Any number of variant layers is allowed. Strip variants, then run the prefix check.
  const base = stripVariantPrefixes(cls);
  if (base !== cls && TW_RE.test(base)) return true;
  return TW_RE.test(cls);
}

/** Recursively strips Tailwind variant prefixes (`hover:` / `disabled:` / `md:` / `dark:` / `group-hover:` etc.), keeping the last segment.
 *  Only aids isUtilityClass; not required to cover all variants — unmatched ones are simply treated as non-utility. */
function stripVariantPrefixes(cls: string): string {
  let cur = cls;
  for (let i = 0; i < 4; i++) {
    const idx = cur.indexOf(':');
    if (idx <= 0) break;
    const head = cur.slice(0, idx);
    // A single variant segment must be pure lowercase letters + hyphens (e.g. `hover` / `md` / `dark` / `group-hover`).
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
      // Attribute-selector segments like `[state=open]:animate-in`, appended to the className by buildCssPath and then
      // split out flat: tokens starting with `[` that hit STATE_ATTR_RE (`data-[state=...` or `[state=...`) are all
      // treated as state classes and dropped.
      if (STATE_ATTR_RE.test(tok)) return true;
      // Radix variant selectors split out by splitCssTokens (e.g. `:animate-in`): starting with `:`, if the part after
      // the `:` is a Tailwind v4 animation utility (animate-in / fade-out-0 / zoom-in-50 etc.), drop as unstable.
      // Other Tailwind variants (`hover:` / `md:` / `dark:`) go through isUtilityClass on their base.
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
  // Strip runtime ids (e.g. #login-7f9c3a) — the segment keeps its remainder even if only the tag is left.
  let cleaned = stripRuntimeId(seg);
  const parts = splitCssTokens(cleaned);
  const kept = parts.filter((tok) => {
    if (STATE_ATTR_RE.test(tok)) return false;
    // Radix variant selectors like `[state=open]:animate-in` (`:animate-in` following the attribute segment)
    // have no `.` / `[` prefix and get split into standalone tokens. Tailwind v4 animation utilities (`animate-in`
    // / `fade-out-0` / `zoom-in-50` etc.) are also split out by `:` — uniformly dropped via ANIMATION_RE + isUtilityClass.
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

/** Splits a css selector segment into a `[tag, .class1, .class2, [attr], #id]` token array.
 *  Unlike the original `split(/(?=[.#[])/)`: when hitting `[`, this function recognizes Tailwind arbitrary values
 *  (`text-[14px]` / `bg-[#7c5cfc]`) and merges them into one token, so later utility judgment isn't fragmented.
 *  - Pure attribute selectors like `[name=value]` / `[data-state="open"]` are kept as-is. */
function splitCssTokens(seg: string): string[] {
  const out: string[] = [];
  let i = 0;
  const isDelim = (c: string) => c === '.' || c === '#' || c === '[';
  while (i < seg.length) {
    if (isDelim(seg[i]!)) {
      // Arbitrary values: the bracket in `xxx-[value]` must be merged into the class
      if (seg[i] === '.' && seg[i + 1] !== undefined) {
        // Scan one className (including `-[...]` arbitrary values) until the next delimiter
        const start = i;
        i += 1; // skip '.'
        while (i < seg.length && !isDelim(seg[i]!)) i += 1;
        // If the class name ends with `-` followed immediately by `[`, swallow the bracket content too
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
      // #id: scan until a non-word character
      const start = i;
      i += 1;
      while (i < seg.length && /[\w-]/.test(seg[i]!)) i += 1;
      out.push(seg.slice(start, i));
      continue;
    }
    // tag / consecutive non-delimiters
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