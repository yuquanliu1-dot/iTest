import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import type { ExecStepResult } from './cdp.js';
import { materializeExpectedOutcome, maskSensitiveValues } from './cdp.js';
import { waitForPageSettled } from './pageSettle.js';
import { drainConsoleForPage } from './consoleCapture.js';
import type { AiUsageStat } from './aiUsage.js';

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

export interface VisionAssertInput {
  /** Optional; not passed on the mobile path, where the caller short-circuits (not short-circuited here — that is the caller's decision). */
  page?: import('playwright-core').Page;
  reportId: string;
  caseTitle: string;
  caseUrl: string | null;
  /** Origin of the web service the case is bound to (used by T7 to join relative urls on a mid-run navigate); absent when the environment has no web service. */
  caseWebOrigin?: string | null;
  expectedOutcome: string;
  vars: Record<string, string>;
  sensitiveVarKeys: string[];
  llmClient?: import('../agent/llm-client.js').LLMClient;
  /** Process evidence: page screenshot at the moment the last step finished (web path in step_results, /screenshots/<rid>/step-N.png).
   *  Transient notices (toasts) never survive into the post-settle final screenshot; they can only appear in this image. Optional. */
  processScreenshotPath?: string | null;
  /** Process evidence: page text snapshots of the last few steps (oldest→newest, deduplicated and truncated). Transient notice text can only appear here. */
  processPageTexts?: string[];
  /** Process evidence: step execution records (warning/error per step, including the on-the-spot AI description of page phenomena). A short-lived notice may
   *  appear during a step's execution and vanish before the step ends — only the executor at that moment saw it and noted it down. Optional. */
  processStepNotes?: string[];
}

/** web screenshot path → disk path. Only accepts this service's own /screenshots/ prefix (source is internal step_results,
 *  not user input; a mismatched prefix is always rejected, and read failures are handled best-effort by the caller). */
export function processScreenshotDiskPath(webPath: string): string | null {
  if (!webPath.startsWith('/screenshots/')) return null;
  return join(SCREENSHOTS_DIR, webPath.slice('/screenshots/'.length));
}

export interface VisionAssertOutcome {
  /** Used to append an order=-1 failed step; not returned on the mobile path */
  failureStep?: ExecStepResult;
  /** Used to write back onto the last passing step */
  onLastPass?: { reason: string; screenshot: string; expected: string; aiUsage?: AiUsageStat };
}

/** Case-level vision verdict: extracted from cdp.ts, shared with the web path. Skipped when page=undefined is passed on the mobile path (best-effort).
 *  The caller uses the return value to decide between pushing a failed step or attaching a visionAssert onto the last passing step.
 *  Exceptions are swallowed (best-effort); nothing is thrown. */
export async function runCaseVisionAssert(input: VisionAssertInput): Promise<VisionAssertOutcome | null> {
  if (!input.page) return null; // mobile path without page → short-circuit (MVP skips the vision final-state verdict for now)
  try {
    const expectedForJudge = materializeExpectedOutcome(input.expectedOutcome, input.vars);
    // Wait for the whole page to render stably before the final-state verdict (visual stability check): click submit → API
    // round-trip → frontend navigation are async; a fixed sleep (the old 800ms) is not enough when SPA lazy-loaded chunks /
    // skeleton screens / API backfill arrive later than networkidle, and would misjudge "still loading" as "does not match
    // expectations". Two consecutive frames with the same pixel fingerprint count as settled; on timeout, continue with the current frame.
    await waitForPageSettled(input.page, { timeoutMs: 12000, settleMs: 400 });
    const buffer = await input.page.screenshot({ timeout: 5000 });
    // When the page overflows the viewport, add a full-page shot: a viewport screenshot cannot see content below the
    // scroll line, while the verdict prompt's "blank/loading → failed" rule would misjudge "key area below the viewport"
    // as a broken page. Measure document height first and only take the full-page shot on real overflow — short pages
    // keep a single image, so the verdict cost stays the same as before this change.
    let fullBuffer: Buffer | null = null;
    try {
      const overflow = await input.page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return { scrollH: el.scrollHeight, clientH: el.clientHeight };
      });
      if (overflow.scrollH > overflow.clientH + 100) {
        fullBuffer = await input.page.screenshot({ timeout: 15000, fullPage: true });
      }
    } catch (e) {
      // A failure measuring height / taking the full-page shot does not block the verdict: fall back to a single viewport image, same behavior as before this logic.
      logger.warn({ err: e, reportId: input.reportId }, 'full-page screenshot for vision assert failed');
    }
    // The final-state verdict screenshot is saved separately, so the report page can show "final page vs expectation" to the user.
    const visionScreenshotPath = `/screenshots/${input.reportId}/final.png`;
    try {
      const dir = join(SCREENSHOTS_DIR, input.reportId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'final.png'), buffer);
    } catch (e) {
      logger.warn({ err: e, reportId: input.reportId }, 'failed to save final vision screenshot');
    }
    const { judgeCaseOutcome } = await import('../agent/judgeCaseOutcome.js');
    // Process evidence is read best-effort: a missing/unreadable last-step screenshot never blocks the verdict (degrades to a pure final-state verdict).
    let processImage: { base64: string; mime: 'image/png' } | null = null;
    if (input.processScreenshotPath) {
      try {
        const disk = processScreenshotDiskPath(input.processScreenshotPath);
        if (disk) {
          processImage = { base64: (await readFile(disk)).toString('base64'), mime: 'image/png' };
        }
      } catch (e) {
        logger.warn({ err: e, reportId: input.reportId }, 'failed to read process screenshot for vision assert');
      }
    }
    const verdict = await judgeCaseOutcome({
      expectedOutcome: expectedForJudge,
      caseTitle: input.caseTitle,
      caseUrl: input.caseUrl,
      screenshot: { base64: buffer.toString('base64'), mime: 'image/png' },
      ...(fullBuffer ? { fullScreenshot: { base64: fullBuffer.toString('base64'), mime: 'image/png' as const } } : {}),
      ...(processImage ? { processScreenshot: processImage } : {}),
      ...(input.processPageTexts?.length ? { processPageTexts: input.processPageTexts } : {}),
      ...(input.processStepNotes?.length ? { processStepNotes: input.processStepNotes } : {}),
      llmClient: input.llmClient,
    });
    // Report-side masking: LLM prompts run on plaintext per spec §8.3, but the persisted visionAssert (expected / reason may
    // repeat sensitive column values) is masked the same way as step error messages — reports and details only show masks, closing the loop with column-level encryption.
    const maskForReport = (t: string) =>
      input.sensitiveVarKeys.length > 0
        ? maskSensitiveValues(t, input.vars, input.sensitiveVarKeys)
        : t;
    const expectedForReport = maskForReport(expectedForJudge);
    if (verdict && !verdict.passed) {
      // Case-level vision verdict failed → append an order=-1 failed stepResult; the caller treats "any failed" as the case failing.
      // If the page throws JS errors within the verdict window (settle+screenshot+LLM), they are attributed to this failed step too.
      const consoleEntries = drainConsoleForPage(input.page);
      return {
        failureStep: {
          order: -1,
          status: 'failed',
          durationMs: 0,
          startedAt: new Date().toISOString(),
          error: `case-level vision assert failed: ${maskForReport(verdict.reason)}`,
          screenshot: visionScreenshotPath,
          failureReason: 'VisionAssertionFailed',
          humanMessage: '最终页面与用例预期不符',
          visionAssert: { passed: false, reason: maskForReport(verdict.reason), screenshot: visionScreenshotPath, expected: expectedForReport, ...(verdict.aiUsage ? { aiUsage: verdict.aiUsage } : {}) },
          ...(consoleEntries.length ? { console: consoleEntries } : {}),
        },
      };
    }
    if (verdict) {
      // Passed: attach the visionAssert onto the last step's result so the caller can read the reason (does not affect the passed count).
      return {
        onLastPass: {
          reason: maskForReport(verdict.reason),
          screenshot: visionScreenshotPath,
          expected: expectedForReport,
          ...(verdict.aiUsage ? { aiUsage: verdict.aiUsage } : {}),
        },
      };
    }
    return null;
  } catch (e) {
    // A failed vision fallback does not count as a case failure: best-effort
    logger.warn({ err: e, reportId: input.reportId }, 'case-outcome vision assert skipped');
    return null;
  }
}
