/**
 * Extracts the page's interactive elements (in-viewport list + normalized coordinate boxes aligned with the screenshot).
 *
 * Extracted from aiTask.ts (the coordinate protocol chain) — after exploration moved to the pi tool chain, the element list
 * is shared by both chains and cannot keep a copy each: once the two lists drift, the same page presents a different
 * control set in the "AI phase" and in "exploration".
 *
 * Note: this module's evaluate callbacks must be **anonymous arrows** — tsx/esbuild's keepNames injects a __name
 * helper into named functions, and an evaluate body is serialized into the browser context where there is no
 * __name → the whole evaluate throws ReferenceError and the element list fails wholesale (dev/tsx only; tsc output has no such injection).
 */
import type { Page } from 'playwright-core';

export interface ElementInfo {
  selector: string;
  tag: string;
  /** Viewport-normalized 0-1000 coordinate box [x1,y1,x2,y2] — aligned with the screenshot; the model uses it to point at the target. */
  box: [number, number, number, number];
  text?: string;
  placeholder?: string;
  inputType?: string;
  /** Current input value (password type excluded) — after a cascader selection value=the full path, the only channel
   *  besides the screenshot's truncated display that can verify the selected result. */
  value?: string;
  disabled?: boolean;
}

/** Selector-synthesis source code executed in the page context (a function-expression string) — dumpElements and resolveAtPoint
 *  both pass it in via evaluate arguments and eval it inside the page, sharing one copy (previously two hand-copied versions;
 *  prod228 10-27 measurement of a button>span hit producing a bare span was the consequence of hand-copying without ancestor-lifting/without uniqueness checks).
 *  The base priority is unchanged: #id → tag[name] → tag[placeholder] → [role] → tag.cls1.cls2 → bare tag;
 *  active-state classes are stripped from class candidates (router-link-active/is-active are dynamically added/removed by routing state;
 *  after solidification replay would miss because the menu isn't active — 2026-10-28 prod228 record a.router-link-exact-active.router-link-active).
 *  On multiple hits, enrichment proceeds stepwise to guarantee mechanical replay hits uniquely:
 *    1. short text (≤30 chars) appended as :has-text("…") — non-standard CSS; uniqueness is simulated by counting
 *       "base hits whose textContent contains the text" (same direction as the replay side's getByText containment semantics);
 *    2. same-tag index within parent :nth-of-type(k) — standard CSS, verifiable directly with querySelectorAll.
 *  Still not unique → unique:false (the reporting chain keeps the coordinate form accordingly; the solidify pipeline conservatively rejects the step).
 *  String source is immune to tsx/esbuild's evaluate nested-function keepNames gotcha; Playwright evaluate
 *  goes through the DevTools channel, unaffected by the page CSP's eval restrictions. */
export const SYNTH_SELECTOR_SRC = `function (el) {
  var tag = el.tagName.toLowerCase();
  var name = el.getAttribute('name');
  var ph = el.getAttribute('placeholder');
  var role = el.getAttribute('role');
  var selector = el.id ? '#' + CSS.escape(el.id) : '';
  if (!selector && name) selector = tag + '[name="' + name + '"]';
  if (!selector && ph) selector = tag + '[placeholder="' + ph + '"]';
  if (!selector && role) selector = '[role="' + role + '"]';
  if (!selector) {
    var cls = (el.className || '').toString().trim().split(/\\s+/).filter(Boolean)
      .filter(function (c) { return !/^(router-link-(exact-)?active|is-active)$/i.test(c); })
      .slice(0, 2).join('.');
    selector = cls ? tag + '.' + cls : tag;
  }
  function count(s) { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } }
  if (count(selector) === 1) return { selector: selector, unique: true };
  var text = (el.textContent || '').trim().replace(/["\\\\]/g, '').slice(0, 30);
  if (text) {
    var hits = document.querySelectorAll(selector);
    var m = 0;
    for (var i = 0; i < hits.length; i++) if ((hits[i].textContent || '').indexOf(text) >= 0) m++;
    if (m === 1) return { selector: selector + ':has-text("' + text + '")', unique: true };
  }
  var k = 1;
  for (var sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === el.tagName) k++;
  var nth = selector + ':nth-of-type(' + k + ')';
  if (count(nth) === 1) return { selector: nth, unique: true };
  return { selector: selector, unique: false };
}`;

/** Extracts the in-viewport interactive element list (selector + normalized coordinate boxes aligned with the screenshot).
 *  Under the coordinate protocol the list's locating role is demoted to "alignment anchor + selector fallback"; box is the primary information. */
export async function dumpElements(page: Page): Promise<ElementInfo[]> {
  const raw = (await page.evaluate((src: string) => {
    const synth = eval('(' + src + ')') as (el: HTMLElement) => { selector: string; unique: boolean };
    const out: Array<Record<string, unknown>> = [];
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const els = document.querySelectorAll(
      'button, input, textarea, select, a[href], [role="button"], [role="link"], [role="textbox"], [role="combobox"], [tabindex]:not([tabindex="-1"])',
    );
    for (const el of Array.from(els).slice(0, 200)) {
      const he = el as HTMLElement;
      const r = he.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      // Keep only elements intersecting the viewport: the screenshot covers only the viewport; a list misaligned with it would mislead coordinate pointing.
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      const style = window.getComputedStyle(he);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const s = synth(he);
      let text = (he.textContent ?? '').trim().slice(0, 40);
      // Row-leading radio/checkbox inputs have no text of their own (under Element-UI cascader checkStrictly the radio is the only
      // selection path), leaving the list with coordinates but no way to tell which row — take the row container's row text.
      // The cascader's child column nests inside the parent li (the child panel is a child node of li), so the whole row's textContent
      // can't be used; take only the row's own label span.
      if (!text && he.tagName === 'INPUT') {
        const row = he.closest('li.el-cascader-node, tr, label');
        if (row) {
          const t = row.matches('li.el-cascader-node')
            ? ((row.querySelector(':scope > .el-cascader-node__label') as HTMLElement | null)?.textContent ?? '')
            : (row.textContent ?? '');
          text = t.trim().slice(0, 40);
        }
      }
      const item: Record<string, unknown> = {
        selector: s.selector,
        tag: he.tagName.toLowerCase(),
        // Normalization must not be assigned via a named arrow function: tsx/esbuild's keepNames would inject a __name helper into it,
        // and the evaluate body is serialized into the browser context where there is no __name → the whole
        // evaluate throws ReferenceError and the element list fails wholesale (dev/tsx only; tsc output has no such injection).
        box: [
          Math.round(Math.min(1000, Math.max(0, (r.left / vw) * 1000))),
          Math.round(Math.min(1000, Math.max(0, (r.top / vh) * 1000))),
          Math.round(Math.min(1000, Math.max(0, (r.right / vw) * 1000))),
          Math.round(Math.min(1000, Math.max(0, (r.bottom / vh) * 1000))),
        ],
      };
      if (text) item.text = text;
      const ph = he.getAttribute('placeholder');
      if (ph) item.placeholder = ph;
      const it = (he as HTMLInputElement).type;
      if (he.tagName === 'INPUT' && it) item.inputType = it;
      // Verification channel for selection/fill results: after a cascader selection the value is the full path; the screenshot's
      // narrow truncated box showing only the prefix would make the model misjudge "wrong unit selected" and idle until turns run out
      // (prod228 11-08 record: the radio was selected and the value was right at abort, but the model never dared call done seeing only the prefix in the screenshot). Password type is never exposed.
      if (he.tagName === 'INPUT' && it !== 'password') {
        const v = (he as HTMLInputElement).value;
        if (v) item.value = v.slice(0, 60);
      }
      if ((he as HTMLButtonElement).disabled) item.disabled = true;
      out.push(item);
      if (out.length >= 60) break;
    }
    return out;
  }, SYNTH_SELECTOR_SRC)) as Array<Record<string, unknown>>;
  return raw as unknown as ElementInfo[];
}
