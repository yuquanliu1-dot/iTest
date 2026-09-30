import { filterCssPath, isStableCssPath, stripRuntimeAria } from './selector-filter.js';

export interface Locator {
  strategy: 'role' | 'testId' | 'text' | 'css' | 'xpath';
  value: string;
}

const MAX_CANDIDATES = 5;

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

function getAccessibleName(el: Element): string | null {
  return (
    el.getAttribute('aria-label') ??
    el.getAttribute('title') ??
    el.getAttribute('placeholder') ??
    el.textContent?.trim().slice(0, 50) ??
    null
  );
}

function getTestId(el: Element): string | null {
  return el.getAttribute('data-testid') ?? el.getAttribute('data-test-id');
}

function buildCssPath(el: Element): string {
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

function buildXPath(el: Element): string {
  if (el.id) return `//*[@id="${el.id}"]`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName.toLowerCase() !== 'html') {
    const tag = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      const idx = siblings.indexOf(cur) + 1;
      parts.unshift(`${tag}[${idx}]`);
    } else {
      parts.unshift(tag);
    }
    cur = cur.parentElement;
  }
  return `/${parts.join('/')}`;
}

export function generateLocators(el: Element): Locator[] {
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

  if (name && name.length > 0 && name.length <= 50) {
    push({ strategy: 'text', value: name });
  }

  const cssRaw = buildCssPath(el);
  const css = isStableCssPath(cssRaw) ? cssRaw : stripRuntimeAria(filterCssPath(cssRaw));
  push({ strategy: 'css', value: css || cssRaw });
  push({ strategy: 'xpath', value: buildXPath(el) });

  return out.slice(0, MAX_CANDIDATES);
}