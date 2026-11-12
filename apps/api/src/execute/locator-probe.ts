/** Candidate-probe polling window contract (shared by replay tryFirstMatch and verify_case checkCompiledLocators):
 *  Round 1 probes all candidates immediately; once all miss, rotates and re-probes every 250ms, at most 12 rounds (≈3s).
 *  Covers two lag types: the a11y-tree rebuild lag that count() goes through (~100-200ms); SPA deep-link route mounting lag
 *  (can persist for seconds after networkidle — measured: the 8a178d83 backtest's step-1 probing gave up ~2s before the page finished mounting).
 *  A standalone module rather than an export from cdp.ts: tests widely mock cdp.js, and constants vanishing with the mock would leave importers dangling.
 *  A round cap rather than a wall-clock deadline: the window semantics stay fixed (12×250ms≈3s), and test-mocked waitForTimeout
 *  doesn't advance wall clock — a wall-clock deadline would spin forever. */
export const LOCATOR_PROBE_ROUNDS = 12;
export const LOCATOR_PROBE_INTERVAL_MS = 250;
