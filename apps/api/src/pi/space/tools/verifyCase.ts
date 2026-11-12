/**
 * verify_case tool: live-verifies a case on the real SUT after it has been generated/modified (fully AI-driven, no hardcoded login).
 * Orchestration: read case → resolveEnv → resolveCaseUrl → launch → step-by-step runAiTask (the LLM operates the browser
 * autonomously from screenshots + element lists) → fail-stop on failure → failed-page element list (reuses the inspectPage extractor)
 * → structured feedback for the agent to self-correct.
 * After the AI steps + final-state judgment all pass, appends a compiled mechanical dry run with the same engine as formal replay
 * (executeCaseInBrowser): AI live execution can adaptively correct (retry with a different landing point/target), replay dispatches
 * verbatim — only a real-machine replay can expose the fork.
 * Login/captcha/change-password dialogs and similar scenarios are judged and handled autonomously by the LLM from the page's actual
 * state; credentials are injected via placeholders and substituted at execution time, never entering LLM context/returns/logs.
 * Verification doesn't write a report (results go back into the conversation context only); side effects match formal execution (spec confirmed accepted).
 */
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
// Step/meta hashes moved to verifyTrace.ts (solidify trace freshness and verify prefix confirmation share the same hash set)
import { hashEffectiveSteps, hashVerifyMeta, traceKey, saveVerifiedTrace, clearVerifiedTrace } from './verifyTrace.js';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, Locator as PwLocator } from 'playwright-core';
import {
  acquire as acquireBrowserSession,
  commit as commitBrowserSession,
  invalidate as invalidateBrowserSession,
} from './browserSessions.js';
import { asc, eq, and } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { testCases, testSteps, aiStageCaseOps, aiStageCases } from '../../../db/schema.js';
import { runAiTask, USER_PH, PASSWORD_PH, SECRET_PH, makeCredentialValueSub, credentialPlaceholder, type AiAction } from '../../../execute/aiTask.js';
import { buildCredentialSource, renderWebResourceManifest } from '../../../execute/credentialSource.js';
import { isVisualStep, mapAiActionsToCompiled } from '../../../execute/aiActionMap.js';
import { writeStepScreenshot, executeCaseInBrowser, gotoWithLandedRetry, type ExecStepResult } from '../../../execute/cdp.js';
import { LOCATOR_PROBE_ROUNDS, LOCATOR_PROBE_INTERVAL_MS } from '../../../execute/locator-probe.js';
import { buildCandidates } from '../../../execute/locator-resolver.js';
import type { Locator, StepAction, ConsoleLogEntry } from '@itest/shared';
import { runCaseVisionAssert } from '../../../execute/visionAssert.js';
import { createConsoleCapture, drainConsoleForPage } from '../../../execute/consoleCapture.js';
import { resolveEnv } from '../../../execute/envContext.js';
import { resolveCaseUrl } from '../../../lib/resolve-url.js';
import { decrypt } from '../../../lib/secret-crypto.js';
import { analyzeLocatorCandidatesBatch, summarizeStaticReports, type StaticLocatorReport } from '../../../execute/staticLocator.js';
import { resolveLlmClient } from '../../../agent/llmSettings.js';
import { tryParseJson } from '../../../agent/llm-client.js';
import { extractPageElements, extractPageEvidence } from '../../inspectPage.js';
import { probeLocatorHits, diagnoseFailure } from './failureDiagnosis.js';
import { countRepoGrepBatch } from '../../repo.js';
import { computeCaseOverlay, type EffectiveStep } from './case-ops-tools.js';
import { judgeAssertionText } from './assertionJudge.js';
import { getLoginState, loginStateKey, saveLoginState } from './loginStateCache.js';
import { registerLiveView } from '../../../execute/liveView.js';
import { repoToolCwd } from './context.js';
import { recordNlAiFailSignal } from '../failureSignals.js';
import { abortGuard, type ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

// AI turns are slower than compiled replay; watchdog base is 300s, scaled by step count for multi-step cases (~130s per step budget;
// prod228 measured each step's AI phase at ~85-107s, 130s/step leaves room for mechanical replay/restore) — a fixed 300s can't fit 10-step cases.
// The per-step conversation-turn cap is tightened separately (STEP_MAX_TURNS); the per-step AI phase also has a wall-clock cap STEP_AI_TIMEOUT_MS:
// if one step drags to that cap on a slow SUT → fail-stop that step (StepTimedOut) instead of letting the whole round die when the global budget runs out.
// The cap is 240s (the initial 150s was too tight): prod228 measured "a fresh round after cold container rebuild = login + step 1's AI phase" at 183.7s
// (up to maxTurns=5 turns per step; cold-start + login on different steps reaches minute-level) — 150s would miskill such legitimate slow steps as StepTimedOut;
// 240s leaves ~30% headroom over 183.7s while still catching anomalies like a hung LLM client that turn counting can't see.
const VERIFY_TIMEOUT_BASE_MS = 300_000;
const VERIFY_TIME_PER_STEP_MS = 130_000;
const STEP_AI_TIMEOUT_MS = 240_000;
const STEP_MAX_TURNS = 5;
/** Only a UUID-shaped caseId may query testCases.id directly (uuid column); otherwise it can only be a draft localId — skip the DB query. */
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Global watchdog budget = max(base 300s, steps × 130s per step). A multi-step case's slowness accumulates gradually; the budget must grow with the step count. */
export function computeVerifyTimeoutMs(stepCount: number): number {
  return Math.max(VERIFY_TIMEOUT_BASE_MS, stepCount * VERIFY_TIME_PER_STEP_MS);
}
// Consecutive-failure cap per case: the prompt suggests 3 rounds, but prompt advice isn't hard — the agent can ignore it. A hard constraint lives here:
// if round N+1's failure-class signature matches the previous round (no progress), force-stop and emit an "environment/precondition problem" hint,
// avoiding spinning through LLM calls when the environment lacks data or the page stays unstable.
const VERIFY_MAX_STAGNANT_ROUNDS = 3;

/** Credential placeholders: only the literal appears in prompts; valueSub substitutes the real value at action execution time.
 *  The protocol constants are defined with the execute layer (where valueSub semantics live); the re-export surface here is unchanged. */
export { USER_PH, PASSWORD_PH, SECRET_PH };

interface AiStepResult {
  order: number;
  status: 'passed' | 'failed';
  durationMs: number;
  warning?: string;
  screenshot?: string;
  error?: string;
  failureReason?: 'StepReportedFailed' | 'AiTaskAborted' | 'SecretMissing' | 'LocatorMismatch' | 'AmbiguousLocator' | 'StepTimedOut';
}

/** Tracks consecutive same-cause failure rounds per thread×case (the anti-spin hard constraint).
 *  Failure signature = failure class (failureClassFromReason) — identical signatures count as no progress.
 *  Pass → clear the counter; forced stop → rewind to cap-1 (one live run is allowed between two forced stops, so no permanent deadlock). */
interface RoundState {
  lastSignature: string;
  consecutive: number;
  /** Last round's "passed step count" — the progress signal for the stagnation criterion. */
  lastPassed: number;
  /** After a breaker trip, the next call is the final round the guard allows (the note explicitly warns it must report when that round ends). Cleared on consumption at the entry. */
  escapedAfter?: boolean;
}
const verifyRoundState = new Map<string, RoundState>();
const roundKey = (threadId: string, caseId: string) => `${threadId}::${caseId}`;
/** The AI phase's (visual execution) own failure reasons — unlike locator-gate kills, these mean the model couldn't complete the step
 *  even while looking at the real page: most likely the natural-language step description doesn't match the page's reality
 *  (target doesn't exist / ambiguous wording / precondition state never established), and fixing the selector is no help to the agent. */
const AI_PHASE_FAIL_REASONS = new Set(['AiTaskAborted', 'StepTimedOut', 'StepReportedFailed']);

/** failureReason → failure class (the signature convention for the stagnation guard).
 *  prod228 2026-10-26 record (26 verify rounds / 2h39m / zero output): under the old signature `${failureReason}:${stepOrder}`
 *  the longest same-signature streak was only 2 rounds and the guard never tripped — the AI changed selectors each round and the
 *  failing step drifted back and forth, so the old signature treated it as a "new reason" every time.
 *  Normalized convention: locator-gate kills (LocatorMismatch/AmbiguousLocator) and AI-phase execution failures
 *  (AiTaskAborted/StepTimedOut/StepReportedFailed) merge into execution — the same page obstruction (element not found /
 *  dialog blocking / SUT state drift) alternates between these two shapes across rounds; splitting them lets the guard be evaded by hopping;
 *  final-state judgment / mechanical-replay fork / missing ciphertext each form their own class (fixing one naturally moves to another — normal progress).
 *  Unmapped new reasons participate in comparison as their raw string (the same new reason appearing consecutively still accumulates stagnation). */
function failureClassFromReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'LocatorMismatch':
    case 'AmbiguousLocator':
    case 'AiTaskAborted':
    case 'StepTimedOut':
    case 'StepReportedFailed':
      return 'execution';
    case 'VisionAssertionFailed':
      return 'vision';
    case 'ReplayDivergence':
      return 'replay';
    default:
      return reason ?? 'Unknown';
  }
}
/** Mechanical-execution steps (kinds that hit protocols/query the DB directly, no browser): the browser AI phase structurally cannot execute them.
 *  prod228 2026-10-28 record: when the AI phase was asked to "execute a SQL query against the database" it retried repeatedly for over 5 turns
 *  (the agent itself noted "the AI phase is a browser executor and cannot execute SQL queries against the database"). Such steps' truth is
 *  decided by the compiled mechanical dry run at the end (runSql/runHttpRequest etc. bypass Playwright); the AI phase shouldn't meddle. */
const MECHANICAL_ONLY_KINDS: ReadonlySet<string> = new Set([
  'httpRequest',
  'sql',
  'observeLog',
  'sendSyslog',
]);

/** Whether a step's compiled consists entirely of mechanical-execution steps (= no browser actions at all). */
function isMechanicalOnlyStep(compiled: unknown): boolean {
  const actions = (Array.isArray(compiled) ? compiled : []) as Array<{ kind?: string }>;
  if (actions.length === 0) return false;
  return actions.every((a) => MECHANICAL_ONLY_KINDS.has(a?.kind ?? ''));
}

/** Whether a step's compiled contains any mechanical-execution step (a mixed step: browser actions + mechanical steps). */
function hasMechanicalStep(compiled: unknown): boolean {
  const actions = (Array.isArray(compiled) ? compiled : []) as Array<{ kind?: string }>;
  return actions.some((a) => MECHANICAL_ONLY_KINDS.has(a?.kind ?? ''));
}

/** Login-case detection (exported for unit tests): a step referencing the username/password credential placeholders = the case tests
 *  session behavior itself (login/logout). Such cases must start from a clean session — a login state left by perform_login/other cases
 *  would bounce the goto back to the home page, and the login page would never be reachable (2026-11-08 prod228 record: a login case's
 *  3 verify rounds all died on "the page is already in a logged-in state"). Both the instruction and compiled fill values are scanned
 *  (the placeholder can appear in either); STEP_SECRET is a step-level sensitive value (business form password field), not a login signal, and doesn't participate. */
export function isLoginCaseSteps(steps: Array<{ instruction?: unknown; compiled?: unknown }>): boolean {
  const re = /ITEST_(?:USERNAME|PASSWORD)/;
  return steps.some(
    (s) => re.test(String(s.instruction ?? '')) || re.test(JSON.stringify(s.compiled ?? '')),
  );
}

/** Parses the "failure signature" (failure class) out of the verify_case response data JSON; passed or unparseable → null (clears the counter). */
function failureSignatureFromData(data: string): string | null {
  try {
    const j = JSON.parse(data) as {
      result: 'passed' | 'failed';
      failure?: { failureReason?: string | null };
    };
    if (j.result === 'passed') return null;
    if (!j.failure) return 'unknown';
    return failureClassFromReason(j.failure.failureReason);
  } catch {
    return 'unparseable';
  }
}

/** Counts the "passed step number" out of the verify_case response data JSON — the progress criterion for the stagnation guard.
 *  steps includes the previous round's confirmed prefix results (merged in resume rounds), so this number is how far the case has been confirmed. */
function passedCountFromData(data: string): number {
  try {
    const j = JSON.parse(data) as { steps?: Array<{ status?: string }> };
    if (!Array.isArray(j.steps)) return 0;
    return j.steps.filter((s) => s?.status === 'passed').length;
  } catch {
    return 0;
  }
}

/** Updates the failure-signature round counter per thread×case: pass → clear; signature changed → reset the counter; same signature → accumulate.
 *  But "same signature + confirmed prefix grew" = the failure point moved forward (progress) → not counted as spinning; the consecutive counter resets.
 *  2026-11-07 prod228 record: the same case spent 3 consecutive rounds in the execution class while the failing step moved from step 1 to step 2
 *  (the prefix grew every round); the old convention judged this "advancing" failure as stagnation and tripped, denying the agent any chance to continue. */
function updateRoundState(key: string, data: string): void {
  const sig = failureSignatureFromData(data);
  if (sig === null) {
    verifyRoundState.delete(key);
    return;
  }
  verifyRoundState.set(key, nextRoundState(verifyRoundState.get(key), sig, passedCountFromData(data)));
}

/** Stagnation-guard state transition (pure function, unit-testable): signature changed → reset; same signature but the confirmed prefix grew (progress) → reset;
 *  same signature and no progress → consecutive count +1. */
export function nextRoundState(
  prev: RoundState | undefined,
  sig: string,
  passed: number,
): RoundState {
  if (!prev || prev.lastSignature !== sig) return { lastSignature: sig, consecutive: 1, lastPassed: passed };
  if (passed > prev.lastPassed) return { lastSignature: sig, consecutive: 1, lastPassed: passed };
  return { lastSignature: sig, consecutive: prev.consecutive + 1, lastPassed: passed };
}

/**
 * Probes the "environment has no precondition data" signal when the final-state judgment fails (Element-UI empty table / pagination at 0 / generic empty-state copy).
 * Used to refine the VisionAssertionFailed failure feedback from "doesn't match expectations" into "there is no verifiable data in the environment at all" —
 * 2026-10-13 prod228 measurement: the AI-built case only did "open the page and look at the list", while the 「自动处置」 tab stayed at 0 rows,
 * so the final-state judgment was bound to miss. If the feedback only says "mismatch", the AI will water down expectedOutcome to sneak through (three rounds to converge).
 * On a hit, the note names it: either have the case seed the precondition data first, or honestly report the environment lacks data — don't change the expectation.
 * Passes page.evaluate as a string expression: tsx/esbuild keepNames injects __name helper calls,
 * and the browser has no such symbol → ReferenceError (same cause as inspectPage.ts).
 */
async function detectEmptyDataState(page: Page): Promise<string | null> {
  try {
    const hit = (await page.evaluate(`(() => {
      const texts = Array.from(document.querySelectorAll('.el-table__empty-text, .el-empty__description, [class*="empty"]'))
        .map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean);
      const body = document.body ? document.body.innerText : '';
      const zeroPage = /共\\s*0\\s*条|共\\s*0\\s*项/.test(body);
      const emptyText = texts.find((t) => /暂无|没有|无数据|为空|no data/i.test(t));
      return JSON.stringify({ emptyText: emptyText ?? null, zeroPage, texts: texts.slice(0, 3) });
    })()`)) as string;
    const parsed = JSON.parse(hit) as { emptyText: string | null; zeroPage: boolean; texts: string[] };
    if (parsed.emptyText) return parsed.emptyText;
    if (parsed.zeroPage) return parsed.texts[0] ?? '分页计数为 0';
    return null;
  } catch {
    return null;
  }
}

/** Collects every locator candidate from compiled steps (reused by the static locator pre-check / failure attribution's shape-agnostic probes). */
export function collectStepLocators(compiled: unknown): Locator[] {
  const actions = (Array.isArray(compiled) ? compiled : []) as Array<{ kind?: string; locator?: Locator[] }>;
  const out: Locator[] = [];
  for (const a of actions) {
    if (typeof a.kind !== 'string') continue;
    const locs = Array.isArray(a.locator) ? a.locator : [];
    for (const l of locs) {
      if (l && typeof l.value === 'string' && l.value && typeof l.strategy === 'string') out.push(l);
    }
  }
  return out;
}

/** All-visual detection: no step has compiled (or all are pure aiTask) → the full mode skips the mechanical dry run based on this.
 *  Note "pure aiTask" is not used in the mechanical gate: a mechanical dry run dispatching to aiTask really executes it
 *  (cdp.ts case 'aiTask'), which is a formally dispatchable action — the mechanical gate looks at hasNoCompiledSteps. */
function isAllVisualSteps(steps: EffectiveStep[]): boolean {
  return steps.every((s) => {
    const c = (s as { compiled?: unknown }).compiled;
    if (!Array.isArray(c) || c.length === 0) return true;
    return (c as Array<{ kind?: string }>).every((a) => a?.kind === 'aiTask');
  });
}

/** No step has dispatchable compiled (pure natural language): the mechanical dry run has nothing to dispatch verbatim, so the mechanical mode refuses on this.
 *  Difference from isAllVisualSteps: pure aiTask compiled is also a formally dispatchable action — 2026-10-28 prod228 record:
 *  an all-aiTask solidified result was turned away by the old convention, forced to re-run the explicitly forbidden full. */
function hasNoCompiledSteps(steps: EffectiveStep[]): boolean {
  return steps.every((s) => {
    const c = (s as { compiled?: unknown }).compiled;
    return !Array.isArray(c) || c.length === 0;
  });
}

/** Which steps the closing dry run feeds.
 *
 *  - mechanical (solidification acceptance): feed all — strict semantics; a missing compiled fails (compile-missing is a real defect).
 *  - full with all compiled (post-solidification retest): feed all — verbatim dispatch is the very body of fork detection.
 *  - full with mixed steps (natural-language steps + steps carrying compiled, e.g. hand-written sql/httpRequest steps from the discussion period):
 *    feed only **pure mechanical steps**. Two reasons, sharing the same origin as the isAllVisualSteps comment:
 *    (a) natural-language steps were already verified by the AI phase; verbatim dispatching them has no compiled and would only throw
 *        compile-missing → replayFailure → misjudge the whole case as ReplayDivergence (mixed cases always false-failed under the old convention);
 *    (b) compiled UI steps can't be replayed alone in a mixed case either — their precondition natural-language step state isn't in the
 *        dry-run context, so dispatching them alone necessarily misjudges.
 *    Mechanical steps (sql/httpRequest/observeLog/sendSyslog) don't depend on browser page state and are the only part of a mixed case
 *    the dry run can truly adjudicate — the DB-query/API steps written during the discussion period get their assertion conclusions through exactly this. */
function pickReplayTargets(steps: EffectiveStep[], mode: 'full' | 'mechanical' | undefined): EffectiveStep[] {
  if (mode === 'mechanical') return steps;
  const dispatchable = steps.filter((s) => {
    const c = (s as { compiled?: unknown }).compiled;
    return Array.isArray(c) && c.length > 0;
  });
  if (dispatchable.length === steps.length) return steps; // all compiled: feed all
  return dispatchable.filter((s) => isMechanicalOnlyStep(s.compiled));
}

/** Prefix confirmation state: the basis for cross-round AI-phase resume (Problem 1).
 *  key = threadId::caseId (same key and same in-process memory lifecycle as the stagnation guard).
 *  stepsHash is stored per step: any change to a step's instruction/compiled/assertion/sensitive/delayMs puts
 *  firstDiff at that step and truncates the prefix before it — the judgment cache invalidates automatically with the step hash.
 *  metaHash deliberately excludes expectedOutcome/title: the most frequently changed vision fix shouldn't waste the whole AI phase.
 */
interface VerifyConfirmState {
  stepsHash: string[];
  metaHash: string;
  /** Confirmed count k: steps 1..k's AI phase all passed and were not pierced by later edits. */
  confirmedThrough: number;
  /** stepId → assertion judgment cache (judgeAssertionText's single-round LLM judgment; prefix steps that skip the judge reuse this). */
  assertionVerdicts: Map<string, { real: boolean; dropped?: string }>;
  /** Confirmed prefix steps' AI-phase pass results (merged and reused in the response steps; screenshot paths stay accessible across rounds, no TTL). */
  confirmedStepResults: AiStepResult[];
  /** Confirmed steps' AI action traces (for merging complete traces in resume rounds): prefix steps carry over the previous round's entries,
   *  and this round's AI phase fills in changed steps. Without it, a resume round can't save a complete trace → the immediately following
   *  solidify has nothing to reuse for zero-execution
   *  (prod228 measurement: edit one step then verify, and resumeFrom=2 happens to land on a round that can't save traces). */
  confirmedTraces: Map<string, AiAction[]>;
}
const verifyConfirmCache = new Map<string, VerifyConfirmState>();

/** Mechanical replay's sensitive-field decryption table: shared by restore-resume and the closing full replay. */
function buildReplaySecrets(steps: EffectiveStep[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of steps) {
    if (s.sensitive && s.secretCiphertext && s.secretIv && s.secretTag) {
      m.set(
        s.id,
        decrypt({
          ciphertext: Buffer.from(s.secretCiphertext, 'base64'),
          iv: Buffer.from(s.secretIv, 'base64'),
          tag: Buffer.from(s.secretTag, 'base64'),
        }),
      );
    }
  }
  return m;
}

/** Candidate shape used by the gate (matches buildCandidates output). */
type GateCandidate = { kind: string; loc: PwLocator; src?: string };
/** Locator shape used by the gate (a structural subset of @itest/shared Locator). */
type GateLocatorSpec = { strategy?: string; value?: string };

/** A locator's "anchor text": the text of the element the author intended to click.
 *  text strategy = the value itself; role strategy = the name in role[name="X"] (or the latter half of a "role 文案" shape).
 *  Locators without a text anchor (css/xpath/testId) get no ambiguity resolution — that kind of selector should be written precisely by the author anyway. */
export function locatorAnchorName(l: GateLocatorSpec): string | null {
  const v = typeof l?.value === 'string' ? l.value.trim() : '';
  if (!v) return null;
  if (l.strategy === 'text') return v;
  if (l.strategy === 'role') {
    const m = v.match(/^([\w-]+)(?:\[name="([^"]*)"\]|\[name='([^']*)'\])$/);
    if (m) return (m[2] ?? m[3] ?? '').trim() || null;
    if (v.includes(' ')) return v.split(/\s+/).slice(1).join(' ').trim() || null;
  }
  return null;
}

/** The unique "exact text" anchor: the author's intent is precisely this text.
 *  Playwright's getByRole/getByText match by substring by default (「XX（本级）」 also matches 「XX」),
 *  so substring candidate counts are naturally inflated; exact is the only anchor of the author's intent. The hit count must be exactly 1. */
async function probeUniqueAnchor(page: Page, spec: GateLocatorSpec, name: string): Promise<PwLocator | null> {
  const tries: PwLocator[] = [];
  if (spec.strategy === 'role') {
    const m = spec.value!.match(/^([\w-]+)(?:\[name="([^"]*)"\]|\[name='([^']*)'\])$/);
    // A role's accessible name gets polluted by nested content (the cascader li's accessible name contains child-column text) → exact often yields 0; fall back to exact text.
    if (m) tries.push(page.getByRole(m[1] as never, { name, exact: true }));
    tries.push(page.getByText(name, { exact: true }));
  } else if (spec.strategy === 'text') {
    tries.push(page.getByText(name, { exact: true }));
  }
  for (const t of tries) {
    const n = await t.count().catch(() => 0);
    if (n === 1) return t;
  }
  return null;
}

/** The hit candidate's "first visible match in DOM order" — the element replay's strict fallback would actually click. */
async function visibleFirstMatch(cand: GateCandidate): Promise<PwLocator | null> {
  try {
    const filtered = cand.loc.filter({ visible: true });
    if ((await filtered.count()) === 0) return null;
    return filtered.first();
  } catch {
    return null;
  }
}

/** False-ambiguity resolution: when multiple elements are hit, proving that "the element replay would actually click" is the target → no ambiguity.
 *  Replay convention (cdp.ts tryFirstMatch's strict fallback): multiple element hits → filter({visible:true}).first().
 *  Two "clicked correctly" shapes:
 *   ① the element replay clicks has exactly the target text (text strategy: the exact-text element itself);
 *   ② the element replay clicks contains the target (role strategy: a cascader li wrapping a same-named label child).
 *  Otherwise (replay would click another entry like 「XX（本级）」) → keep AmbiguousLocator. */
async function anchorResolvesAmbiguity(
  page: Page,
  locs: GateLocatorSpec[],
  cand: GateCandidate,
): Promise<boolean> {
  const spec = locs.find((l) => l.value === cand.src);
  if (!spec) return false;
  const name = locatorAnchorName(spec);
  if (!name) return false;
  const anchor = await probeUniqueAnchor(page, spec, name);
  if (!anchor) return false;
  const visFirst = await visibleFirstMatch(cand);
  if (!visFirst) return false;
  const own = await visFirst.innerText().catch(() => '');
  if (own.trim() === name) return true;
  const contained = await visFirst.filter({ has: anchor }).count().catch(() => 0);
  return contained > 0;
}

/** compiled fidelity check: verify_case's AI can bypass a bad locator live, but formal replay executes compiled verbatim —
 *  a failed check must be judged as failure at the verification stage, forcing the AI to fix it with real selectors, not "the AI got through = the case runs".
 *  **The gate must never be stricter than replay** (replay convention in cdp.ts tryFirstMatch): gate stricter than replay = killing steps replay would pass
 *  (2026-11-07 prod228 record: cascader selection of 「XX」 collided into false ambiguity with the same-prefix 「XX（本级）」, while replay actually clicked correctly).
 *  Timing: click/hover validate before the step, but **only the step's first action is judged** (replay's first action faces exactly the step-start DOM);
 *  a step's later actions face the DOM after preceding actions executed, where probing is structurally unreliable (see the two reasons at judgeIdxs),
 *  and is adjudicated by the closing compiled mechanical dry run. Assertion kinds, fill, check, select, extract validate after the AI passes
 *  (these elements should still be present when the actions end). navigate/aiTask/waitFor can't or needn't be validated; skipped.
 *  Candidate probing directly reuses replay's buildCandidates + count(): candidate expansion (bare-#id promotion, role name splitting, testId wrapping in
 *  data-testid) and probe order match tryFirstMatch exactly — verify's "first-hit candidate" is the candidate replay would actually adopt.
 *  Two failure levels:
 *  1) all candidates miss → LocatorMismatch (replay would fail);
 *  2) the first-hit candidate hits multiple elements (count>1) and the action is click/fill/hover → AmbiguousLocator — in replay these three kinds
 *     silently fall back to .first() operating the first in DOM order on multi-element hits (check/select throw explicitly, no silent risk);
 *     verify testing only count>0 would admit "coincidentally right" selectors (the target happens to be the first match); adding a form field/reordering then silently operates the wrong element.
 *     But "replay falls back to first()" ≠ "replay clicks wrong": if the first visible match is exactly the target (exact-text anchor),
 *     replay clicks correctly → no ambiguity (see anchorResolvesAmbiguity).
 *  The probe window aligns with replay (LOCATOR_PROBE_ROUNDS rounds × 250ms ≈3s, first round immediate): SPA deep-link mount lag can reach seconds and
 *  networkidle is unreliable; a verify pre-check window shorter than replay's would misjudge locators replay would pass. */
export async function checkCompiledLocators(
  page: Page,
  compiled: unknown,
  mode: 'pre' | 'post',
): Promise<{ reason: 'LocatorMismatch' | 'AmbiguousLocator'; message: string } | null> {
  const actions = (Array.isArray(compiled) ? compiled : []) as Array<{
    kind?: string;
    locator?: Array<{ strategy?: string; value?: string }>;
  }>;
  // State-jump points: navigate/aiTask swap out the whole DOM context; actions spanning a jump can't be judged against a different moment's DOM.
  let lastJump = -1;
  for (let i = 0; i < actions.length; i++) {
    const k = actions[i]?.kind;
    if (k === 'navigate' || k === 'aiTask') lastJump = i;
  }
  // Structural errors are hit-independent; judge as failure directly (web replay always throws on mobile-only strategies).
  // Family by mode (click/hover are pre, the rest post), separated from hit probing — hit probing only looks at the actions to be judged.
  for (const a of actions) {
    if (!a.kind) continue;
    const timing = a.kind === 'click' || a.kind === 'hover' ? 'pre' : 'post';
    if (a.kind === 'navigate' || a.kind === 'aiTask' || a.kind === 'waitFor') continue;
    if (timing !== mode) continue;
    for (const l of Array.isArray(a.locator) ? a.locator : []) {
      if (l.strategy === 'accessibilityId' || l.strategy === 'label' || l.strategy === 'predicate') {
        return { reason: 'LocatorMismatch', message: `compiled 定位校验不通过: strategy '${l.strategy}' 为移动端专用，web 回放不支持` };
      }
      if (typeof l.value !== 'string' || !l.value) {
        return { reason: 'LocatorMismatch', message: `compiled 定位校验不通过: ${a.kind} 的 locator 缺少 value` };
      }
    }
  }
  // Action indices to judge:
  //  - pre: judge only the step's【first】action, and only when it is click/hover. Reason: "the gate can't be stricter than replay":
  //    when replay dispatches verbatim, the first action faces exactly the step-start DOM, so its hit/miss is replay's first-step success/failure;
  //    the step's later actions face the【post-preceding-action】DOM, where probing is structurally unreliable —
  //      ① the target doesn't exist yet → judged LocatorMismatch, though replay would actually work
  //         (2026-11-07 prod228 record: in the 4-click cascader step [打开面板, 选三级], [1][2][3] hit 0 before [0] executes;
  //          likewise clicking a dropdown suggestion after a fill);
  //      ② the target exists now but a preceding action changed its context → judged "ambiguous" while replay currently has only one match
  //         (the cascader's level-0 li wraps the level-1 li; its accessible name is polluted by child-column text → count=2).
  //    Later actions' locators go to the closing compiled mechanical dry run (same engine as formal replay, verbatim dispatch).
  //  - post: judge actions after the last state jump (before the jump, the action targets were carried away by the replaced page; judging them guarantees a false failure).
  const judgeIdxs: number[] = [];
  if (mode === 'pre') {
    const first = actions[0];
    if (first && (first.kind === 'click' || first.kind === 'hover')) judgeIdxs.push(0);
  } else {
    for (let i = lastJump + 1; i < actions.length; i++) {
      const k = actions[i]?.kind;
      if (!k) continue;
      if (k === 'navigate' || k === 'aiTask' || k === 'waitFor' || k === 'click' || k === 'hover') continue;
      judgeIdxs.push(i);
    }
  }
  for (const idx of judgeIdxs) {
    const a = actions[idx]!;
    const locs = Array.isArray(a.locator) ? a.locator : [];
    if (locs.length === 0) continue;
    // Same candidate construction + count probing as replay: stop on any candidate hit (replay's same short-circuit); only all-miss judges LocatorMismatch.
    const cands = buildCandidates(page, { locator: locs as unknown as Locator[] });
    if (cands.length > 0) {
      let hitCount = 0;
      let hitDesc = '';
      let hitCand: GateCandidate | null = null;
      const misses: string[] = [];
      const missSeen = new Set<string>();
      poll: for (let round = 0; round < LOCATOR_PROBE_ROUNDS; round++) {
        if (round > 0) await page.waitForTimeout(LOCATOR_PROBE_INTERVAL_MS);
        for (const c of cands) {
          const desc = c.src ?? c.kind;
          const probe = c.loc as unknown as { count?: () => Promise<number> };
          if (!probe || typeof probe.count !== 'function') {
            // Candidates without count() are accepted directly (same as replay's tryFirstMatch)
            hitCount = 1;
            hitDesc = `${c.kind} ${desc}`;
            hitCand = c;
            break poll;
          }
          try {
            const n = await probe.count();
            if (n > 0) {
              hitCount = n;
              hitDesc = `${c.kind} ${desc}`;
              hitCand = c;
              break poll;
            }
            const msg = `${c.kind}=${desc} 命中 0 个元素`;
            if (!missSeen.has(msg)) { missSeen.add(msg); misses.push(msg); }
          } catch (e) {
            // Probe exceptions (illegal selector) count as that candidate missing — replay likewise catches count exceptions and continues to the next candidate
            const msg = `${c.kind}=${desc} 探测异常: ${(e as Error).message.slice(0, 80)}`;
            if (!missSeen.has(msg)) { missSeen.add(msg); misses.push(msg); }
          }
        }
      }
      if (hitCount === 0) {
        return { reason: 'LocatorMismatch', message: `compiled 定位校验不通过（回放将失败）: ${a.kind} 全部 ${cands.length} 个候选均未命中 — ${misses.join('；')}` };
      }
      if ((a.kind === 'click' || a.kind === 'fill' || a.kind === 'hover') && hitCount > 1) {
        // False-ambiguity resolution: on multi-element hits replay falls back to "the first visible match"; if that is exactly the target → replay clicks correctly, no ambiguity.
        if (hitCand && (await anchorResolvesAmbiguity(page, locs, hitCand))) continue;
        return {
          reason: 'AmbiguousLocator',
          message: `compiled 定位校验不通过（候选命中多个元素）: ${a.kind} 候选 ${hitDesc} 命中 ${hitCount} 个元素，回放将静默操作其中第一个——请给该候选加属性过滤（如 [placeholder=...]）或把唯一命中的候选提到首位后重验。**不要用形如 #cascader-menu-<数字>-… 的运行时实例 id 作锚点**：该 id 由前端运行时分配、每次页面加载都变（实测同一控件两轮 id 不同），用它重验必然命中 0；改用目标文案一字不差的精确文本或稳定属性（[placeholder=...]、data-testid、aria-label）`,
        };
      }
    }
  }
  return null;
}

/** Single-step execution instruction: natural language + compiled reference + placeholder credential section (only when login is configured) + output contract.
 *  solidify_case reuses the same prompt protocol (AI-phase execution + placeholder credential injection).
 *  webManifest: the environment's available web-service listing (produced by renderWebResourceManifest) — injected when named webs exist,
 *  so the model knows each service's own credential placeholder shape (@name) rather than just one bare placeholder. */
export function buildStepInstruction(
  step: { order: number; instruction: string | null; compiled: unknown; assertion: unknown },
  total: number,
  sec: { hasLogin: boolean; hasSecret: boolean },
  droppedAssertion?: string | null,
  webManifest?: string,
  /** This step contains mechanical-execution steps (sql/httpRequest etc.): the AI phase only does the browser half. */
  hasMechanicalAction?: boolean,
): string {
  const lines: string[] = [];
  lines.push('你是网页测试执行器，在当前浏览器页面上完成下面这一步测试操作，完成后按输出契约结束。');
  lines.push('');
  lines.push(`## 步骤（第 ${step.order} 步 / 共 ${total} 步）`);
  lines.push(`- 自然语言：${step.instruction ?? '（无，以编译动作为准）'}`);
  lines.push('- 编译动作（compiled DSL，供参考；若页面实际与它不符，以实际页面为准自行调整）：');
  lines.push(JSON.stringify(step.compiled));
  if (hasMechanicalAction) {
    // Mixed workload: the AI structurally cannot do the mechanical half — state the boundary explicitly, don't let it burn turns trying.
    lines.push('- 本步含机械执行动作（数据库查询 / HTTP 请求 / 日志读取等不经浏览器）：**你只负责浏览器里的那部分动作**。机械动作由平台在验证末尾用 compiled 干跑执行并裁决，你不要尝试在浏览器里查库或发接口请求，也不要因为做不到而报失败。');
  }
  if (droppedAssertion) {
    // Assertions judged as descriptive phrases are dropped: don't write the 「预期结果」 line; state the truth instead,
    // so the AI doesn't go verify copy that doesn't exist anywhere on the page after finishing the operation.
    lines.push(`- 断言：已忽略（原预期「${droppedAssertion}」是描述状态的短语而非页面文案，页面上不会有这段文字）。仅完成上面的操作即可，不要为它编造失败理由。`);
  } else if (step.assertion != null) {
    lines.push(`- 断言（预期结果，完成后自行核实）：${JSON.stringify(step.assertion)}`);
  }
  if (sec.hasLogin) {
    lines.push('');
    lines.push('## 登录凭据');
    lines.push('若当前页面是登录页（由你根据页面内容自行判断），先用占位符完成登录再执行本步：');
    // With named web services, name each service's placeholder shape; otherwise fall back to the bare placeholder (three-level default chain).
    if (webManifest) {
      lines.push('## 本次可用的 web 服务');
      lines.push(webManifest);
      lines.push(`- 用户名输入框 fill 的 value 用字面量 ${credentialPlaceholder('user', '<服务名>')}`);
      lines.push(`- 密码输入框 fill 的 value 用字面量 ${credentialPlaceholder('password', '<服务名>')}`);
      lines.push('- 「未配置凭据」的服务不要尝试登录（必然失败）；需要跨系统时用对应服务名做归属。');
    } else {
      lines.push(`- 用户名输入框 fill 的 value 用字面量 ${USER_PH}`);
      lines.push(`- 密码输入框 fill 的 value 用字面量 ${PASSWORD_PH}`);
    }
    lines.push('平台会把占位符替换为真实值；你不得猜测、拼接或输出真实凭据。');
    lines.push('登录后若出现强制改密/绑定等弹窗，按页面提示处理（能跳过则跳过）后继续本步。');
  }
  if (sec.hasSecret) {
    lines.push(`本步含加密敏感字段，填入时 value 一律用字面量 ${SECRET_PH}（平台替换为真实值，你不得猜测）。`);
  }
  lines.push('');
  lines.push('## 输出契约');
  lines.push('done.summary 必须是该 JSON 对象序列化后的文本：');
  lines.push('{"status":"passed"|"failed","reason":"<一句话中文>","login":"logged-in"|"not-needed"}');
  lines.push('- passed：本步操作（含触发的登录）已按页面实际状态完成；failed 写清原因。');
  lines.push('- login：本轮你实际执行了登录填表并提交 → 必须填 "logged-in"（即使登录发生在本步骤开头）；确实没有登录任何表单 → "not-needed"。');
  lines.push('中途无法继续时直接输出 {"fail":"原因"}。');
  return lines.join('\n');
}

export function buildVerifyCaseTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'verify_case',
    description:
      '在真实被测系统上逐步验证用例的 compiled 步骤可执行性。全 AI 驱动：模型看截图与元素清单自主操作浏览器，登录/验证码/弹窗由模型按页面实际状态自主处理，失败即停并返回失败步骤详情与失败页可交互元素清单。执行前平台直接 goto 用例 url——url 必须是目标业务页的完整深链（含应用前缀），导航/登录不写进步骤，第一步从目标页面上的业务操作开始。AI 步骤与终态判定全过后，还会用与正式回放同引擎的机械干跑逐字执行 compiled（failureReason=ReplayDivergence 表示 AI 能过但逐字回放分叉）。mode 决定验收形态：mode="full"（默认）= 全 AI 实测（AI 相 + 终态判定 + 机械干跑），实测通过时顺带缓存每步的 AI 动作轨迹（供 solidify_case 零执行复用）；mode="mechanical" = 固化后的机械验收（跳过 AI 相，只做机械干跑 + 终态判定，语义验证已由前一轮实测完成）。**不要对同一用例重复跑 full**：full 的 AI 相每步 1~2 分钟，步骤未变时重复跑纯浪费。caseId 支持两种形态：落库用例 id，或本线程 stage_case 生成的 localId（纯草稿验证，全程不落库，save 时才正式建用例）。依据清单修正 locator 后可再次调用（同一用例建议最多 3 轮）。再次调用会复用上一轮已确认的前缀：以机械回放重建前缀 DOM 状态（代替重跑 AI 相，已确认步骤不再烧 LLM 轮次），AI 相从首个改动/失败步续跑，结尾仍保留与正式回放同引擎的完整机械干跑。验证会产生真实副作用（与正式执行一致，机械干跑会再执行一遍）。',
    parameters: Type.Object({
      caseId: Type.String({ minLength: 1 }),
      // full=full AI live test (default, includes mechanical dry run); mechanical=post-solidification mechanical acceptance (skips AI phase, dry run + final-state judgment only)
      mode: Type.Optional(Type.Union([Type.Literal('full'), Type.Literal('mechanical')])),
    }),
    promptGuidelines: [
      'verify_case 有两种使用场景，按需选择：(a) 讨论期实测——草稿讨论中用户要求「跑一下看看」时，对 stage_case 暂存的自然语言草稿调用（mode 省略即 full），AI 相执行 + live view 视频流给用户看，失败时分流：locator 类失败据 failure 修正后重发 stage_case 再验，自然语言步的 AI 相失败按下方分流指引反馈用户；(b) 编译后验收——solidify_case 把自然语言编译为机械 DSL 后，对固化结果调用 verify_case(mode="mechanical")，跳过 AI 相只做机械干跑 + 终态判定，失败由你按归因修复 compiled 后重跑，直到通过。',
      'verify_case 的 mode 决定验收形态，别乱选：mode="full"（默认）是全 AI 实测，用于语义验证（讨论期实测、或 mechanical 连续两轮同因失败/归因不明时升级到它），实测通过会顺带缓存 AI 动作轨迹；mode="mechanical" 是固化后的机械验收，只跑机械干跑 + 终态判定（纯 compiled 步不烧 AI 轮次；固化出的 aiTask 执行步在干跑里由 AI 真实执行，仍会烧 LLM）——**固化完成后用 mode="mechanical" 验收，别再跑一遍 full**。',
      '**不要重复跑 full**：full 的 AI 相每步要 1~2 分钟（prod228 实测 30 次 full 调用占 105 分钟）。同一用例 full 已经通过、且步骤/环境未变时，再跑一次 full 是纯浪费——重复验证只允许发生在：步骤或 expectedOutcome 改了、环境换了、mechanical 连续两轮同因失败或归因不明（此时才升级 full）、或用户明确要求重测。全 AI 实测通过时响应里的 traceSaved=true 说明轨迹已缓存，紧接着的 solidify_case 可零执行秒级完成。',
      'mode="mechanical" 的两个限制要如实告知用户：(1) 纯自然语言用例（无 compiled）会被直接拒绝——此时先调 mode="full" 实测，solidify_case 固化出 compiled 后再回来验收；含 aiTask 的固化结果是可派发动作，mechanical 正常验收；(2) 机械模式没有 AI 相，整体登录不自动做，靠登录态缓存（30 分钟）注入——但 solidify 固化出的 aiTask 执行步（status=aiTask-fallback，含凭据步）会在干跑里由 AI 真实执行并按 instruction 自助登录，需要 LLM。副本重启或缓存过期落到登录页时，失败页是登录页就改 mode="full" 重测（顺带刷新登录态与轨迹缓存）。',
      'verify_case 全 AI 驱动：登录、验证码、改密弹窗等场景由模型自主判断处理；凭据以 __ITEST_USERNAME__ 等占位符注入执行，不会出现在任何输出中。',
      'verify_case 失败时：读取 failure.page.elements，只能用清单中真实存在的选择器修正对应步骤的 locator/动作，禁止臆造；修正走 stage_case_op 暂存后，直接再次调用 verify_case —— 本线程暂存的修改会自动叠加生效（响应 basedOn=staged），验证循环全程不要落库；全部步骤通过后,确认验证通过后再引导用户在右侧暂存区勾选统一保存。',
      'verify_case 成功响应里的 page 是本轮终态页面上真实存在的可交互元素清单（已去重降噪，另有 N 个同类元素折叠省略）。边跑边讨论提议下一步或讨论筛选项/按钮时，只能引用 page.elements（或 failure.page.elements）里真实存在的控件——清单里没有的输入框/下拉/筛选项（如「时间范围」「等级」）一律不得提议或断言其存在，页面事实以实测清单为准。',
      '自然语言步骤的 AI 相失败分流（failureReason=AiTaskAborted/StepTimedOut/StepReportedFailed 且失败步无 compiled locator 可修，failure.note 会以「该步是自然语言步骤，由 AI 相」开头提示）：大概率是步骤描述与页面实际不符——目标不存在/措辞歧义/前置状态没建立，也可能是前面步骤的描述把页面带偏——这不是你能自行修复的技术错误，重跑不改变结果（AI 相每步 1~2 分钟纯烧时间与 token）。此时停止重跑与自诊，把失败步原文、failureReason、失败页 URL/截图反馈给用户，请用户选择：调整该步（或前面步骤）的自然语言描述 / 补充入口线索 / 确认环境数据后再验；用户明确答复前不再调用 verify_case。仅当你确有把握是措辞歧义（步骤原文与页面实际文案不一致）时，可修正描述重发 stage_case 后再验一次。**例外一（不要问用户）：失败步的语义是「查库/调接口确认」（步骤原文含查库/落库/接口/请求/状态校验之类）时，这不是描述与页面不符，而是这一步形态错了——浏览器里没有 DB 工具，AI 相永远跑不了它：把它改写成带 compiled 的 sql（查被测系统的库）/ httpRequest（调接口）步，同 localId 重发 stage_case 再验，断言结论由结尾干跑给出，不要为此向用户要页面线索。**',
      'stage_case 新建的纯草稿用例（未落库）也可直接 verify_case：caseId 传 stage_case 时声明的 localId；修正循环 = 同 localId 重发 stage_case（幂等覆盖）后再次 verify_case，全程不落库，通过后引导用户在暂存区勾选保存。注意：暂存草稿的 defaultEnvId 只能绑定已落库环境或留空走默认链（暂存环境不支持）。',
      'verify_case 会校验 compiled 选择器能真实命中页面（AI 临场绕开坏 locator 不算通过，回放逐字执行 compiled 会失败）:失败原因含"定位校验不通过"时,必须用 failure.page.elements 里的真实选择器替换原 locator(严禁留着坏 locator 只靠 AI 硬跑)。候选命中多个元素(AmbiguousLocator)同样判失败——回放会静默操作第一个匹配元素,必须给该候选加属性过滤(如 [placeholder=...])或把唯一命中的候选提到首位。**禁止把形如 #cascader-menu-<数字>-… 的运行时实例 id 当唯一锚点**:该 id 由前端运行时分配、每次页面加载都变(实测同一控件两轮 id 不同),用它重验必然命中 0,只是把一类失败换成另一类失败。改用目标文案一字不差的精确文本或稳定属性([placeholder=...]、data-testid、aria-label)——Playwright 的 role/text 匹配是子串语义,「XX」会连带命中「XX（本级）」这类同名条目,精确文案才是唯一锚点。verify_case 还会做用例级终态判定(失败原因含 VisionAssertionFailed):步骤都通过但最终页面不符 expectedOutcome 时,修正步骤行为或调整 expectedOutcome 后再验。',
      '终态判定失败(failureReason=VisionAssertionFailed)且 failure.note 含"空数据信号"时,说明被测环境里根本没有可供断言的数据——这是用例缺前置造数步骤,不是选择器写错。正确做法:给用例补上"先造出满足预期的数据"的步骤(如创建一条会触发自动处置的事件),或如实告诉用户环境缺数据。严禁弱化 expectedOutcome 把失败蒙成通过(例:把"自动启动处置成功"改成"页面正常加载"、删掉断言步骤)——那是把用例改得测不出东西,比失败更糟。',
      'result.staticAnalysis 与 failure.note 里的"源码无字面命中"只是排序参考,不是"这个选择器是假的"。选择器是否存在一律以 failure.page.elements 和运行时实测为准:框架运行时拼接的 id(如 Element-UI tab 的 #tab-autodo)源码里本就没有字面量,但运行时真实命中。sourceAnalysis 与运行时命中冲突时,信运行时。',
      'verify_case 最后一道关卡是与正式回放同引擎的 compiled 机械干跑(failureReason=ReplayDivergence):AI 临场能跑通但逐字派发 compiled 失败,典型如 click 落在组件 wrapper 上不触发实际行为、唯一名冲突导致二次执行必挂。修正方式:用 failure.page.elements 里的真实选择器把失败步 compiled 改成更精确的可操作目标(点组件内部真实接收点击的元素),或修正测试数据策略(时间戳命名)后重验。',
      '查库步骤(sql / httpRequest / observeLog / sendSyslog)不经浏览器,由结尾的 compiled 干跑裁决——AI 相不掺和这类步(浏览器里没有 DB 工具,硬让它做只会白烧轮次)。干跑结果随响应带出：replay.steps[].sql 是该步实际查到的行(dbRef/rowCount/rows/assertion),失败时也在 failure.sql 里。**据此确认真值,不要建探针用例去摸表名/字段名/数据形态**——prod228 2026-10-28 实录:因看不到查库返回行,agent 连续建了 15 个 PROBE 探针用例(每次一整轮)才摸清一张表的形状。sql 步骤的形状是固定的,一次写对：{"kind":"sql","sql":"select * from t where u = {{变量}}","assertion":{...}},**{{变量}} 直接写在 sql 文本里**(平台按出现顺序替换成位置占位符并自动绑定值),**不要同时写 params 或自己写 ?/$n 占位符**(混用会被拒 sql-params-conflict);查库只有 sql 这一个 kind。表名不确定时用 repo_grep 搜 SUT 源码里的 SQL 字面量,或写只读发现查询 select table_name from information_schema.tables。**混合用例的结果分开看:自然语言 UI 步的结果在 steps[],DB/API 步的结果在 replay.steps[]——DB 步在 AI 相那轮记 passed 只是占位,真结论以干跑为准(断言不过即该例失败,按 ReplayDivergence 报出)。**',
      'verify_case 失败反馈带 failure.evidence(可见浮层清单 overlays + 各 locator 候选实时命中数 probes)与 failure.note 里的「⚠ 归因:」段——归因由 LLM 依据形态无关证据判断,先按归因再动手,不要一律当选择器错:(1) 归因=「条件性浮层」:失败页有可见弹窗/抽屉/遮罩,属数据状态才弹的对话框(草稿恢复/权限确认),机械步骤处理不了「可能弹、可能不弹」的分支:在进该页步骤之后补 aiTask 条件兜底步骤(若页面出现浮层则按页面提示关闭或点『确定/继续』,没有则跳过),不要反复改选择器也不要弱化预期;(2) 归因=「位置/流程断裂」:该步全部候选命中 0 且失败页元素清单里也没有同类目标,说明界面根本没挂载,选择器无法命中不存在的元素:去核对导航/入口/向导步骤流程(草稿恢复把向导恢复到中间态即一例),修步骤顺序或补导航,不要改 locator;(3) 归因=「选择器/行为错」:页面状态到位仅该 locator 未命中,才用 failure.page.elements 里真实存在的选择器修正(可组多候选链);(4) 归因=「环境缺数据」:先让用例造出满足预期的数据,或如实汇报,严禁弱化 expectedOutcome。归因未产出(failure.note 无「⚠ 归因:」段)时按既有通用文案结合 failure.evidence 判断,不要臆测固定文案;证据解释不了失败时,自主用 repo_grep 查源码确认弹窗/向导条件,把结论带回归因再动手——查到即回,不要无限考古。',
      '同一用例验证最多重试 3 轮；仍失败则保留用例，如实向用户说明失败步骤与原因，不要无限循环。护栏触发（返回 failureReason=StagnantRoundLimit）= 平台已判定重复实测无意义：必须立即停止所有工具调用（含读源码/查库/建探针用例「自诊」），按返回消息中的汇报模板直接向用户汇报，等用户明确指示后再行动。',
      '环境未配置登录凭据(默认 web 服务未填用户名/密码)而验证卡在登录页时，引导用户到项目环境页配置，不要伪造登录步骤。',
      '用例 url 必须是目标业务页的完整深链地址（含应用前缀，如 https://host/siemapp/siem/businessmgr/incidentmgr）——平台执行前会直接 goto 到该地址，目标页一步直达。用户没提供页面地址时,先自己取证(需求文本里找地址线索、repo_grep 查路由定义、manage_cases search 看同业务已有用例的 url),定不了再向用户索取(浏览器地址栏完整地址),禁止拿门户首页/根路径当 url；用例步骤不要写「打开/进入 XX 页面」类导航步与登录步（实测阶段平台负责到达页面与登录；正式执行不自动登录——计划运行靠分组「登录准备」、单用例直接执行须自带显式登录步，凭据用 __ITEST_USERNAME__/__ITEST_PASSWORD__ 占位符），第一步直接从目标页面上的业务操作开始。',
    ],
    execute: async (input, signal) => {
      const { caseId, mode } = input as { caseId: string; mode?: 'full' | 'mechanical' };
      // Stop checkpoint: if the session already stopped, short-circuit directly — no browser launch, no LLM spend.
      if (signal?.aborted) return { ok: false, error: '已停止：用户中断了本次验证' };
      // ── Anti-spin hard constraint: same case failing for the same reason reaches the cap → forced stop (the prompt guidance isn't hard on the agent; the real interception happens here) ──
      // An unchanged failure signature means no progress: precondition problems like missing environment data / a persistently unstable page only burn LLM calls however many rounds they retry,
      // so short-circuit the return and hand the conclusion to the agent for honest reporting. After tripping, the counter rewinds to cap-1 — the next call may run one normal round:
      // a same-cause failure trips the stop again (at most 1 live run is allowed between forced stops); if fixed, passing clears the counter — no permanent deadlock.
      const roundState = verifyRoundState.get(roundKey(ctx.threadId, caseId));
      if (roundState && roundState.consecutive >= VERIFY_MAX_STAGNANT_ROUNDS) {
        verifyRoundState.set(roundKey(ctx.threadId, caseId), {
          lastSignature: roundState.lastSignature,
          consecutive: VERIFY_MAX_STAGNANT_ROUNDS - 1,
          lastPassed: roundState.lastPassed,
          escapedAfter: true,
        });
        return {
          ok: true,
          data: JSON.stringify({
            result: 'failed',
            caseId,
            failure: {
              stepOrder: -1,
              action: null,
              error: null,
              failureReason: 'StagnantRoundLimit',
              // Wording deliberately hardened (prod228 2026-10-27 record: after the guard tripped, the agent ignored the soft hint
              // and went off reading source code / building probe cases for 9~15 minutes of self-diagnosis). All tool calls must be explicitly forbidden and a paste-ready report template given.
              humanMessage: `【停滞护栏·强制熔断】失败大类 ${roundState.lastSignature} 已连续 ${VERIFY_MAX_STAGNANT_ROUNDS} 轮零进展，本次调用已强制停止验证（未启动浏览器、未消耗 LLM）。同类失败连续出现说明是环境前置数据缺失、被测页面持续不稳定或用例存在前置依赖——重复实测无法解决。你现在必须立即停止调用一切工具（包括 verify_case、读仓库源码、grep、查数据库——它们都无法改变结果），直接向用户汇报，可用模板：「用例验证停滞：已实测多轮，最后卡在〈失败步骤与 failureReason〉；连续同类失败表明环境或用例存在前置问题，重复实测无法解决。建议：a.检查环境数据与页面可用性 b.简化或拆分该用例 c.人工处理。环境就绪后告诉我，我会再验证一轮（护栏会放行）。」在用户明确回复之前，不要再发起任何工具调用。`,
              note: `verify_case 停滞护栏触发:失败大类 ${roundState.lastSignature} 连续 ${VERIFY_MAX_STAGNANT_ROUNDS} 轮无进展,强制停止以防空转消耗 LLM 调用。触发后必须停止一切工具调用并按 humanMessage 模板向用户汇报;下一次调用是护栏放行的最后一轮,再失败将再次熔断。`,
            },
          }),
        };
      }
      // Escape round (the call right after a breaker trip) gets an explicit warning: this round must end with a report; no more self-retries.
      const isEscapeRound = roundState?.escapedAfter === true;
      if (roundState?.escapedAfter) {
        verifyRoundState.set(roundKey(ctx.threadId, caseId), { ...roundState, escapedAfter: false });
      }
      /** This round's extra notes (escape-round warning / entry redirect notice), returned to the agent at rdata's top-level roundNotes. */
      const roundNotes: string[] = [];
      if (isEscapeRound) {
        roundNotes.push(`⚠ 停滞护栏放行的最后一轮：本轮再以同类失败结束将再次熔断。本轮结束后必须立即向用户汇报结果（停止一切工具调用），不得继续自行重试或自诊。`);
      }
      const withRoundNotes = (payload: Record<string, unknown>): string =>
        JSON.stringify(roundNotes.length > 0 ? { ...payload, roundNotes } : payload);
      // Outermost fallback: unexpected exceptions from db queries / chromium launch / resolveCaseUrl etc. all convert to ok:false
      // (ToolExecutor contract: never throw into the agent loop)
      try {
        // ── Preflight validation (no browser launch) ──
        // caseId dual shape: a persisted case id, or this thread's stage_case localId (pure draft — verification never persists; save formally creates case/steps)
        // Non-UUID-shaped localIds skip the uuid-column query and go straight to drafts (otherwise invalid input syntax for type uuid throws first,
        // and the draft fallback never gets a chance to run — prod228 2026-10-27 record)
        const dbCase = UUID_SHAPE_RE.test(caseId)
          ? (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0]
          : undefined;
        let stagedCase: typeof aiStageCases.$inferSelect | null = null;
        if (!dbCase) {
          stagedCase =
            (await db.select().from(aiStageCases)
              .where(and(eq(aiStageCases.threadId, ctx.threadId), eq(aiStageCases.localId, caseId))))[0] ?? null;
          if (!stagedCase) {
            return { ok: false, error: `用例不存在: ${caseId}（既非落库用例，也非本线程暂存草稿）` };
          }
        }
        if (dbCase?.platform === 'mobile') {
          return { ok: false, error: 'verify_case 暂不支持移动端用例（v1 仅支持 web）' };
        }
        // The two sources of execution metadata align to the same shape; drafts have no groupId (no group default URL chain) and no platform (staging is web only)
        // Note you can't merge with dbCase?.x ?? stagedCase!.x — when dbCase exists but the field is null, it would fall through to a null stagedCase!.x reference
        const caseMeta = dbCase
          ? {
              title: dbCase.title,
              url: dbCase.url,
              expectedOutcome: dbCase.expectedOutcome,
              defaultEnvId: dbCase.defaultEnvId,
              versionId: dbCase.versionId,
              // The case-bound web service name: credential ownership for non-@ref placeholders (same yardstick as the execution layer).
              webServiceRef: dbCase.webServiceRef ?? null,
            }
          : {
              title: stagedCase!.title,
              url: stagedCase!.url ?? null,
              expectedOutcome: stagedCase!.expectedOutcome ?? null,
              defaultEnvId: stagedCase!.defaultEnvId ?? null,
              versionId: stagedCase!.versionId,
              // The staging table has no web_service_ref column (stage_case doesn't touch web binding yet); drafts always take the default chain.
              webServiceRef: null,
            };
        const steps: EffectiveStep[] = dbCase
          ? await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order))
          : (stagedCase!.steps as Array<{ action?: unknown; assertion?: unknown; compiled?: unknown }>).map((s, i) => ({
              id: `staged-${i + 1}`,
              order: i + 1,
              instruction: typeof s.action === 'string' ? s.action : null,
              compiled: Array.isArray(s.compiled) ? s.compiled : null,
              assertion: typeof s.assertion === 'string' ? s.assertion : null,
              // Staged steps have no sensitive/ciphertext fields to begin with (the save mapping also only carries instruction/assertion/compiled), aligned with the DB path's virtual inserted steps
              sensitive: false,
              delayMs: null,
              secretCiphertext: null,
              secretIv: null,
              secretTag: null,
            }));
        if (steps.length === 0) return { ok: false, error: '用例没有可验证的步骤' };

        // ── Staging overlay: stage_case_op entries already staged on this thread are virtually applied onto the DB case, verification continues on the staged state —
        //    the fail → stage a fix → re-verify loop never persists; after everything passes the user saves uniformly from the staging area ──
        //    (pure drafts have no DB caseId for ops to attach to; their fix loop = re-send stage_case with the same localId to overwrite, then verify)
        let effectiveSteps = steps;
        const overlayPatches: { url?: string | null; defaultEnvId?: string | null } = {};
        let opsApplied = 0;
        if (dbCase) {
          // Carry the localId: in the overlaid state an inserted step's synthetic id is staged:<insert op's localId> (same source for solidify/verify).
          const stagedOps = await db
            .select({ localId: aiStageCaseOps.localId, op: aiStageCaseOps.op, payload: aiStageCaseOps.payload })
            .from(aiStageCaseOps)
            .where(and(eq(aiStageCaseOps.threadId, ctx.threadId), eq(aiStageCaseOps.caseId, caseId)))
            .orderBy(asc(aiStageCaseOps.stagedAt));
          const overlay = computeCaseOverlay(steps, stagedOps);
          if (overlay.deleteStaged) {
            return { ok: false, error: '用例已暂存删除，请先在暂存区取消删除（或落库）后再验证' };
          }
          if (overlay.steps) effectiveSteps = overlay.steps;
          if (overlay.url !== undefined) overlayPatches.url = overlay.url;
          if (overlay.defaultEnvId !== undefined) overlayPatches.defaultEnvId = overlay.defaultEnvId;
          opsApplied = overlay.opsApplied;
        }
        if (effectiveSteps.length === 0) return { ok: false, error: '用例没有可验证的步骤' };
        const effectiveCase = { ...caseMeta, ...overlayPatches };
        // The global watchdog budget scales with the effective step count: on a slow SUT each step's AI phase accumulates gradually; a fixed budget can't fit multi-step cases
        const verifyTimeoutMs = computeVerifyTimeoutMs(effectiveSteps.length);
        // Login cases → three clean-session gates (acquire / cachedState / commit), see isLoginCaseSteps
        const loginCase = isLoginCaseSteps(effectiveSteps);

        // ── Prefix confirmation decision (Problem 1: cut the AI-phase prefix rerun across rounds, keep the closing full mechanical replay) ──
        // validPrefixLen>0 = the number of prefix steps confirmed last round whose content is unchanged / environment is the same. This round rebuilds
        // the prefix DOM state via mechanical replay, then the AI phase resumes from there; if restore fails it converges to the failed step and the AI takes over.
        const ckey = roundKey(ctx.threadId, caseId);
        const curStepsHash = hashEffectiveSteps(effectiveSteps);
        const curMetaHash = hashVerifyMeta({
          url: effectiveCase.url,
          defaultEnvId: effectiveCase.defaultEnvId,
          versionId: effectiveCase.versionId,
        });
        // ── Mechanical acceptance mode (mode='mechanical'): dedicated to acceptance after solidify_case compiles the case ──
        // The AI phase's semantic validation already happened in the live-test round; this mode only does the compiled mechanical dry run + final-state judgment.
        // A pure natural-language case (no compiled) has nothing to dispatch verbatim → reject and steer to full. Compiled containing aiTask
        // is a formally dispatchable action (the dry run's dispatch aiTask is really executed by the AI) → let through (2026-10-28 prod228
        // record: an all-aiTask solidified result was rejected by the old convention, forced to rerun the explicitly forbidden full).
        if (mode === 'mechanical' && hasNoCompiledSteps(effectiveSteps)) {
          return {
            ok: false,
            error: 'mechanical 模式验收的是 compiled 的机械可回放性：当前用例全部步骤都是纯自然语言（无 compiled）。请改调 verify_case(mode="full") 做全 AI 实测（通过后可 solidify_case 固化出 compiled，再回来做 mechanical 验收）。',
          };
        }
        const prevConfirm = verifyConfirmCache.get(ckey) ?? null;
        let validPrefixLen = 0;
        if (prevConfirm && mode !== 'mechanical') {
          if (prevConfirm.metaHash !== curMetaHash) {
            validPrefixLen = 0; // SUT/environment/version swapped → the whole prefix is invalidated
          } else {
            let d = -1;
            for (let i = 0; i < effectiveSteps.length; i++) {
              if (prevConfirm.stepsHash[i] !== curStepsHash[i]) { d = i; break; }
            }
            validPrefixLen = Math.min(prevConfirm.confirmedThrough, d === -1 ? effectiveSteps.length : d);
          }
        }
        const prefixConfirmedResults: AiStepResult[] = prevConfirm?.confirmedStepResults.slice(0, validPrefixLen) ?? [];

        // ── LLM preflight (the hard prerequisite of the fully AI-driven flow; unconfigured fails directly, user configures it on the settings page) ──
        let client: Awaited<ReturnType<typeof resolveLlmClient>>['client'];
        try {
          client = (await resolveLlmClient()).client;
        } catch (e) {
          return { ok: false, error: `LLM 未配置，无法执行 AI 验证: ${(e as Error).message}` };
        }

        // ── Environment resolution (case defaultEnv > version link > project default) ──
        let envCtx: Awaited<ReturnType<typeof resolveEnv>>;
        try {
          envCtx = await resolveEnv(
            { caseEnvId: effectiveCase.defaultEnvId ?? null, versionId: effectiveCase.versionId ?? ctx.versionId },
            { expectedProjectId: ctx.projectId },
          );
        } catch (e) {
          const errName = e instanceof Error ? e.name : '';
          if (errName === 'EnvMissing') return { ok: false, error: '缺少环境配置，请到项目环境页配置默认环境' };
          if (errName === 'EnvProjectMismatch') return { ok: false, error: '环境所属项目与当前用例不匹配' };
          return { ok: false, error: `环境解析失败: ${(e as Error).message}` };
        }
        // The prompt's web-service listing (name/origin/credential presence only, never real values) — only available after environment resolution,
        // so compute it once here and reuse per step.
        const webManifest = (() => {
          try { return renderWebResourceManifest({ envCtx }); } catch { return ''; }
        })();

        // ── L1 source-code static pre-check (advisory, never verdicts) ──
        // Attempted automatically whenever the repo is ready: all case candidates batch-query the source in one shot (a single rg tree walk), yielding
        // unique/multiple/not-found/dynamic-suspect, which feed verify_progress.staticNote +
        // result.staticAnalysis + the failure note.
        // "Static ranking, runtime decides": static facts never change any pass/fail verdict, context only;
        // repo unconfigured / still checking out / tool error → silently degrade to the current pure-runtime behavior, zero regression.
        const staticByStep: StaticLocatorReport[][] = [];
        const staticAnalysis: Array<{ order: number; note: string }> = [];
        if (ctx.repo.cwd) {
          try {
            const cwd = repoToolCwd(ctx.repo);
            // First flatten every step's candidates and batch-count in one shot — a pattern repeated across steps (e.g. several fills sharing
            // the same placeholder) is queried once; per-step queries would re-walk the tree for every step.
            const stepLocs = effectiveSteps.map((s) => collectStepLocators(s.compiled));
            const flat = stepLocs.flat();
            const allReports = flat.length > 0
              ? await analyzeLocatorCandidatesBatch(flat, (patterns) => countRepoGrepBatch(cwd, patterns))
              : [];
            let cursor = 0;
            for (let i = 0; i < stepLocs.length; i++) {
              const reports = allReports.slice(cursor, cursor + stepLocs[i]!.length);
              cursor += stepLocs[i]!.length;
              staticByStep.push(reports);
              const note = summarizeStaticReports(reports);
              if (note) staticAnalysis.push({ order: effectiveSteps[i]!.order, note });
            }
          } catch {
            // Silent degradation before repo tool errors surface: static analysis is an enhancement, not a dependency
          }
        }
        const staticNote = staticAnalysis.length > 0
          ? `源码静态分析:${staticAnalysis.map((a) => `步骤#${a.order} ${a.note}`).join(' | ')}`
          : null;

        // ── Browser + watchdog → step-by-step AI-driven execution (fail-stop) ──
        let browser: Browser | undefined;
        let context: BrowserContext | undefined;
        let page: Page | undefined;
        let live: ReturnType<typeof registerLiveView> | undefined;
        let timedOut = false;
        // Keep-alive state machine: registryOwned = the browser belongs to the registry (hit round); completed = reached a normal completion emission point;
        // zombie = in-flight async still driving the browser (runAiTask/restore/replay all lack a preemtable AbortSignal —
        // can only be abandoned). The finally block uses completed&&!zombie&&!timedOut+connectivity to decide commit keep-alive /
        // invalidate destroy / plain use-and-close as before.
        const sessKey = roundKey(ctx.threadId, caseId);
        let registryOwned = false;
        let completed = false;
        let zombie = false;
        let reused = false;
        let appliedCount = 0;
        let reuseApplied = 0;
        // The closing mechanical dry run's terminal page (finally closes it to keep kept-context pages from accumulating; declared outside try so finally can see it.
        // Assertion init: the assignment happens inside the onPageReady callback, invisible to CFA — a bare null init would narrow finally to never)
        let replayPage = null as Page | null;
        const timer = setTimeout(() => {
          timedOut = true;
          if (browser) void browser.close().catch(() => undefined);
        }, verifyTimeoutMs);
        // Stop guard: the user clicking stop preempts in-flight AI/replay; finally closes the browser so residual operations terminate with it.
        const stopGuard = abortGuard(signal, '已停止：用户中断了本次验证');
        try {
          // resolveCaseUrl may throw WebServiceMissing (relative url but the environment has no web service); inside this try so finally's
          // envCtx.close covers it (no connection-pool leak on the exception path either).
          // Drafts have no group, share a null groupId: with envCtx passed, resolveCaseUrl only uses resolveWebOrigin to join relative paths;
          // a relative url (/prefix) → default web service origin + path; absolute passes through; empty → default origin (null if no service for an empty url).
          const resolvedUrl = await resolveCaseUrl(
            {
              url: effectiveCase.url,
              // Drafts have no DB row: groupId is unused when envCtx is passed (only defaultEnvFallback's displayWebEnv needs it), pass an empty string;
              // drafts cannot bind a named webServiceRef → null takes the default web service.
              groupId: stagedCase ? '' : dbCase!.groupId,
              webServiceRef: stagedCase ? null : (dbCase!.webServiceRef ?? null),
            },
            { envCtx },
          );
          const targetUrl = resolvedUrl && /^https?:\/\//.test(resolvedUrl) ? resolvedUrl : undefined;
          // The dry-run ExecContext's relative-URL navigate relies on caseWebOrigin to build absolute addresses (same resolution as runCase) —
          // previously neither ctx carried it, and a mechanical dry run hitting a /prefix navigate always got invalid-navigate-url (prod228 record).
          let caseWebOrigin: string | null = null;
          try { caseWebOrigin = envCtx.resolveWebOrigin(effectiveCase.webServiceRef ?? null); } catch { caseWebOrigin = null; }
          // Stop checkpoint: probe once more before launching the browser (the user may have clicked stop during the DB/static analysis above).
          if (signal?.aborted) return { ok: false, error: '已停止：用户中断了本次验证' };
          // ── Keep-alive reuse attempt (mechanical terminal-acceptance rounds don't enter the registry, staying use-and-close) ──
          // Hit: browser/context/page rest at last round's terminal state, zero prefix replay and zero restore, the AI phase resumes directly from appliedCount;
          // miss: fresh launch, and end-of-round finally registers it for the next round's reuse as the result warrants. Any registry invalidation
          // condition (expired / disconnected / prefix step edited / environment swapped) is destroyed inside acquire, degrading to this path.
          // Login cases skip too: a kept context rests at last round's post-login state and can never reach the login page.
          const acquired =
            mode !== 'mechanical' && !loginCase ? acquireBrowserSession(sessKey, curMetaHash, curStepsHash) : null;
          // On a login-state cache hit inject it into the context: same-environment retry rounds / later cases skip login (self-heals on expiry, see loginStateCache);
          // a reused round's login state is already inside the kept context, so don't inject (loginKey still computed — the end-of-round storageState write-back needs it);
          // Login cases allow neither (cache/kept sessions both bounce the goto back to the post-login home page) — a clean session is the prerequisite
          const loginKey = loginStateKey(envCtx.envId, envCtx.login?.user);
          const cachedState = acquired || loginCase ? null : getLoginState(loginKey);
          if (acquired) {
            reused = true;
            registryOwned = true;
            browser = acquired.browser;
            context = acquired.context;
            page = acquired.page;
            appliedCount = acquired.appliedCount;
            reuseApplied = acquired.appliedCount;
          } else {
            browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
            context = await browser.newContext({
              ignoreHTTPSErrors: true,
              viewport: { width: 1280, height: 800 },
              ...(cachedState ? { storageState: cachedState } : {}),
            });
            page = await context.newPage();
          }
          // Browser console error / pageerror collection: the AI phase manages its own page (not via runStepsInContext),
          // so subscribe directly; drained into attribution evidence on failure wrap-up (buffer cap 10 entries, typically the failed step's errors).
          // Idempotent per page (WeakMap returns the same instance): a reused round gets the existing instance, drain first to clear cross-round residue.
          drainConsoleForPage(page);
          const consoleCapture = createConsoleCapture(page);
          // Playground live view: register the page source, the start event hands the stream URL to the frontend progress card; finally close ends the stream
          // (ctx.liveView === false is the batch background path: no view source registered, saving the 0.5fps screenshot polling overhead)
          if (ctx.liveView !== false) {
            live = registerLiveView();
            live.setPage(page);
          }

          const reportId = `verify-${randomUUID()}`;
          // Assertion-verdict cache rebuild: resume rounds' prefix steps skip judging, but restore/the closing full replay both need
          // droppedAssertions to exclude descriptive-phrase assertions from mechanical adjudication — restored from last round's verdict cache.
          const droppedAssertions = new Map<string, string>();
          if (prevConfirm) {
            if (mode === 'mechanical') {
              // Mechanical mode has no AI phase and can't run judgeAssertionText: reuse a dropped verdict only when both the environment and that
              // step's content exactly match the judging round; verdicts not reused go into mechanical replay literally (the failure note
              // will suggest re-checking with full).
              if (prevConfirm.metaHash === curMetaHash) {
                effectiveSteps.forEach((s, i) => {
                  if (prevConfirm.stepsHash[i] !== curStepsHash[i]) return;
                  const v = prevConfirm.assertionVerdicts.get(s.id);
                  if (v && !v.real && v.dropped) droppedAssertions.set(s.id, v.dropped);
                });
              }
            } else {
              for (const [stepId, v] of prevConfirm.assertionVerdicts) {
                if (!v.real && v.dropped) droppedAssertions.set(stepId, v.dropped);
              }
            }
          }
          /** Mechanical-replay step mapping (shared by restore and the closing full replay): dropped assertions don't participate in replay adjudication. */
          const mapForReplay = (s: EffectiveStep) => ({
            order: s.order,
            assertion: droppedAssertions.has(s.id) ? null : s.assertion,
            delayMs: s.delayMs,
            id: s.id,
            sensitive: s.sensitive,
            compiled: Array.isArray(s.compiled) ? s.compiled : null,
          });
          /** Restore-dispatchable mechanical actions (cached per step id): visual steps (pure NL / pure aiTask) after mapForReplay carry
           *  no mechanical semantics — pure NL doesn't even carry an instruction, so the mechanical engine compile-misses directly; the first such
           *  step in the prefix would break the restore and the AI phase would rerun wholesale from there (re-screenshot recognition), making
           *  "confirmed steps don't burn LLM turns" fall through for visual cases. Instead feed the confirmed traces from the previous round
           *  (confirmedTraces, same source as solidify) mapped into mechanical actions to rebuild state — zero LLM/zero screenshots. If unmappable
           *  (coordinate form / credentials / bare labels rejected) → null: that step has no mechanical action to dispatch, the mechanical engine
           *  will inevitably compile-miss and break the chain there, so it isn't fed into the restore slice (see restoreLen). */
          const restoreCompiledByStepId = new Map<string, StepAction[] | null>();
          const restoreCompiledFor = (s: EffectiveStep): StepAction[] | null => {
            if (!isVisualStep(s)) return null; // Mechanical steps keep their original compiled (replay fidelity), no trace mapping needed
            const cached = restoreCompiledByStepId.get(s.id);
            if (cached !== undefined) return cached;
            const carried = prevConfirm?.confirmedTraces.get(s.id);
            const mapped = carried ? mapAiActionsToCompiled(carried) : null;
            const compiled = mapped && mapped.ok ? mapped.compiled : null;
            restoreCompiledByStepId.set(s.id, compiled);
            return compiled;
          };
          /** Whether this step's state can be rebuilt by mechanical replay: mechanical steps replay as-is; visual steps need a mappable confirmed trace. */
          const restorable = (s: EffectiveStep): boolean =>
            !isVisualStep(s) || restoreCompiledFor(s) !== null;
          const mapForRestore = (s: EffectiveStep) => {
            const base = mapForReplay(s);
            if (!isVisualStep(s)) return base; // Mechanical steps keep their original compiled (replay fidelity); sensitive steps have no trace and naturally fall back
            const compiled = restoreCompiledFor(s);
            return compiled ? { ...base, compiled } : base;
          };
          // Sensitive-field decryption table: shared by restore-resume and the closing full replay (a decrypt failure throws, matching the original final-replay semantics)
          const replaySecrets = buildReplaySecrets(effectiveSteps);

          // ── Prefix state rebuild (resume): mechanically replay the confirmed prefix to restore the browser to step validPrefixLen's DOM state ──
          // executeCaseInBrowser builds its own page internally and gotos targetUrl, handing the page back on success/failure (onPageReady /
          // onFailurePage); the subsequent AI phase and evidence collection keep using that page. Restore failure → converge to the failed step and let the AI take over
          // (mechanical replay failure isn't a verdict: the AI may adaptively bypass live).
          // Keep-alive hit rounds skip this whole block: the browser rests at last round's terminal state, the prefix is already in effect, the AI phase resumes from reuseApplied.
          let resumeIndex = reused ? reuseApplied : validPrefixLen;
          // Restore slice = the longest "mechanically restorable" segment of the prefix: an unrestorable visual step (no confirmed trace / mapping rejected)
          // fed into the mechanical engine inevitably compile-misses and breaks the chain; the replay would run a doomed-to-fail action for nothing,
          // and would knock the restore convergence point back to that step — prod228 measured 46/46 verify rounds with a prefix converging to step 1 rerun,
          // and prefix rounds were actually slower than fresh rounds (p50 112s vs 60s, the difference being this doomed replay). After truncation: the restorable segment
          // is rebuilt by mechanical replay and the steps after it go to the AI phase (same convention as the original "replay failure converges to the failed step"), just no longer wasted.
          let restoreLen = 0;
          if (validPrefixLen > 0 && !reused) {
            for (const s of effectiveSteps.slice(0, validPrefixLen)) {
              if (!restorable(s)) break;
              restoreLen++;
            }
          }
          if (validPrefixLen > 0 && !reused && restoreLen === 0) {
            // The prefix is entirely mechanically unrestorable → no replay; this round is equivalent to a fresh round: the AI phase takes over from step 1
            // (page navigation handled by the initial goto below — no replay means no executeCaseInBrowser navigation).
            resumeIndex = 0;
          }
          if (validPrefixLen > 0 && !reused && restoreLen > 0) {
            let restoredPage: Page | null = null;
            const restoreSlice = effectiveSteps.slice(0, restoreLen);
            // Stop can preempt the restore: the in-flight replay terminates when finally closes the browser; swallow the exception, don't rethrow.
            const restorePromise = executeCaseInBrowser(
              caseId,
              restoreSlice.map(mapForRestore),
              {
                reportId: `${reportId}-restore`,
                envCtx,
                llmClient: client,
                liveView: live,
                // No expectedOutcome: restore only rebuilds prefix state; the vision final-state judgment is left to the main flow
                ...(replaySecrets.size > 0
                  ? { secretResolver: async (stepId: string) => replaySecrets.get(stepId) ?? null }
                  : {}),
                ...(caseWebOrigin ? { caseWebOrigin } : {}),
                caseWebServiceRef: effectiveCase.webServiceRef ?? null,
                onPageReady: (p) => { restoredPage = p; },
              },
              browser,
              context,
              targetUrl,
              undefined,
              undefined,
              undefined,
              // The restore-failure scene is the AI resume point (slice step index == global index: the slice starts at 0)
              async (p, j) => { restoredPage = p; resumeIndex = j; },
            );
            void restorePromise.catch(() => undefined);
            let restoreRes: Awaited<typeof restorePromise>;
            try {
              restoreRes = await Promise.race([restorePromise, stopGuard]);
            } catch (e) {
              // stopGuard preemption: the in-flight restore has no stoppable signal; after abandonment and browser close it still mutates the page —
              // mark hit rounds zombie so finally destroys the registry browser, degrading the next round to the fresh path.
              zombie = true;
              throw e;
            }
            if (restoreRes.some((r) => r.status === 'failed')) {
              const j = restoreRes.findIndex((r) => r.status === 'failed');
              resumeIndex = j < 0 ? restoreLen : j;
            } else {
              // Replay all passed: the effective prefix = the segment actually replayed (restoreLen, possibly shorter than validPrefixLen)
              resumeIndex = restoreLen;
            }
            if (restoredPage) page = restoredPage;
          }
          // The effective prefix after restore settles (full recovery=restoreLen; converged=failed step j), the end-of-round commit convention
          appliedCount = resumeIndex;

          // Initial navigation (when the page hasn't been navigated yet): restore already navigated (restoreRan); a keep-alive hit round's browser rests at
          // last round's terminal state (appliedCount>0) so it doesn't need it either; the rest (fresh rounds / prefix unrestorable end-to-end so restore skipped /
          // hit rounds with appliedCount=0 of unknown state) must goto to a known state. mechanical skips — the dry run's
          // executeCaseInBrowser has its own goto; pre-navigation would just be one extra page load and side effect.
          const restoreRan = validPrefixLen > 0 && !reused && restoreLen > 0;
          if (mode !== 'mechanical' && !restoreRan && !(reused && appliedCount > 0) && targetUrl) {
            const firstCompiled = effectiveSteps[0]?.compiled;
            const firstAction = (Array.isArray(firstCompiled) && firstCompiled.length > 0
              ? firstCompiled[0]
              : undefined) as { kind?: string; url?: string } | undefined;
            const skipInit = firstAction?.kind === 'navigate' && firstAction.url === targetUrl;
            if (!skipInit) {
              // goto + landed-verification retry: a deep-link cold start may be bounced by the frontend fallback route (one retry usually wins the race).
              // Landing on the login page isn't warned about — full mode's AI phase self-serves login; other landing-point differences go to the agent in roundNotes.
              const landed = await gotoWithLandedRetry(page, targetUrl);
              if (!landed.landed && !landed.finalUrl.includes('/login')) {
                roundNotes.push(`入口深链 goto 后未落到目标页（当前在 ${landed.finalUrl}，目标 ${targetUrl}）——多为前端路由冷启动竞态（如 qiankun 兜底路由）或入口地址不对；若当前页是登录页/首页概览页，也可能是会话已过期（登录态缓存 30 分钟，人机间隔一长就过期），此时应先 get_login_credentials + perform_login 重新登录再重验，而不是把步骤判成写错。后续步骤失败时先核对该信息：若失败页元素与目标页无关，属入口未达而非 locator 错，不要盲目改步骤 locator。`);
              }
            }
          }

          // Placeholders → real values. Credential substitution reuses the execute layer's single implementation (@ref ownership / missing-credential fail-fast
          // semantics match replay exactly — two hand-rolled literal exact-match implementations were precisely the 2026-10-21 prod228 divergence root cause).
          let stepSecret: string | undefined;
          // Rebuild the source on every substitution: stepSecret is only assigned after per-step decryption; snapshotting at construction time would freeze the sensitive value at undefined.
          const valueSub = (v: string): string =>
            makeCredentialValueSub(
              buildCredentialSource({ envCtx, caseWebServiceRef: effectiveCase.webServiceRef }, stepSecret),
            )(v);

          const stepResults: AiStepResult[] = [];
          /** Solidifiable-step action traces collected by this round's AI phase (the data source for solidify_case's zero-execution reuse).
           *  Prefix steps ([0, validPrefixLen)) were executed by mechanical restore this round with no AI actions; their traces are carried from last round's
           *  confirmation cache (validPrefixLen's determination already guarantees those steps' content is unchanged, so old traces remain valid);
           *  steps the AI phase actually executed this round are overwritten in place. After merging, a fully passed round yields a complete trace. */
          const collectedTrace = new Map<string, AiAction[]>();
          if (prevConfirm && validPrefixLen > 0) {
            for (let i = 0; i < validPrefixLen; i++) {
              const id = effectiveSteps[i]!.id;
              const carried = prevConfirm.confirmedTraces.get(id);
              if (carried) collectedTrace.set(id, carried);
            }
          }
          /** This round's AI-phase assertion verdicts (written back to last round's cache, reused step-by-step before resuming). */
          const verdictsThisRound = new Map<string, { real: boolean; dropped?: string }>();
          // Global watchdog timeout wrap-up (shared by step interruption / mechanical replay interruption): write the locally completed prefix back to the cache —
          // otherwise the next round reruns from scratch and all confirmed steps are lost (Problem 1's resume design neutralized). The error carries the completed step count
          // so the next round resumes from the interrupted step instead of restarting from step 1. stepResults' local index starts at resumeIndex,
          // completed count = resumeIndex (the prefix confirmed last round) + stepResults.length (actually walked this round).
          const commitTimeoutPrefix = (where: string): { ok: false; error: string } => {
            // Mechanical mode has no AI phase, no resumable prefix to write (and must not overwrite last full round's verdict cache)
            if (mode === 'mechanical') {
              return { ok: false, error: `验证超时（${verifyTimeoutMs / 1000}s）已终止：${where}（mechanical 模式无 AI 相前缀，下轮从头上）` };
            }
            const merged = new Map<string, { real: boolean; dropped?: string }>(prevConfirm?.assertionVerdicts ?? []);
            for (const [id, v] of verdictsThisRound) merged.set(id, v);
            const completed: AiStepResult[] = [...prefixConfirmedResults.slice(0, resumeIndex), ...stepResults];
            verifyConfirmCache.set(ckey, {
              stepsHash: curStepsHash,
              metaHash: curMetaHash,
              confirmedThrough: completed.length,
              assertionVerdicts: merged,
              confirmedStepResults: completed,
              confirmedTraces: collectedTrace,
            });
            return { ok: false, error: `验证超时（${verifyTimeoutMs / 1000}s）已终止：已完成 ${completed.length}/${effectiveSteps.length} 步（${where}），后续轮次将从中断步 resume 续跑` };
          };
          let failedIndex = -1;
          let login: 'logged-in' | 'not-needed' = 'not-needed';
          // SSE real-time progress: verification can run for minutes, the frontend renders the per-step progress card from these events (spaceEventsStore.verify_progress).
          // loginCache/loginUser: login-state cache hit and credential user shown right in the dialog — confirming reuse took effect without digging through server logs.
          ctx.emit({
            type: 'verify_progress', phase: 'start', caseId, total: effectiveSteps.length, targetUrl: targetUrl ?? null,
            resumeFrom: resumeIndex,
            ...(reused ? { browserReused: true as const } : {}),
            ...(mode === 'mechanical' ? { mode: 'mechanical' as const } : {}),
            loginCache: reused || cachedState ? ('hit' as const) : ('miss' as const),
            loginUser: envCtx.login?.user ?? null,
            stagedOps: opsApplied,
            ...(staticNote ? { staticNote } : {}),
            liveUrl: live ? `/api/assistant/threads/${ctx.threadId}/live/${live.key}` : undefined,
          });
          // mechanical mode skips the entire AI phase (loop index set out of bounds directly; semantic validation was done in the live-test round)
          for (let i = mode === 'mechanical' ? effectiveSteps.length : resumeIndex; i < effectiveSteps.length; i++) {
            const s = effectiveSteps[i]!;
            const started = Date.now();
            // Stop checkpoint: probe before each step (the user may have clicked stop during mechanical waits / the previous step's wrap-up).
            // Step-boundary cancel has no in-flight async: the browser state = the effective prefix, a clean keep-alive-able breakpoint.
            if (signal?.aborted) {
              completed = true;
              ctx.emit({ type: 'verify_progress', phase: 'end', result: 'cancelled' });
              return { ok: false, error: '已停止：用户中断了本次验证' };
            }
            // Trace collection targets: visual-mode non-sensitive steps (same convention as solidify_case's solidification candidates)
            const solidifiable = isVisualStep(s) && !s.sensitive;
            let stepActions: AiAction[] = [];

            // Sensitive steps decrypt first: missing ciphertext / decrypt failure fails the step directly, never letting the LLM fill blindly
            stepSecret = undefined;
            if (s.sensitive) {
              if (!s.secretCiphertext || !s.secretIv || !s.secretTag) {
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: 'sensitive 步骤缺少密文（secret-missing）', failureReason: 'SecretMissing',
                });
                ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: 'sensitive 步骤缺少密文' });
                failedIndex = i;
                break;
              }
              try {
                stepSecret = decrypt({
                  ciphertext: Buffer.from(s.secretCiphertext, 'base64'),
                  iv: Buffer.from(s.secretIv, 'base64'),
                  tag: Buffer.from(s.secretTag, 'base64'),
                });
              } catch {
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: '敏感字段解密失败（secret-decrypt）', failureReason: 'SecretMissing',
                });
                ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: '敏感字段解密失败' });
                failedIndex = i;
                break;
              }
            }

            if (s.delayMs) await page.waitForTimeout(s.delayMs);
            // Assertion text checkup: a descriptive phrase ("登录表单正常展示" style) can never be matched on the page,
            // so judge it once against the real page; judged descriptive, it's dropped from this round's instruction and from the mechanical replay.
            let assertionForRun: unknown = s.assertion;
            let droppedAssertion: string | null = null;
            if (typeof s.assertion === 'string' && s.assertion.trim()) {
              const pageText = await page
                .evaluate(() => document.body?.innerText ?? '')
                .catch(() => '');
              const verdict = await judgeAssertionText(s.assertion, pageText, client, ctx.lang);
              // Verdict written back to this round's cache: resume rounds' prefix steps reuse last round's verdicts (mechanical restore no longer judges per round)
              verdictsThisRound.set(s.id, { real: verdict.real, ...(verdict.real ? {} : { dropped: s.assertion }) });
              if (verdict.real) {
                // Last round judged it a descriptive phrase but this round re-judges it as real page copy: clear the stale dropped record,
                // otherwise the mechanical replay would keep nulling the assertion (this round's AI phase carries it as usual while replay skips it — inconsistent).
                droppedAssertions.delete(s.id);
              } else {
                assertionForRun = null;
                droppedAssertion = s.assertion;
                droppedAssertions.set(s.id, s.assertion);
              }
            }
            // Pure mechanical steps (sql / httpRequest / observeLog / sendSyslog): don't go through the browser,
            // the browser AI phase structurally cannot execute them — letting it try only burns turns (prod228 2026-10-28 record:
            // "the AI phase is a browser executor and cannot execute SQL queries against the database", over 5 turns unfinished).
            // Their truth is adjudicated by the closing compiled mechanical dry run (runSql/runHttpRequest bypass Playwright);
            // record passed directly here — a dry-run failure is honestly reported as ReplayDivergence and won't be let through.
            if (mode !== 'mechanical' && isMechanicalOnlyStep(s.compiled)) {
              stepResults.push({
                order: s.order, status: 'passed', durationMs: Date.now() - started,
                warning: '机械执行步（不经浏览器），由结尾 compiled 干跑裁决',
              });
              ctx.emit({
                type: 'verify_progress', phase: 'step_done', order: s.order, status: 'passed',
                reason: '机械执行步（不经浏览器），由结尾 compiled 干跑裁决',
              });
              continue;
            }
            const instruction = buildStepInstruction(
              { order: s.order, instruction: s.instruction, compiled: s.compiled, assertion: assertionForRun },
              effectiveSteps.length,
              { hasLogin: !!envCtx.login, hasSecret: stepSecret !== undefined },
              droppedAssertion,
              webManifest,
              // Mixed step (browser actions + mechanical steps): tell the AI to do only the browser half, don't reach for the mechanical half.
              hasMechanicalStep(s.compiled),
            );
            ctx.emit({
              type: 'verify_progress', phase: 'step_start', order: s.order,
              brief: (s.instruction ?? JSON.stringify(s.compiled) ?? '').slice(0, 120),
            });
            // compiled fidelity pre-check: click/hover target elements should already be on the page right now; unresolvable → fail directly (no AI turns burned)
            const preErr = await checkCompiledLocators(page, s.compiled, 'pre');
            if (preErr) {
              stepResults.push({
                order: s.order, status: 'failed', durationMs: Date.now() - started,
                error: preErr.message, failureReason: preErr.reason,
                screenshot: await writeStepScreenshot(reportId, i + 1, page),
              });
              ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: preErr.message.slice(0, 120) });
              failedIndex = i;
              break;
            }
            let aiRun: Promise<string> | undefined;
            let guardTimer: NodeJS.Timeout | undefined;
            try {
              // Per-step AI-phase wall-clock cap: runAiTask is only bounded by turns (STEP_MAX_TURNS) with no wall-clock limit; on a slow SUT one turn
              // dragging to minutes would eat the whole global budget. Cap trips → fail-stop that step (StepTimedOut), abandoning the in-flight aiRun
              // (its rejection is swallowed in the catch; the browser is closed in final wrap-up).
              aiRun = runAiTask(page, instruction, client, false, {
                maxTurns: STEP_MAX_TURNS,
                valueSub,
                lang: ctx.lang,
                // Successful actions collected in execution order (original params before placeholder substitution, same convention as solidify_case)
                onAction: (action, ok) => {
                  if (solidifiable && ok) stepActions.push(action);
                },
              });
              const stepGuard = new Promise<never>((_, reject) => {
                guardTimer = setTimeout(() => reject(new Error(`STEP_TIMEOUT:${s.order}`)), STEP_AI_TIMEOUT_MS);
              });
              const summary = await Promise.race([aiRun, stepGuard, stopGuard]);
              clearTimeout(guardTimer);
              const parsed = tryParseJson(summary);
              if (parsed && parsed.status === 'failed') {
                // LLM self-reported failure: fail-stop, reason goes straight into the feedback
                const reason = typeof parsed.reason === 'string' ? parsed.reason : summary.slice(0, 200);
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: reason, failureReason: 'StepReportedFailed',
                  screenshot: await writeStepScreenshot(reportId, i + 1, page),
                });
                ctx.emit({
                  type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: reason.slice(0, 120),
                  ...(typeof parsed?.login === 'string' ? { login: parsed.login } : {}),
                });
                failedIndex = i;
                break;
              }
              if (parsed?.login === 'logged-in') login = 'logged-in';
              // compiled fidelity post-check: assert*/fill/check/select/extract elements should still be there when the actions end;
              // the AI can bypass a bad locator live, but replay executes compiled verbatim — failing this check means replay will definitely fail
              const postErr = await checkCompiledLocators(page, s.compiled, 'post');
              if (postErr) {
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: postErr.message, failureReason: postErr.reason,
                  screenshot: await writeStepScreenshot(reportId, i + 1, page),
                });
                ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: postErr.message.slice(0, 120) });
                failedIndex = i;
                break;
              }
              // Only register the trace when the step fully passed (including the post-locator check): empty arrays are registered too (the solidify side maps them to
              // kept-aiTask "无可映射动作", matching the real-run path's result)
              if (solidifiable) collectedTrace.set(s.id, stepActions);
              stepResults.push({
                order: s.order, status: 'passed', durationMs: Date.now() - started,
                screenshot: await writeStepScreenshot(reportId, i + 1, page),
                // Contract-drift fallback: a non-JSON summary still counts as passing, but the raw text is surfaced as a warning for manual review
                ...(parsed ? {} : { warning: summary.slice(0, 200) }),
              });
              ctx.emit({
                type: 'verify_progress', phase: 'step_done', order: s.order, status: 'passed',
                durationMs: Date.now() - started,
                // Per-step login behavior reported by the LLM that round (including contract drift, shown as-is)
                ...(typeof parsed?.login === 'string' ? { login: parsed.login } : {}),
                ...(parsed ? {} : { reason: summary.slice(0, 120) }),
              });
              // This step's side effects have landed on the page: the keep-alive commit convention's effective prefix advances by one
              appliedCount = i + 1;
            } catch (e) {
              clearTimeout(guardTimer);
              // User stop: discard the in-flight aiRun (finally closes the browser to terminate it), progress card wraps up as cancelled.
              // runAiTask has no AbortSignal; after abandonment it keeps driving the page — mark zombie to forbid keep-alive.
              if (signal?.aborted) {
                zombie = true;
                void aiRun?.catch(() => undefined);
                ctx.emit({ type: 'verify_progress', phase: 'end', result: 'cancelled' });
                return { ok: false, error: '已停止：用户中断了本次验证' };
              }
              // The watchdog force-closing the browser makes the in-flight runAiTask throw — the real cause here is timeout, not step failure
              if (timedOut) {
                // Global timeout: write the prefix to the cache + carry the completed step count so the next round resumes (see commitTimeoutPrefix)
                return commitTimeoutPrefix('步骤执行中');
              }
              const eMsg = (e as Error).message ?? '';
              if (eMsg.startsWith('STEP_TIMEOUT:')) {
                // The per-step AI phase exceeded STEP_AI_TIMEOUT_MS: fail-stop that step rather than timing out the whole round (abandon the in-flight aiRun)
                zombie = true;
                void aiRun?.catch(() => undefined);
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: `步骤 ${s.order} AI 执行超过 ${STEP_AI_TIMEOUT_MS / 1000}s`, failureReason: 'StepTimedOut',
                  screenshot: await writeStepScreenshot(reportId, i + 1, page),
                });
                ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: `步骤 ${s.order} AI 执行超过 ${STEP_AI_TIMEOUT_MS / 1000}s` });
                failedIndex = i;
                break;
              }
              stepResults.push({
                order: s.order, status: 'failed', durationMs: Date.now() - started,
                error: eMsg.slice(0, 300), failureReason: 'AiTaskAborted',
                screenshot: await writeStepScreenshot(reportId, i + 1, page),
              });
              ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: eMsg.slice(0, 120) });
              failedIndex = i;
              break;
            }
          }

          // ── Prefix confirmation write-back (D2) ──
          // confirmedThrough = the consecutive steps the AI phase truly confirmed this round: when restore fails, resumeIndex has already
          // converged to the global failure point j inside onFailurePage, and the AI resumes from j — only the steps before j are confirmed (rebuilt by the restore
          // mechanical replay), so taking failedIndex (the AI loop's first failure index) covers both paths:
          // all passed → len; restore failed then the AI failed again at k → k (= the prefix confirmation count). confirmedStepResults aligns
          // to global indices: the before-resume segment directly reuses last round's confirmed results, the resume segment takes this round's stepResults;
          // the two join seamlessly without duplication when restore failed (j<validPrefixLen).
          // Mechanical mode doesn't write back prefix confirmation: no AI phase means no newly confirmed steps (last full round's verdict cache is kept)
          if (mode !== 'mechanical') {
            const mergedVerdicts = new Map<string, { real: boolean; dropped?: string }>(prevConfirm?.assertionVerdicts ?? []);
            for (const [id, v] of verdictsThisRound) mergedVerdicts.set(id, v);
            verifyConfirmCache.set(ckey, {
              stepsHash: curStepsHash,
              metaHash: curMetaHash,
              confirmedThrough: failedIndex < 0 ? effectiveSteps.length : failedIndex,
              assertionVerdicts: mergedVerdicts,
              confirmedStepResults: [...prefixConfirmedResults.slice(0, resumeIndex), ...stepResults],
              confirmedTraces: collectedTrace,
            });
          }

          // ── Trace cache write-back (solidify_case zero-execution reuse) ──
          // Save only when the whole round passed and "all required visual steps are on record": prefix steps' traces are carried by the confirmation cache (see
          // the collectedTrace init), this round's AI phase fills in changed steps — resume rounds can therefore also save complete traces.
          // Incomplete coverage (e.g. old-format caches with no traces to carry) prefers absence over garbage: takeFreshTrace's required
          // check would block partial traces anyway; proactively not writing keeps the "on record = usable" semantics clean.
          // Vision failure doesn't block (steps passed; expectedOutcome isn't part of the hash, so changing the expectation doesn't need a live re-run).
          // Any step failure → clear the cache (old traces correspond to old step content; keeping them only misleads freshness checks — the hash would block it,
          // proactive clearing is a double safety, and it keeps getVerifiedTrace's semantics clean).
          // Mechanical mode never touches the trace cache: this round has no AI phase, so there's no trace to save and last live round's cache must not be cleared
          // (clearing it would make later solidify needlessly fall back to a real run).
          const tkey = traceKey(ctx.threadId, caseId);
          let traceSavedNow = false;
          if (mode !== 'mechanical') {
            if (failedIndex < 0) {
              const solidifiableIds = effectiveSteps.filter((s) => isVisualStep(s) && !s.sensitive).map((s) => s.id);
              if (solidifiableIds.every((id) => collectedTrace.has(id))) {
                saveVerifiedTrace(tkey, curStepsHash, curMetaHash, collectedTrace);
                traceSavedNow = true;
              }
            } else {
              clearVerifiedTrace(tkey);
            }
          }

          // Case-level final-state judgment: the same vision assertion as formal replay (cdp.ts runCaseVisionAssert);
          // after all steps pass, expectedOutcome is judged — verify_case can't only guarantee "steps execute", it must guarantee "the final state matches expectations".
          // Mechanical mode's final-state judgment moves after the mechanical dry run (judged on the dry run's terminal page, see after the replay section).
          let visionFailure: { error?: string | null; humanMessage?: string | null; screenshot?: string | null; failureReason?: string | null; console?: ConsoleLogEntry[] } | null = null;
          if (mode !== 'mechanical' && failedIndex < 0 && typeof effectiveCase.expectedOutcome === 'string' && effectiveCase.expectedOutcome.trim()) {
            const va = await runCaseVisionAssert({
              page,
              reportId,
              caseTitle: effectiveCase.title,
              caseUrl: targetUrl ?? null,
              expectedOutcome: effectiveCase.expectedOutcome,
              vars: {},
              sensitiveVarKeys: [],
              llmClient: client,
            });
            if (va?.failureStep) {
              visionFailure = va.failureStep;
              ctx.emit({
                type: 'verify_progress', phase: 'step_done', order: -1, status: 'failed',
                reason: (va.failureStep.error ?? '终态与用例预期不符').slice(0, 120),
              });
            }
          }

          // Login-state write-back: doesn't rely on the LLM-reported login field (measured contract-drift underreporting); with login configured, unconditionally save the current session —
          // when not logged in, what's saved is an anonymous session, and after injection next round the AI still recognizes the login page, logs in again, and overwrites (self-healing).
          // The watchdog timeout path returns early inside the loop and never reaches here.
          const savedState = await context.storageState().catch(() => null);
          if (savedState) saveLoginState(loginKey, savedState);

          // ── compiled mechanical replay dry run: runs only after the whole AI phase passed (steps + final-state judgment), the final adjudication gate ──
          // Formal replay dispatches compiled verbatim; the AI's live execution can adaptively correct — the fork between the two (e.g. a click landing
          // on a component wrapper's center that doesn't trigger behavior) only real-machine replay can expose. Reuses executeCaseInBrowser:
          // a new page on the same context (login state carried by cookies), no DB report written; screenshots go to the -replay
          // directory, avoiding the AI phase's same-named step-N.png overwriting each other. Side effects match formal execution (the second execution
          // conveniently exposes replay fragilities like unique-name conflicts — intentional semantics).
          //
          // Discussion-phase live-test scenario: when draft steps are pure natural language (no compiled), skip the mechanical dry run — there's nothing to dispatch
          // verbatim; running it would only report an "unknown error" via compile-missing, misleading the user into thinking the case is broken.
          // full mode also skips for pure aiTask (visual mode); but mechanical mode must dry run: aiTask is a formally
          // dispatchable action (dispatch is really executed by the AI), and solidify-produced all-aiTask results' acceptance lands exactly in this round.
          const allVisual = isAllVisualSteps(effectiveSteps);
          // Dry-run subset: mixed cases feed only pure mechanical steps (natural-language steps dispatched verbatim inevitably compile-miss into false divergence,
          // compiled UI steps without their precondition state inevitably misjudge too) — see the pickReplayTargets comment.
          const replayTargets = pickReplayTargets(effectiveSteps, mode);
          let replayFailure: ExecStepResult | null = null;
          let replaySteps: ExecStepResult[] = [];
          let replayStartedAt = 0;
          if (failedIndex < 0 && !visionFailure && (mode === 'mechanical' || !allVisual) && replayTargets.length > 0) {
            ctx.emit({ type: 'verify_progress', phase: 'replay_start' });
            replayStartedAt = Date.now();
            try {
              // Sensitive-field injection reuses buildReplaySecrets at the top (restore and the closing full replay share one decryption table)
              // Stop can preempt the dry run: the in-flight replay terminates when finally closes the browser; swallow the exception, don't rethrow.
              const replayPromise = executeCaseInBrowser(
                caseId,
                replayTargets.map(mapForReplay),
                {
                  reportId: `${reportId}-replay`,
                  envCtx,
                  llmClient: client,
                  liveView: live,
                  ...(replaySecrets.size > 0
                    ? { secretResolver: async (stepId: string) => replaySecrets.get(stepId) ?? null }
                    : {}),
                  ...(caseWebOrigin ? { caseWebOrigin } : {}),
                  caseWebServiceRef: effectiveCase.webServiceRef ?? null,
                  caseTitle: effectiveCase.title,
                  caseUrl: targetUrl ?? null,
                  // onPageReady fires unconditionally (the terminal page is available on success too): mechanical mode's final-state judgment/evidence
                  // collection lands on the dry-run page; in full mode an onFailurePage trigger overwrites it with the fork scene page.
                  onPageReady: (p: Page) => { replayPage = p; },
                },
                browser,
                context,
                targetUrl,
                undefined,
                undefined,
                undefined,
                async (p) => {
                  // onFailurePage fires only on divergence failure; normal-path page switches are done by runStepsInContext's
                  // ctx.liveView.setPage at page creation (the replay ExecContext already carries liveView).
                  replayPage = p;
                },
              );
              void replayPromise.catch(() => undefined);
              replaySteps = await Promise.race([replayPromise, stopGuard]);
              replayFailure = replaySteps.find((r) => r.status === 'failed') ?? null;
            } catch (e) {
              if (signal?.aborted) {
                // The in-flight replay (runStepsInContext) has no stoppable signal; after abandonment it keeps running — keep-alive forbidden
                zombie = true;
                ctx.emit({ type: 'verify_progress', phase: 'end', result: 'cancelled' });
                return { ok: false, error: '已停止：用户中断了本次验证' };
              }
              if (timedOut) return commitTimeoutPrefix('机械回放中');
              zombie = true; // Unexpected exception: the in-flight replay's state is unknown, keep-alive forbidden
              throw e;
            }
            if (signal?.aborted) {
              zombie = true;
              ctx.emit({ type: 'verify_progress', phase: 'end', result: 'cancelled' });
              return { ok: false, error: '已停止：用户中断了本次验证' };
            }
            if (timedOut) return commitTimeoutPrefix('机械回放中');
            ctx.emit({
              type: 'verify_progress',
              phase: 'replay_done',
              status: replayFailure ? ('failed' as const) : ('passed' as const),
              ...(replayFailure
                ? { reason: (replayFailure.humanMessage ?? replayFailure.error ?? 'compiled 机械回放分叉').slice(0, 120) }
                : {}),
            });
          }

          // ── Mechanical-mode final-state judgment: after the dry run succeeds, judge expectedOutcome on the dry run's terminal page ──
          // (full mode's vision already ran after the AI phase above; replayPage is handed back unconditionally by onPageReady)
          if (mode === 'mechanical' && !replayFailure && !visionFailure
            && typeof effectiveCase.expectedOutcome === 'string' && effectiveCase.expectedOutcome.trim()) {
            const va = await runCaseVisionAssert({
              page: replayPage ?? page,
              reportId,
              caseTitle: effectiveCase.title,
              caseUrl: targetUrl ?? null,
              expectedOutcome: effectiveCase.expectedOutcome,
              vars: {},
              sensitiveVarKeys: [],
              llmClient: client,
            });
            if (va?.failureStep) {
              visionFailure = va.failureStep;
              ctx.emit({
                type: 'verify_progress', phase: 'step_done', order: -1, status: 'failed',
                reason: (va.failureStep.error ?? '终态与用例预期不符').slice(0, 120),
              });
            }
          }
          // Final-state/evidence collection page: mechanical mode uses the dry-run page (the AI phase never ran; the initial page is about:blank); full mode uses the AI phase's page
          const visionPage = mode === 'mechanical' ? (replayPage ?? page) : page;

          // ── Failure wrap-up: failed-page element listing (for the agent to fix locators) ──
          let failurePage: Awaited<ReturnType<typeof extractPageElements>> | null = null;
          if (replayFailure) {
            // On replay divergence prefer the dry run's own page (the divergence scene); the AI's old page state has already drifted
            failurePage = await extractPageElements(replayPage ?? page).catch(() => null);
          } else if (failedIndex >= 0 || visionFailure) {
            failurePage = await extractPageElements(visionPage).catch(() => null);
          }

          // On final-state judgment failure, additionally probe the "environment has no precondition data" signal: with an empty table/0 rows, the note names the data gap directly,
          // preventing the AI from masking failure as pass by watering down expectedOutcome
          const emptyDataHint = visionFailure ? await detectEmptyDataState(visionPage) : null;

          // ── Result assembly (succinct on success, information-dense on failure) ──
          // The response's steps merge by global step order: resume prefix steps reuse last round's confirmed results (screenshot paths stay accessible across rounds),
          // steps the AI phase actually executed this round take stepResults; when restore failed and truncated to j, the two segments join seamlessly.
          const stepsSummary = [...prefixConfirmedResults.slice(0, resumeIndex), ...stepResults].map((r) => ({
            order: r.order,
            status: r.status,
            durationMs: r.durationMs,
            ...(r.warning ? { warning: r.warning } : {}),
            ...(r.screenshot ? { screenshot: r.screenshot } : {}),
            ...(r.error ? { error: r.error } : {}),
            ...(r.failureReason ? { failureReason: r.failureReason } : {}),
          }));
          const replaySummary = replaySteps.map((r) => ({
            order: r.order,
            status: r.status,
            durationMs: r.durationMs,
            ...(r.error ? { error: r.error } : {}),
            ...(r.failureReason ? { failureReason: r.failureReason } : {}),
            ...(r.screenshot ? { screenshot: r.screenshot } : {}),
            ...(r.hitLocator ? { hitLocator: r.hitLocator } : {}),
            // DB-query results the dry run produced: the agent confirms ground truth from them (table names/field names/data shapes) instead of guessing via probe cases.
            ...(r.sql ? { sql: { dbRef: r.sql.dbRef, rowCount: r.sql.rowCount, rows: r.sql.rows, assertion: r.sql.assertion } } : {}),
          }));
          // Checkup-dropped assertions returned verbatim: the LLM uses them to rewrite "descriptive phrases" into real page
          // UI copy (or simply delete them), rather than masking failure by weakening assertions.
          const droppedNotes = [...droppedAssertions.entries()].map(([id, text]) => ({
            order: effectiveSteps.find((s) => s.id === id)?.order ?? 0,
            assertion: text,
          }));
          const droppedField = droppedNotes.length > 0 ? { droppedAssertions: droppedNotes } : {};
          if (failedIndex < 0 && !visionFailure && !replayFailure) {
            // cacheSaved: normal wrap-ups all write back unconditionally (the watchdog timeout path returns early inside the loop, no end event)
            ctx.emit({ type: 'verify_progress', phase: 'end', result: 'passed', cacheSaved: true });
            // Success-page live listing (symmetric with failure.page): interactive controls genuinely present on the terminal page.
            // When discussing next steps or proposing filters/buttons mid-run, the agent may only cite these — fabricating filters is blocked at the source.
            // replayPage is the dry run's terminal page; pure visual drafts skip the dry run and fall back to the AI phase's page.
            const successPage = await extractPageElements(replayPage ?? page).catch(() => null);
            const rdata = withRoundNotes({
              result: 'passed',
              caseId,
              envId: envCtx.envId,
              targetUrl: targetUrl ?? null,
              // Mechanical mode has no AI phase: no login self-report and no new traces to save
              ...(mode === 'mechanical'
                ? { mode: 'mechanical' as const }
                : {
                    login,
                    // Trace cached → the immediately following solidify_case can solidify in seconds with zero execution (the agent guides the user accordingly)
                    traceSaved: traceSavedNow,
                  }),
              resumeFrom: resumeIndex,
              ...(reused ? { browserReused: true as const } : {}),
              basedOn: stagedCase || opsApplied > 0 ? ('staged' as const) : ('db' as const),
              stagedOpsApplied: opsApplied,
              ...(staticAnalysis.length > 0 ? { staticAnalysis } : {}),
              steps: stepsSummary,
              ...droppedField,
              ...(successPage ? { page: successPage } : {}),
              // replay is only meaningful when the mechanical dry run actually ran: in full mode all-visual cases skip the dry run,
              // and emitting durationMs then would be the Date.now()-0 epoch garbage value (seen 6 times in prod228).
              // The dry run's per-step details (including DB-query rows) are carried out together: the agent confirms ground truth from them,
              // no longer needing separate probe cases to guess table names/field names/data shapes.
              ...(replayStartedAt > 0
                ? { replay: { result: 'passed' as const, durationMs: Date.now() - replayStartedAt, steps: replaySummary } }
                : {}),
            });
            completed = true; // Normal completion emission point: all in-flight async has settled, browser state is keep-alive-able
            updateRoundState(roundKey(ctx.threadId, caseId), rdata);
            return { ok: true, data: rdata };
          }
          if (visionFailure) {
            ctx.emit({ type: 'verify_progress', phase: 'end', result: 'failed', cacheSaved: true });
            // Attribution fully delegated to the LLM (failureDiagnosis): shape-agnostic evidence = the failed step's live hit counts per locator candidate
            // + the visible-overlay listing + the failed page's interactive-element listing, plus the empty-data signal as extraHint.
            const visionStep = effectiveSteps[effectiveSteps.length - 1] ?? null;
            const visionProbes = await probeLocatorHits(visionPage, collectStepLocators(visionStep?.compiled));
            const visionOverlays = (await extractPageEvidence(visionPage)).overlays;
            const visionEvidenceField =
              visionProbes.length > 0 || visionOverlays.length > 0
                ? { evidence: { overlays: visionOverlays, probes: visionProbes } }
                : {};
            const visionDiag = failurePage
              ? await diagnoseFailure({
                  client,
                  step: visionStep,
                  assertion: visionStep?.assertion ?? null,
                  probes: visionProbes,
                  overlays: visionOverlays,
                  elements: failurePage,
                  lang: ctx.lang,
                  ...(visionFailure.console?.length ? { consoleErrors: visionFailure.console } : {}),
                  ...(emptyDataHint ? { extraHint: `失败页检出空数据信号「${emptyDataHint}」` } : {}),
                })
              : null;
            const rdata = withRoundNotes({
              result: 'failed',
              caseId,
              envId: envCtx.envId,
              targetUrl: targetUrl ?? null,
              ...(mode === 'mechanical' ? { mode: 'mechanical' as const } : { login }),
              resumeFrom: resumeIndex,
              basedOn: stagedCase || opsApplied > 0 ? ('staged' as const) : ('db' as const),
              stagedOpsApplied: opsApplied,
              ...(staticAnalysis.length > 0 ? { staticAnalysis } : {}),
              steps: stepsSummary,
              ...droppedField,
              failure: {
                stepOrder: -1,
                action: null,
                error: visionFailure.error ?? '最终页面与用例预期不符',
                failureReason: visionFailure.failureReason ?? 'VisionAssertionFailed',
                humanMessage: visionFailure.humanMessage ?? '最终页面与用例预期不符',
                screenshot: visionFailure.screenshot ?? null,
                page: failurePage,
                ...visionEvidenceField,
                note: `vision 终态判定失败：${mode === 'mechanical' ? '机械步骤全部执行通过后' : '全部步骤执行通过后'}，最终页面仍不符合 expectedOutcome。请核对最后几步的实际业务效果，修正步骤或 expectedOutcome 后重验。${mode === 'mechanical' ? '（机械验收模式：步骤语义未经 AI 相复核、描述性断言按上一轮判定或字面处理——修正后重跑 mechanical，拿不准改 mode=full 复核。）' : ''}${emptyDataHint ? ` ⚠ 失败页检出空数据信号「${emptyDataHint}」：被测环境当前没有可供断言的数据，这通常是环境前置数据缺失，而非选择器/步骤写错。正确做法是让用例先创建出满足 expectedOutcome 的数据（例如造一条会自动触发处置的事件），或如实向用户汇报环境缺数据——严禁通过弱化 expectedOutcome（如把"自动启动处置成功"改成"页面正常加载"）把失败蒙成通过。` : ''}${visionDiag ? ` ⚠ 归因:${visionDiag.note}` : ''}`,
              },
            });
            completed = true; // Normal completion emission point: all in-flight async has settled, browser state is keep-alive-able
            updateRoundState(roundKey(ctx.threadId, caseId), rdata);
            return { ok: true, data: rdata };
          }
          if (replayFailure) {
            const failedReplayStep = effectiveSteps.find((s) => s.order === replayFailure!.order) ?? null;
            const replayIdx = failedReplayStep ? effectiveSteps.indexOf(failedReplayStep) : -1;
            const replayHint = replayIdx >= 0 ? summarizeStaticReports(staticByStep[replayIdx] ?? []) : null;
            // Attribution fully delegated to the LLM: the divergence scene page's (the replay's own page) candidate hits + overlays + element listing
            const replayPageForDiag = replayPage ?? page;
            const replayProbes = await probeLocatorHits(replayPageForDiag, collectStepLocators(failedReplayStep?.compiled));
            const replayOverlays = (await extractPageEvidence(replayPageForDiag)).overlays;
            const replayEvidenceField =
              replayProbes.length > 0 || replayOverlays.length > 0
                ? { evidence: { overlays: replayOverlays, probes: replayProbes } }
                : {};
            const replayDiag = failurePage
              ? await diagnoseFailure({
                  client,
                  step: failedReplayStep,
                  assertion: failedReplayStep?.assertion ?? null,
                  probes: replayProbes,
                  overlays: replayOverlays,
                  elements: failurePage,
                  lang: ctx.lang,
                  ...(replayFailure.console?.length ? { consoleErrors: replayFailure.console } : {}),
                })
              : null;
            ctx.emit({ type: 'verify_progress', phase: 'end', result: 'failed', cacheSaved: true });
            const rdata = withRoundNotes({
              result: 'failed',
              caseId,
              envId: envCtx.envId,
              targetUrl: targetUrl ?? null,
              ...(mode === 'mechanical' ? { mode: 'mechanical' as const } : { login }),
              resumeFrom: resumeIndex,
              basedOn: stagedCase || opsApplied > 0 ? ('staged' as const) : ('db' as const),
              stagedOpsApplied: opsApplied,
              ...(staticAnalysis.length > 0 ? { staticAnalysis } : {}),
              steps: stepsSummary,
              ...droppedField,
              replay: replaySummary,
              failure: {
                stepOrder: replayFailure.order,
                action: failedReplayStep?.compiled ?? null,
                error: replayFailure.error ?? null,
                failureReason: 'ReplayDivergence',
                humanMessage: replayFailure.humanMessage ?? replayFailure.error ?? null,
                screenshot: replayFailure.screenshot ?? null,
                page: failurePage,
                // The failed step's DB-query result (rows remain even when the assertion missed — the executor writes the sink before judging the assertion):
                // the agent sees "what's actually in the DB" and can fix expected/the query condition; no probe cases needed to grope for data.
                ...(replayFailure.sql
                  ? {
                      sql: {
                        dbRef: replayFailure.sql.dbRef,
                        rowCount: replayFailure.sql.rowCount,
                        rows: replayFailure.sql.rows,
                        assertion: replayFailure.sql.assertion,
                      },
                    }
                  : {}),
                ...replayEvidenceField,
                note: `${mode === 'mechanical' ? '机械验收模式（无 AI 相对照）下 compiled 机械逐字执行失败' : 'AI 临场执行能通过，但与正式回放同引擎的 compiled 机械逐字执行失败（回放分叉）'}——典型如 click 落在组件 wrapper 上不触发实际行为、唯一名冲突二次执行必挂。请用 failure.page.elements 中真实存在的选择器把该步 compiled 改成更精确的可操作目标（组件内部真实接收点击/输入的元素），或修正测试数据策略（时间戳命名）后重验。${mode === 'mechanical' ? '（机械模式无自动登录：若失败页是登录页，多为登录态缓存失效/副本重启——改 mode=full 重新实测登录即可；同因连续两轮失败或归因不明也建议改 full 复核。）' : ''}${replayDiag ? ` ⚠ 归因:${replayDiag.note}` : ''}${replayHint ? ` 源码静态提示:${replayHint}` : ''}`,
              },
            });
            completed = true; // Normal completion emission point: all in-flight async has settled, browser state is keep-alive-able
            updateRoundState(roundKey(ctx.threadId, caseId), rdata);
            return { ok: true, data: rdata };
          }
          // In resume rounds stepResults is only collected from resumeIndex on (local indices) while failedIndex is the global step order —
          // the two differ by a resumeIndex offset; taking stepResults[failedIndex] directly would be undefined (
          // "Cannot read properties of undefined (reading 'order')")
          const failed = stepResults[failedIndex - resumeIndex]!;
          const failedStep = effectiveSteps[failedIndex]!;
          const failedHint = summarizeStaticReports(staticByStep[failedIndex] ?? []);
          // Natural-language step (no compiled / pure aiTask) AI-phase failure triage: this is not a locator technical error —
          // most likely the step description doesn't match the page reality (including earlier steps steering the page astray); the agent has no
          // self-fix to make and rerunning won't change the result. The failure note points at "report to the user for adjustment" not "fix the locator".
          const nlAiFail = AI_PHASE_FAIL_REASONS.has(failed.failureReason ?? '')
            && (!failedStep.compiled
              || (Array.isArray(failedStep.compiled)
                && failedStep.compiled.every((a) => (a as { kind?: string }).kind === 'aiTask')));
          if (nlAiFail) {
            // R3.5: record one raw failure signal (fire-and-forget; on failure only warns, doesn't affect verify)
            void recordNlAiFailSignal({
              threadId: ctx.threadId, projectId: ctx.projectId, caseId, stepOrder: failed.order,
              payload: {
                caseTitle: effectiveCase.title,
                stepInstruction: failedStep.instruction ?? '',
                failureReason: failed.failureReason ?? 'unknown',
                targetUrl: targetUrl ?? null,
                pageUrl: page.url(),
              },
            });
          }
          // Attribution fully delegated to the LLM: failed-page candidate hits + overlays + element listing (+ this round's browser JS error buffer)
          const stepProbes = await probeLocatorHits(page, collectStepLocators(failedStep.compiled));
          const stepOverlays = (await extractPageEvidence(page)).overlays;
          const failedConsole = consoleCapture.drain();
          const stepEvidenceField =
            stepProbes.length > 0 || stepOverlays.length > 0
              ? { evidence: { overlays: stepOverlays, probes: stepProbes } }
              : {};
          const stepDiag = failurePage
            ? await diagnoseFailure({
                client,
                step: failedStep,
                assertion: failedStep.assertion,
                probes: stepProbes,
                overlays: stepOverlays,
                elements: failurePage,
                lang: ctx.lang,
                ...(failedConsole.length ? { consoleErrors: failedConsole } : {}),
              })
            : null;
          ctx.emit({ type: 'verify_progress', phase: 'end', result: 'failed', cacheSaved: true });
          const rdata = withRoundNotes({
            result: 'failed',
            caseId,
            envId: envCtx.envId,
            targetUrl: targetUrl ?? null,
            login,
            resumeFrom: resumeIndex,
            basedOn: stagedCase || opsApplied > 0 ? ('staged' as const) : ('db' as const),
            stagedOpsApplied: opsApplied,
            ...(staticAnalysis.length > 0 ? { staticAnalysis } : {}),
            steps: stepsSummary,
            failure: {
              stepOrder: failed.order,
              action: failedStep.compiled ?? null,
              error: failed.error ?? null,
              failureReason: failed.failureReason ?? null,
              humanMessage: failed.error ?? null,
              screenshot: failed.screenshot ?? null,
              page: failurePage,
              ...stepEvidenceField,
              // Browser JS errors caught within this round's window: the agent sees the frontend-side fault signal directly when fixing steps.
              ...(failedConsole.length ? { console: failedConsole } : {}),
              note: nlAiFail
                ? `该步是自然语言步骤，由 AI 相（视觉执行）在真实页面上执行失败（${failed.failureReason ?? '未知'}）——大概率不是 locator 技术问题，而是步骤描述与页面实际不符：目标不存在/措辞歧义/前置状态没建立，也可能是前面某步的描述把页面带偏。这不是你能自行修复的错误：立即停止重跑与自诊，把失败详情反馈给用户（步骤 ${failed.order}「${failedStep.instruction ?? ''}」原文、failureReason、失败页 URL 与 page.elements/截图，必要时附前一步原文），请用户选择：a.调整该步或前面步骤的自然语言描述 b.补充入口/页面线索 c.确认环境/数据后重验。用户明确答复前不要再调用 verify_case——AI 相每步耗时 1~2 分钟，盲目重跑只烧时间与 token。**唯一例外：失败页是登录页或与目标业务页无关的首页/概览页时，先 get_login_credentials + perform_login 重新登录再重验本用例**——那是会话过期（登录态缓存 30 分钟）不是步骤写错，登录后可自愈，不必等用户答复。**另一条例外（不要问用户）：失败步语义是查库/调接口确认（原文含查库/落库/接口/请求/状态校验之类）时，这是步骤形态错而非描述错——浏览器里没有 DB 工具，AI 相永远跑不了它：把该步改写成带 compiled 的 sql（查被测系统的库）/ httpRequest（调接口）步，同 localId 重发 stage_case 再验，断言结论由结尾干跑给出。**${stepDiag ? ` ⚠ 归因:${stepDiag.note}` : ''}`
                : `page.elements 为失败页当前可见的可交互元素；修正 locator 只能使用其中真实存在的选择器。快照不含操作后才出现的元素。${failedHint ? ` 源码静态提示:${failedHint}` : ''}${stepDiag ? ` ⚠ 归因:${stepDiag.note}` : ''}`,
            },
          });
          updateRoundState(roundKey(ctx.threadId, caseId), rdata);
          // Failure is also a clean breakpoint: the browser rests at the failure scene (steps before the failed step have taken effect, appliedCount is their count),
          // so the next round resumes from the failed step without re-running the prefix. Not setting completed → finally judges non-keep-alive → the whole browser
          // is discarded, and the main "fail → fix → re-verify" loop (prod228 measured 74% of rounds are failure rounds) forever pays the prefix
          // replay + re-login cost.
          completed = true;
          return { ok: true, data: rdata };
        } finally {
          clearTimeout(timer);
          live?.close();
          // ── Keep-alive decision: normal completion (completed) + no in-flight zombie (zombie) + not timed out + browser connected
          // → commit to the registry for the next round's zero-replay resume; on zombie/timeout/disconnect, hit rounds invalidate (destroy) and
          // fresh rounds close as usual. replayPage isn't the keep-alive terminal page (next round resumes from the AI phase's page), so close it.
          // Login cases are never registered: they rest at this round's own post-login state, and the next round needs exactly a clean session.
          if (
            mode !== 'mechanical' &&
            !loginCase &&
            browser !== undefined && context !== undefined && page !== undefined &&
            completed && !zombie && !timedOut &&
            // Optional-call + strict equality: Browser/Page interfaces always have these two methods; missing methods only appear in test stubs —
            // treat as non-keep-alive (the registry is inert under stub environments, existing test semantics unchanged); real browsers are unaffected.
            browser.isConnected?.() === true && page.isClosed?.() === false
          ) {
            if (replayPage && replayPage !== page && replayPage.isClosed?.() !== true) {
              await replayPage.close().catch(() => undefined);
            }
            commitBrowserSession(
              sessKey,
              { browser, context, page },
              curMetaHash,
              curStepsHash.slice(0, appliedCount),
            );
          } else if (registryOwned) {
            invalidateBrowserSession(sessKey);
          } else if (browser) {
            await browser.close().catch(() => undefined);
          }
          await envCtx.close().catch(() => undefined);
        }
      } catch (e) {
        return { ok: false, error: `验证失败: ${(e as Error).message}` };
      }
    },
  };
}
