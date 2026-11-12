import type { Page } from 'playwright-core';

/**
 * Waits for the full-page render to go "stable" before screenshotting for LLM judgment (vision final state / captcha recognition).
 *
 * Motivation: judgment previously relied only on a fixed `waitForLoadState('networkidle') + fixed sleep` —
 * when SPA lazy-loaded chunks / skeleton screens / API backfill complete after networkidle, a fixed sleep isn't enough for the render to land,
 * the screenshot still sits on a "loading" frame, and the LLM misjudges "not loaded yet" as "doesn't match expectations" — a false case failure.
 * Measured: report 4c6d0798's final frame was byte-identical to the last step's frame (already stable), yet users repeatedly reported
 * "analyzing the screenshot before the page finished loading" — a fixed duration is unreliable, so this became a **visual stability** verdict:
 * capture two consecutive pixel fingerprints; two identical frames mean the render has gone quiet.
 * The fingerprint is a canvas-sampled hash rather than PNG bytes (bytes wobble on re-encoding, and whole-frame comparison never converges under animation);
 * N identical samples in a row means convergence. Best-effort throughout: on timeout, continue with the current frame (never worse than the old behavior).
 *
 * Called only at the two places where "the screenshot goes to the LLM for analysis" (runCaseVisionAssert / solveCaptchaOnce's full-page fallback);
 * ordinary step screenshots are record-only — not wrapped in this, to avoid slowing every step.
 */
export interface PageSettleOptions {
  /** Total budget (ms). Returns at the deadline even if not yet stable, continuing with the current frame. Default 12000. */
  timeoutMs?: number;
  /** Gap between consecutive fingerprint samples (ms). Default 400. */
  settleMs?: number;
}

/** In-page sampled pixel fingerprint: scales the viewport onto a 160x100 canvas, hashes pixels row by row, returns a stable integer.
 *  DPR-independent (fixed sampling grid), sensitive to pure-text/static-layout changes, never converges under continuous animation.
 *  waitForPageSettled uses it to judge "render gone quiet"; aiTask's observable-change gate uses it to judge "did the click really change the picture". */
export async function pageFingerprint(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const W = 160;
    const H = 100;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return -1;
    // documentElement is an HTMLElement while canvas.drawImage requires a CanvasImageSource; the TS lib doesn't accept it — explicit assertion here.
    ctx.drawImage(document.documentElement as unknown as HTMLImageElement, 0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H).data;
    let h = 2166136261;
    for (let i = 0; i < img.length; i += 16) {
      h ^= (img[i] ?? 0);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }).catch(() => -1);
}

export async function waitForPageSettled(page: Page, opts: PageSettleOptions = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 12000);
  const settleMs = opts.settleMs ?? 400;
  // Best-effort single wait for networkidle first (long-connection pages may never reach it — hand over to the visual-stability fallback without blocking).
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
  let prev = -2;
  let stable = 0;
  // Iteration cap: in real scenarios settleMs≥1 advances wall clock each loop, so Date.now()>=deadline terminates naturally;
  // when unit-test mocks resolve waitForTimeout synchronously, wall clock doesn't advance — this cap guards against infinite loops (also against loops on evaluate exceptions).
  const maxIters = Math.max(2, Math.ceil((opts.timeoutMs ?? 12000) / Math.max(1, settleMs)) + 5);
  for (let iter = 0; iter < maxIters && Date.now() < deadline; iter++) {
    const cur = await pageFingerprint(page);
    if (cur >= 0 && cur === prev) {
      stable++;
      if (stable >= 2) return; // three consecutive identical sampled fingerprints → render gone quiet
    } else {
      stable = 0;
    }
    prev = cur;
    await page.waitForTimeout(settleMs);
  }
}
