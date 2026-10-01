import type { Page } from 'playwright-core';
import type { Locator } from '@itest/shared';

export type DomFallbackResult = { ok: true } | { ok: false; error: string };

function locatorToCss(page: Page, locators: Locator[]): string | null {
  for (const l of locators) {
    if (l.strategy === 'css') return l.value;
    if (l.strategy === 'testId') return l.value.startsWith('[') ? l.value : `[data-testid="${l.value}"]`;
  }
  return null;
}

interface ScriptArg {
  selector: string;
  value?: string;
  checked?: boolean;
}

async function runDomAction(
  page: Page,
  locators: Locator[],
  arg: ScriptArg,
  _script: (a: ScriptArg) => { ok: boolean; error?: string },
): Promise<DomFallbackResult> {
  const sel = locatorToCss(page, locators);
  if (!sel) return { ok: false, error: 'no-css-locator' };
  const res = await page.evaluate((_a) => {
    // 这里的 fn 由调用方注入；这里只是 placeholder，真实脚本在每个 wrapper 里
    return { ok: true };
  }, arg);
  return (res as DomFallbackResult) ?? { ok: false, error: 'no-result' };
}

export async function domClick(page: Page, locators: Locator[]): Promise<DomFallbackResult> {
  const sel = locatorToCss(page, locators);
  if (!sel) return { ok: false, error: 'no-css-locator' };
  const r = await page.evaluate((selector: string) => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) return { ok: false, error: 'not found' };
    el.scrollIntoView();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { ok: true };
  }, sel);
  return r as DomFallbackResult;
}

export async function domFill(page: Page, locators: Locator[], value: string): Promise<DomFallbackResult> {
  const sel = locatorToCss(page, locators);
  if (!sel) return { ok: false, error: 'no-css-locator' };
  const r = await page.evaluate(({ selector, value }: ScriptArg) => {
    const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) return { ok: false, error: 'not found' };
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }, { selector: sel, value });
  return r as DomFallbackResult;
}

export async function domCheck(page: Page, locators: Locator[], checked: boolean): Promise<DomFallbackResult> {
  const sel = locatorToCss(page, locators);
  if (!sel) return { ok: false, error: 'no-css-locator' };
  const r = await page.evaluate(({ selector, checked }: { selector: string; checked: boolean }) => {
    const el = document.querySelector(selector) as HTMLInputElement | null;
    if (!el) return { ok: false, error: 'not found' };
    if (el.checked !== checked) {
      el.checked = checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true } as const;
  }, { selector: sel, checked });
  return r as DomFallbackResult;
}

export async function domSelect(page: Page, locators: Locator[], value: string): Promise<DomFallbackResult> {
  const sel = locatorToCss(page, locators);
  if (!sel) return { ok: false, error: 'no-css-locator' };
  const r = await page.evaluate(({ selector, value }: { selector: string; value: string }) => {
    const el = document.querySelector(selector) as HTMLSelectElement | null;
    if (!el) return { ok: false, error: 'not found' };
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true } as const;
  }, { selector: sel, value });
  return r as DomFallbackResult;
}

export async function domUpload(_page: Page, _locators: Locator[], _storedPath: string): Promise<DomFallbackResult> {
  // upload 仍走真实 setInputFiles；DOM 路径无需额外实现
  return { ok: false, error: 'upload-not-supported-in-dom-fallback' };
}

// silence unused for runDomAction placeholder
void runDomAction;