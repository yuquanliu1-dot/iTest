/**
 * live-region message extraction + observable-change gate (borrowed from testomatio/explorbot html-diff.ts / ai/tools.ts).
 * Motivation: toasts/notices were recognized only by the model reading screenshots (the 11-08 record's toast-confirmation blind spot),
 * and a no-op click just burned budget with no feedback signal. Sample once before and once after each action: new messages
 * (first-hand text from aria-live regions) are fed back to the model; all four signals
 * (URL / visual fingerprint / request count / new messages) unchanged = the click had no effect — tell the model to switch targets.
 */
import type { Page } from 'playwright-core';

/** The explorbot definition: five live region roles + the <output> tag + both explicit aria-live tiers (the default tier doesn't count —
 * many containers wrongly carry aria-live="off"; too noisy). */
const LIVE_REGION_SELECTOR =
  '[role="alert"],[role="alertdialog"],[role="status"],[role="log"],[role="tooltip"],output,[aria-live="polite"],[aria-live="assertive"]';

const MESSAGE_MAX_LENGTH = 200;
const MESSAGE_LIMIT = 8;

/** Samples all live-region visible text on the current page (first-hand toast/notice evidence).
 *  Any failure (execution context destroyed mid-navigation etc.) → empty array; the caller treats it as「无消息」. */
export async function captureLiveRegionMessages(page: Page): Promise<string[]> {
  return page
    .evaluate((sel) => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (t) out.push(t.slice(0, 200));
        if (out.length >= 8) break;
      }
      return out;
    }, LIVE_REGION_SELECTOR)
    .catch(() => [] as string[]);
}

/** New messages = present in after, absent from before (symmetric substring containment: exact duplicates and「旧文本的前缀截断」both count as old).
 *  One notch stricter than explorbot's one-way containment: cumulative regions like role=log grow their full text every turn, and one-way containment
 *  would feed back 「整段新日志」 as new messages over and over; symmetric containment compresses it into noise — for toasts (one-shot short text) the two definitions are equivalent. */
export function diffNewMessages(before: string[], after: string[]): string[] {
  return after.filter((m) => !before.some((b) => b.includes(m) || m.includes(b)));
}

/** Observable-change snapshot: sampled once before and once after the click. */
export interface ChangeSnapshot {
  url: string;
  /** pageFingerprint visual fingerprint (pageSettle.ts). */
  fingerprint: number;
  /** Cumulative page network-request count (runAiTask's page.on('request') counter). */
  requests: number;
  /** Pre-action live-region messages (new messages are computed separately by diffNewMessages). */
  messages: string[];
}

/** Any one of the four signals changing counts as 「页面观测到了变化」 (the explorbot hasObservablePageChange definition).
 *  Loose entry, strict exit: a false pass (change judged as none) loses one feedback hint; a false block (no change judged as change) makes the model spin on a dead target. */
export function hasObservableChange(before: ChangeSnapshot, after: ChangeSnapshot, newMessages: string[]): boolean {
  return (
    before.url !== after.url ||
    before.fingerprint !== after.fingerprint ||
    after.requests > before.requests ||
    newMessages.length > 0
  );
}
