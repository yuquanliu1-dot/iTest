/**
 * Error signal collection (pi chain D3): page-side listeners for console error / pageerror / HTTP 4xx-5xx.
 *
 * Complementary to "the model actively reporting a finding": errors the model did not report but the page is
 * raising (console exceptions, silent 500s) are the class explorations most easily miss. Collection is platform-side
 * mechanical behavior and does not rely on model self-discipline — increments feed back to the model with observe
 * (drain), and the capped full set is archived (all → error_signals column), so "the model stayed silent while the
 * page was screaming" can be audited from it.
 */
import type { Page } from 'playwright-core';

/** Error signal (archived shape = the schema's error_signals column). */
export interface ErrorSignal {
  at: string;
  kind: 'console' | 'pageerror' | 'http';
  /** Per-item text cap (concatenated console args / error message / status line). */
  text: string;
  /** Resource URL for the http kind. */
  url?: string;
}

/** Full-archive cap: beyond it, new entries are dropped (the archive is an audit aid, not an unbounded log). */
export const ERROR_SIGNALS_MAX = 200;

/** Per-item text cap: console args can be very long stacks. */
const SIGNAL_TEXT_MAX = 300;

export interface ErrorSignalCollector {
  /** Takes the new signals since the last drain (for observe incremental feedback; rendered text + count). */
  drainRendered(): { text: string; count: number };
  /** Full (within-cap) archive snapshot. */
  all(): ErrorSignal[];
  close(): void;
}

export function createErrorSignalCollector(page: Page): ErrorSignalCollector {
  const items: ErrorSignal[] = [];
  let drained = 0;
  const textOf = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, SIGNAL_TEXT_MAX);

  const onConsole = (msg: { type(): string; text(): string }): void => {
    if (msg.type() !== 'error') return;
    if (items.length >= ERROR_SIGNALS_MAX) return;
    items.push({ at: new Date().toISOString(), kind: 'console', text: textOf(msg.text()) });
  };
  const onPageError = (err: Error): void => {
    if (items.length >= ERROR_SIGNALS_MAX) return;
    items.push({ at: new Date().toISOString(), kind: 'pageerror', text: textOf(err.message) });
  };
  const onResponse = (res: { status(): number; url(): string }): void => {
    if (res.status() < 400) return;
    if (items.length >= ERROR_SIGNALS_MAX) return;
    items.push({
      at: new Date().toISOString(),
      kind: 'http',
      text: textOf(`HTTP ${res.status()}`),
      url: res.url().slice(0, 300),
    });
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  return {
    drainRendered(): { text: string; count: number } {
      const fresh = items.slice(drained);
      drained = items.length;
      if (fresh.length === 0) return { text: '', count: 0 };
      const lines = fresh.slice(-5).map((s) => {
        const u = s.url ? ` ${s.url}` : '';
        return `- [${s.kind}] ${s.text}${u}`;
      });
      const note = fresh.length > 5 ? `（本轮新增 ${fresh.length} 条，仅显示最后 5 条）` : '';
      return { text: `页面错误信号（自上次观察起）：\n${lines.join('\n')}${note}`, count: fresh.length };
    },
    all(): ErrorSignal[] {
      return [...items];
    },
    close(): void {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('response', onResponse);
    },
  };
}
