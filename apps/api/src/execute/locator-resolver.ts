import type { Page, Frame } from 'playwright-core';
import type { Locator, IntentLocator } from '@itest/shared';
import { isStableCssPath } from '@itest/recorder/modules/selector-filter.js';

export interface ResolverInput {
  locator: Locator[];
  intentLocator?: IntentLocator;
  /** Repair-memory candidate (step_locator_cache): appended to the tail of the candidate chain as fallback — the author's candidate chain always takes priority,
   *  the cache only joins probing when the whole chain fails; skipped when it duplicates an author candidate (same src). */
  repair?: Locator | null;
}

/** Whether a single CSS segment is "pure #id form with a non-dynamic id" — if so, its priority is raised. */
function isPureStableCss(value: string): boolean {
  // value looks like 'tag#id' or '#id'
  if (!value.includes('#')) return false;
  // The whole segment must contain exactly one #id, and the id part must not hit runtime patterns
  return isStableCssPath(value);
}

/**
 * Three-tier locator candidate construction (fixed order):
 *   1. intentLocator.semanticRole (as a data-testid candidate)
 *   2. intentLocator.contextText (text fallback)
 *   3. stable #id CSS (pure #id form)
 *   4. XPath
 *   5. ordinary CSS / role / text / testId (in input order)
 *
 * The return value is a playwright Locator array + marking info; src is the source locator expression of that candidate
 * (with multiple candidates of the same strategy, kind can't tell which one — src exists for the caller to display/report). Failure fallback is decided by the caller's tryEach.
 * Candidate probing goes through count(), so subsequent actions (e.g. click) don't throw; text/role paths may lack count() — acceptance means success.
 * On a hit, writes the candidate's kind/value into hitSink (if provided), for the step result to record hitLocator.
 * root is a Page or Frame: Frame and Page share the same locator/getBy* signatures (frame-chain steps build candidates in the frame context).
 */
export function buildCandidates(
  root: Page | Frame,
  action: ResolverInput,
): Array<{ kind: string; loc: ReturnType<Page['locator']>; src?: string }> {
  const out: Array<{ kind: string; loc: ReturnType<Page['locator']>; src?: string }> = [];
  const seen = new Set<unknown>();

  const push = (kind: string, l: ReturnType<Page['locator']>, src?: string) => {
    if (seen.has(l)) return;
    seen.add(l);
    out.push({ kind, loc: l, src });
  };

  // 1+2: intent
  if (action.intentLocator) {
    if (action.intentLocator.semanticRole) {
      push('intent-testid', root.locator(`[data-testid="${action.intentLocator.semanticRole}"]`), `[data-testid="${action.intentLocator.semanticRole}"]`);
    }
    if (action.intentLocator.contextText) {
      push('intent-text', root.getByText(action.intentLocator.contextText), `text=${action.intentLocator.contextText}`);
    }
  }

  // 3+4+5: stable #id CSS first; XPath and ordinary CSS / role / text / testId after, in input order
  // Note: stable #id goes first so that a failing tier-1 CSS can fall straight back to the stable #id, avoiding unnecessary XPath / ordinary CSS retries.
  for (const l of action.locator) {
    if (l.strategy === 'css' && isPureStableCss(l.value)) {
      push('stable-css', root.locator(l.value), l.value);
    }
  }

  for (const l of action.locator) {
    if (l.strategy === 'css' && !isPureStableCss(l.value)) {
      push('css', root.locator(l.value), l.value);
    }
    if (l.strategy === 'xpath') {
      push('xpath', root.locator(`xpath=${l.value}`), l.value);
    }
    if (l.strategy === 'role') {
      const m = l.value.match(/^([\w-]+)(?:\[name="([^"]*)"\]|\[name='([^']*)'\])$/);
      if (m) {
        const [, role, name1, name2] = m;
        push('role', root.getByRole(role as never, { name: name1 ?? name2 ?? undefined }), l.value);
        // No-name fallback: a bare role match can hit multiple elements (strict mode violation).
        // Offer a "role + no name" candidate so tryFirstMatch can probe via count(), instead of only surfacing at the fill stage.
        if (!name1 && !name2) push('role-unnamed', root.getByRole(l.value as never), l.value);
      } else if (l.value.includes(' ')) {
        // Multi-segment role locator ("textbox 用户名") — split into role + text segments, probed separately.
        const parts = l.value.split(/\s+/);
        const role = parts[0]!;
        const text = parts.slice(1).join(' ');
        push('role-with-text', root.getByRole(role as never, { name: text }), l.value);
      } else {
        push('role', root.getByRole(l.value as never), l.value);
      }
    }
    if (l.strategy === 'text') {
      push('text', root.getByText(l.value), l.value);
    }
    if (l.strategy === 'testId') {
      const v = l.value.startsWith('[') ? l.value : `[data-testid="${l.value}"]`;
      push('testId', root.locator(v), l.value);
    }
  }

  // 6: repair-memory candidate (tail fallback). kind='repair-cache' lets tryFirstMatch special-case it when writing hitSink for display.
  if (action.repair) {
    const r = action.repair;
    const already = out.some((c) => c.src === r.value);
    if (!already) {
      if (r.strategy === 'css') push('repair-cache', root.locator(r.value), r.value);
      else if (r.strategy === 'xpath') push('repair-cache', root.locator(`xpath=${r.value}`), r.value);
      else if (r.strategy === 'text') push('repair-cache', root.getByText(r.value), r.value);
      else if (r.strategy === 'role') push('repair-cache', root.getByRole(r.value as never), r.value);
      else if (r.strategy === 'testId') {
        const v = r.value.startsWith('[') ? r.value : `[data-testid="${r.value}"]`;
        push('repair-cache', root.locator(v), r.value);
      }
    }
  }

  return out;
}
