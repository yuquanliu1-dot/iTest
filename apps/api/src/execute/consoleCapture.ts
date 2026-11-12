import type { ConsoleMessage, Page } from 'playwright-core';
import type { ConsoleLogEntry } from '@itest/shared';

/** Max entries kept per step (prevents a runaway log-spamming step from blowing up the step_results JSONB). */
const MAX_ENTRIES_PER_STEP = 10;
/** Per-entry text truncation length. */
const MAX_TEXT_LENGTH = 500;

/** Event buffer (maintained inside createConsoleCapture; taken away and cleared on drain). */
export type ConsoleBuffer = ConsoleLogEntry[];

/**
 * Normalizes one console/pageerror event into the buffer (pure logic, easy to unit test):
 * keeps only error-level console output and uncaught exceptions (the SUT's console.log/info/warn is noise),
 * truncates text, and drops later entries once the per-step cap is reached (the first 10 carry the most information).
 */
export function recordConsoleEvent(buffer: ConsoleBuffer, type: string, text: string, ts: number): void {
  if (type !== 'error') return;
  if (buffer.length >= MAX_ENTRIES_PER_STEP) return;
  const trimmed = text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
  buffer.push({ type: 'console-error', text: trimmed, ts });
}

export function recordPageError(buffer: ConsoleBuffer, err: unknown, ts: number): void {
  if (buffer.length >= MAX_ENTRIES_PER_STEP) return;
  const text = err instanceof Error ? err.message : String(err);
  const trimmed = text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
  buffer.push({ type: 'pageerror', text: trimmed, ts });
}

export interface ConsoleCapture {
  /** Takes away the current buffer and clears it (slice-attributed by step boundaries: whoever calls drain at the result-construction point owns the entries). */
  drain(): ConsoleLogEntry[];
}

const captures = new WeakMap<Page, ConsoleCapture>();

/** Attaches subscriptions at the page-creation point (called once after cdp.ts runStepsInContext's context.newPage()). */
export function createConsoleCapture(page: Page): ConsoleCapture {
  const existing = captures.get(page);
  if (existing) return existing;
  const buffer: ConsoleBuffer = [];
  const onConsole = (msg: ConsoleMessage): void => {
    recordConsoleEvent(buffer, msg.type(), msg.text(), Date.now());
  };
  const onPageError = (err: unknown): void => {
    recordPageError(buffer, err, Date.now());
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  const capture: ConsoleCapture = {
    drain: () => {
      const out = buffer.slice();
      buffer.length = 0;
      return out;
    },
  };
  captures.set(page, capture);
  return capture;
}

/**
 * Out-of-scope fetch (places like visionAssert that can't get the capture reference): pages without a capture return an empty array.
 * Returns that page's accumulated entries since the last drain, and clears them.
 */
export function drainConsoleForPage(page: Page): ConsoleLogEntry[] {
  return captures.get(page)?.drain() ?? [];
}
