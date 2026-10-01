const STATE_CLASSES = new Set([
  'active', 'selected', 'disabled', 'hover', 'focus',
  'loading', 'open', 'show', 'checked', 'expanded',
  'collapsed', 'current',
]);
const RUNTIME_ID_RE = /(?:^|[_-])(?:el|ant|ivu|bv)?[_-]?[a-f0-9]{6,}$/i;
const BV_ID_RE = /__BV_[a-z0-9_]+/i;
const IVU_PREFIX = /^ivu-/;
const EL_HEX_TAIL = /^el-[a-f0-9]{4,}/;
const ANT_HEX_TAIL = /^ant-[a-f0-9]{4,}/;

export function isStableCssPath(path: string): boolean {
  if (hasUnstableClass(path)) return false;
  const idMatch = path.match(/#([\w-]+)/);
  if (idMatch) {
    const id = idMatch[1]!;
    if (/^\d+$/.test(id)) return false;
    if (BV_ID_RE.test(id)) return false;
    if (RUNTIME_ID_RE.test(id)) return false;
    if (IVU_PREFIX.test(id)) return false;
  }
  return true;
}

export function hasUnstableClass(path: string): boolean {
  return path
    .split(' > ')
    .flatMap((seg) => seg.split(/(?=[.#[])/))
    .some((tok) => {
      if (!tok.startsWith('.')) return false;
      const cls = tok.slice(1);
      return (
        STATE_CLASSES.has(cls) ||
        (IVU_PREFIX.test(cls) && !/^ivu-btn|^ivu-select/.test(cls)) ||
        EL_HEX_TAIL.test(cls) ||
        ANT_HEX_TAIL.test(cls)
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
  const parts = cleaned.split(/(?=[.#[])/);
  const kept = parts.filter((tok) => {
    if (!tok.startsWith('.')) return true;
    const cls = tok.slice(1);
    if (STATE_CLASSES.has(cls)) return false;
    if (IVU_PREFIX.test(cls) && !/^ivu-btn|^ivu-select/.test(cls)) return false;
    if (EL_HEX_TAIL.test(cls)) return false;
    if (ANT_HEX_TAIL.test(cls)) return false;
    return true;
  });
  const joined = kept.join('');
  return stripRuntimeAria(joined);
}

function stripRuntimeId(seg: string): string {
  return seg.replace(/#([\w-]+)/g, (m, id) => {
    if (/^\d+$/.test(id)) return '';
    if (BV_ID_RE.test(id)) return '';
    if (RUNTIME_ID_RE.test(id)) return '';
    if (IVU_PREFIX.test(id)) return '';
    return m;
  });
}

export function stripRuntimeAria(path: string): string {
  return path
    .replace(/\[aria-controls="[^"]*"\]/g, '')
    .replace(/\[aria-describedby="[^"]*"\]/g, '')
    .replace(/\[aria-activedescendant="[^"]*"\]/g, '');
}