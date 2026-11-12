import type { StepAction } from '@itest/shared';

/** Old DSL → new DSL in-place upgrade, idempotent. Already-migrated structures return as-is; unknown kinds return as-is. */
export function migrateAction(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const action = raw as Record<string, unknown>;
  const kind = action.kind;

  if (kind === 'assertText') {
    if (action.target === undefined) action.target = 'specifiedElement';
    if (action.match === undefined) action.match = 'equals';
    if (!('intentLocator' in action)) action.intentLocator = undefined;
    return action;
  }

  if (kind === 'extract') {
    // phase 4: old extract steps have no mode field; lazily migrated to completeValue
    if (action.mode === undefined) action.mode = 'completeValue';
    if (!('intentLocator' in action)) action.intentLocator = undefined;
    return action;
  }

  // All kinds carrying a locator get intentLocator=undefined added (keeps field positions consistent)
  const locatorKinds = new Set(['click', 'fill', 'hover', 'waitFor', 'check', 'select', 'press']);
  if (locatorKinds.has(String(kind))) {
    if (!('intentLocator' in action)) action.intentLocator = undefined;
    return action;
  }

  // Remaining kinds (navigate / upload / switchTab / screenshot / assertJson) return as-is
  return action;
}

/**
 * Normalizes test_steps.assertion (any shape) into the StepAction subset dispatch understands.
 * Only assertText is supported; other kinds/null/non-objects return as-is.
 * Two historical shapes are supported:
 *  1) The `{kind:'assertText', text:'...'}` written by the old AI save path (missing equals/target/match) →
 *     normalized to `{kind:'assertText', locator:[], target:'page', match:'contains', equals:text}`.
 *  2) Already-normalized shapes return directly.
 */
export function migrateAssertion(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const a = raw as Record<string, unknown>;
  if (a.kind !== 'assertText') return raw;
  // A present equals counts as already normalized (dispatch applies schema defaults internally when target/match/locator are absent).
  if (typeof a.equals === 'string') return raw;
  const text = typeof a.text === 'string' ? a.text : '';
  return {
    kind: 'assertText',
    locator: [],
    target: 'page',
    match: 'contains',
    equals: text,
  };
}

/**
 * Write-time sanitization of step-level assertions: **shape normalization only; no longer drops content by a phrase blacklist**.
 *
 *  A historical version had a 28-word blacklist here (DESCRIPTIVE_PHRASES: phrases like "displays", "echoes back",
 *  "triggers", "should"...); any hit was written to the DB as null. The motive was sound — the AI often writes
 *  descriptive phrases like "the login form displays correctly", which migrateAssertion turns into a whole-page
 *  substring assertion `target:'page' match:'contains'` that is guaranteed to fail on replay; but a hardcoded word
 *  list is the same antipattern as the old CAPTCHA_FAIL_RE: every new phrasing needs another word, the chase never
 *  ends, and it falsely kills real copy (any button/toast containing words like "notice" or "required" would be dropped).
 *
 *  Instead the judgment is handed to the LLM (pi/space/tools/assertionJudge.ts), judged once on verify_case's real
 *  page, based on copy actually present on the page rather than guessing. Only empty-value normalization remains
 *  here: non-string / all-whitespace → null.
 */
export function sanitizeAssertion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text.length === 0 ? null : text;
}

/** Treats unknown as a StepAction type assertion; only for paths that already passed Zod. */
export function asStepAction(a: unknown): StepAction {
  return a as StepAction;
}
