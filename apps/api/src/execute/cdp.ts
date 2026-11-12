import { chromium, type Browser, type BrowserContext, type Page, type Frame } from 'playwright-core';
import type {
  StepAction,
  Locator,
  IntentLocator,
  FrameChain,
  FailureReason,
  PreflightReport,
  HitLocator,
  WindowStrategy,
  ObserveLogLineResult,
  SqlStepResult,
  ConsoleLogEntry,
} from '@itest/shared';
import { deepEqual, materializeValue, substituteVars } from '@itest/shared';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testAttachments, testSteps } from '../db/schema.js';
import { decrypt } from '../lib/secret-crypto.js';
import { migrateAssertion } from '../lib/step-migration.js';
import { logger } from '../logger.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCandidates } from './locator-resolver.js';
import { LOCATOR_PROBE_ROUNDS, LOCATOR_PROBE_INTERVAL_MS } from './locator-probe.js';
import { waitForStable, ElementNotStable, waitForDomQuiet } from './stability.js';
import { classify } from './failureClassifier.js';
import { preflight } from './preflight.js';
import { domClick, domFill, domCheck, domSelect } from './domFallback.js';
import { isOpenDropdownFilter } from './dropdownFilter.js';
import { resolveLlmClient } from '../agent/llmSettings.js';
import { runAiTask, solveCaptchaOnce, isCaptchaFailed, CAPTCHA_TASK_RE, SECRET_PH, makeCredentialValueSub, parseCredentialPlaceholder, CREDENTIAL_PLACEHOLDER_SCAN, referencesCredential, buildDegradeContext, type AiAction } from './aiTask.js';
import { buildCredentialSource, renderWebResourceManifest } from './credentialSource.js';
import { mapAiActionsToCompiled, mapSelectorStrict } from './aiActionMap.js';
import { readAiTaskCache, writeAiTaskCache, bumpAiTaskCacheHit } from './aiTaskCache.js';
import { readLocatorCache, writeLocatorCache, bumpLocatorCacheHit } from './locatorCache.js';
import type { EnvCtx } from './envContext.js';
import type { AiFallbackSettings } from './aiFallback.js';
import { runSql } from './sqlQuery.js';
import { runObserveLog } from './syslogReader.js';
import { runHttpRequest, type HttpStepResult } from './httpRequest.js';
import { runSendSyslog, type SyslogStepResult } from './sendSyslog.js';
import { runCaseVisionAssert } from './visionAssert.js';
import { createConsoleCapture } from './consoleCapture.js';
import { newAiUsage, type AiUsageStat, type AiUsageAccumulator, type AiUsageAddend } from './aiUsage.js';
import { annotateAction, clearAnnotation, type LiveViewHandle } from './liveView.js';

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

/** Fallback selectors for popup/notification-class elements; used for the assertText errorMessage target. */
const ERROR_MESSAGE_SELECTORS = [
  '.ant-message',
  '.toast',
  '[role="alert"]',
  '.el-message',
  '.ivu-message',
];

/** Postgres uuid column shape validation; avoids 22P02 from malformed ids. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExecStepResult {
  order: number;
  status: 'passed' | 'failed';
  durationMs: number;
  /** Step start time (ISO string); missing in older reports — the report page hides the「开始」(start) label accordingly. */
  startedAt?: string;
  error?: string;
  screenshot?: string;
  warning?: string;
  /** Failure classification (produced by failureClassifier); empty for passed steps */
  failureReason?: FailureReason;
  /** User-facing failure explanation */
  humanMessage?: string;
  /** Locator kind/value actually hit by this step */
  hitLocator?: HitLocator;
  /** Index of the switchTab target page in tabMap; 0 for non-tab steps */
  tabIndex?: number;
  /** Result of a sql step (present only on sql steps, undefined otherwise) */
  sql?: SqlStepResult;
  /** Result of an observeLog step (present only on observeLog steps, undefined otherwise) */
  log?: ObserveLogLineResult;
  /** Result of an httpRequest step (present only on httpRequest steps, undefined otherwise) */
  http?: HttpStepResult;
  /** Result of a sendSyslog step (present only on sendSyslog steps, undefined otherwise) */
  syslog?: SyslogStepResult;
  /** Write-back result of the Track 1 case-level vision verdict (present only on the last step or an appended failed step, undefined otherwise). */
  visionAssert?: { passed: boolean; reason: string; screenshot?: string; expected?: string; aiUsage?: AiUsageStat };
  /** This aiTask step's replay took the action cache (mechanical execution, zero LLM); the report shows "cache hit" accordingly. */
  cached?: boolean;
  /** This step's LLM usage (accumulated from aiTask / captcha / vision verdict calls); absent for zero-call steps. */
  aiUsage?: AiUsageStat;
  /** A cache entry existed but replay diverged, and the AI self-heal passed (present only on passed steps; a first run with no cache doesn't count). */
  healed?: boolean;
  /** Mechanical execution was blocked and the AI executed the step on the spot per its instruction (replay AI fallback); the report highlights this accordingly. */
  degraded?: boolean;
  /** Snapshot of the row-level natural-language description (the step's instruction at execution time; empty for recorded cases). The report page shows the step intent from it. */
  instruction?: string;
  /** Snapshot of the compiled DSL (identical to what test_steps stores; sensitive values as templates/placeholders). The report page builds the action summary from it. */
  compiled?: unknown[];
  /** Browser console errors / uncaught JS exceptions within this step's window (attributed per step via consoleCapture drains; omitted when none or unset). */
  console?: ConsoleLogEntry[];
}

export interface ExecContext {
  reportId: string;
  /** The project a case belongs to, for project-scoped attachment resolution; no filtering when absent (backward compatible) */
  projectId?: string;
  /** tabRef → Page（phase2 switchTab） */
  tabMap?: Map<string, Page>;
  /** fileId → attachment metadata; falls back to a db query when absent */
  attachmentResolver?: (fileId: string) => Promise<{ storedPath: string; originalName: string } | null>;
  /** stepId → sensitive-field plaintext; falls back to a db query + decryption when absent */
  secretResolver?: (stepId: string) => Promise<string | null>;
  /** Injected LLMClient; resolves via resolveLlmClient on demand when absent */
  llmClient?: import('../agent/llm-client.js').LLMClient;
  /** Environment context (incl. pg.Pool / syslog connections); injected by the runCase layer, reused across steps. */
  envCtx?: EnvCtx;
  /** Track 1: case-level expectedOutcome (natural language). After the last step finishes, the vision LLM judges the final state from the final screenshot. */
  expectedOutcome?: string | null;
  /** Multi-round captcha verification: registered after the aiTask recognition step succeeds; retried on failure signals when a later click (submit) step completes.
   *  hint = the semantic locator from recording time (data-testid / name), so retry recognition hits the input box precisely. */
  captchaRetry?: { hint: string | null; roundsLeft: number } | null;
  /** Case title (fallback semantic anchor for the vision prompt). */
  caseTitle?: string;
  /** Case url (fallback semantic anchor for the vision prompt). */
  caseUrl?: string | null;
  /** Origin of the case's bound web service: used to join relative navigate urls mid-run; absent when the environment has no web service. */
  caseWebOrigin?: string | null;
  /** The case's bound web service name (environment_objects payload.name): the second-level resolution target for placeholders without an @ref. */
  caseWebServiceRef?: string | null;
  /** Dataset row initial variables (decrypted plaintext, kept only in execution-time memory, never persisted). */
  initialVars?: Record<string, string>;
  /** Set of sensitive dataset column names: related variable values are masked before error messages land in the report (aligned with the recorder's sensitive handling). */
  sensitiveVarKeys?: string[];
  /** Playground live-view source: setPage on each new page so the view follows execution (plan runs / single-case execution). */
  liveView?: LiveViewHandle;
  /** Page-creation-ready callback (fired once after this instance finishes creating a page): the verify_case resume path needs the page
   *  created by mechanical replay to continue the AI phase — runStepsInContext newPages internally without returning the page explicitly,
   *  and onFailurePage only fires at failure breakpoints, so the success path can't get it. Added this optional field; invoked after setPage. */
  onPageReady?: (page: Page) => void;
  /** Replay AI fallback switch (global setting, read and injected by the runCase layer; all off by default = keeps the existing failure semantics). */
  aiFallback?: AiFallbackSettings;
  /** Plan-run abort probe (runPlan injects isCancelRequested): checked before each step; on hit the step is recorded as a
   *  Cancelled failed step and later steps stop — cancellation no longer has to wait for the whole case (the case boundary) to finish. */
  shouldAbort?: () => boolean | Promise<boolean>;
}

/** Case-level window strategy (maximize/current/custom); width/height carried when custom. */
export interface CaseWindow {
  strategy: WindowStrategy;
  width?: number;
  height?: number;
}

interface DispatchOpts {
  page: Page;
  vars: Record<string, string>;
  ctx: ExecContext;
  /** Current step id (for sensitive-fill decryption) */
  stepId?: string;
  /** Owning case id (for aiTask runtime-cache eligibility; absent for callers without case context like executeSteps) */
  caseId?: string;
  /** Records the locator kind/value hit this step (written by tryFirstMatch) */
  hitSink?: { current: HitLocator | null };
  /** Records this step's sql result (written by the sql branch) */
  sqlSink?: { current: SqlStepResult | null };
  /** Records this step's observeLog result (written by the observeLog branch) */
  logSink?: { current: ObserveLogLineResult | null };
  /** Records this step's httpRequest result (written by the httpRequest branch) */
  httpSink?: { current: HttpStepResult | null };
  /** Records this step's sendSyslog result (written by the sendSyslog branch) */
  syslogSink?: { current: SyslogStepResult | null };
  /** Records whether this aiTask step hit the action cache (written by the aiTask branch) */
  cacheSink?: { current: boolean };
  /** This step's LLM usage accumulator (the aiTask / captcha branches add after each complete; read when assembling the stepResult) */
  aiUsage?: AiUsageAccumulator;
  /** Records whether a cache divergence this step was followed by a successful AI self-heal (written by the aiTask branch) */
  healedSink?: { current: boolean };
  /** This step's locator repair memory (written to step_locator_cache on AI-fallback success, read at the start of the step loop);
   *  matched by kind and injected at the tail of the tryFirstMatch candidate chain — a zero-LLM fallback. */
  repairLocator?: { current: { locator: Locator; actionKind: string } | null };
}

/** The repair-cache locator available for the current action (null on kind mismatch, not injected). */
function repairFor(opts: DispatchOpts, action: StepAction): Locator | null {
  const r = opts.repairLocator?.current;
  return r && r.actionKind === action.kind ? r.locator : null;
}

/** Interactive actions: run the stability check before executing */
const INTERACTIVE_KINDS: ReadonlyArray<StepAction['kind']> = ['click', 'fill', 'press', 'check', 'select', 'upload', 'aiTask'];
/** Max retry rounds of multi-round captcha verification (excluding the first recognition+submit round). */
const CAPTCHA_RETRY_ROUNDS = 2;
/** Actions allowed to attempt DOM fallback when the stability check fails */
const DOM_FALLBACK_KINDS: ReadonlyArray<StepAction['kind']> = ['click', 'fill', 'check', 'select'];
/** Non-browser steps: issued directly as protocol requests/data queries without Playwright. AI fallback (on-the-spot execution in the browser)
 *  is structurally impossible for them, so the AI-fallback path skips them, avoiding wasted LLM turns. */
const NON_BROWSER_KINDS: ReadonlySet<string> = new Set(['httpRequest', 'sql', 'observeLog', 'sendSyslog']);

/** DOM fallback: when an element is unstable, bypass playwright and dispatch events in the page directly. Supports click/fill/check/select only.
 *  root may be a Frame (steps with frameChain fall back in the frame context). */
async function tryDomFallback(action: StepAction, opts: DispatchOpts, root: Page | Frame): Promise<{ ok: boolean; error?: string }> {
  const { vars } = opts;
  // Aligned with the playwright path: fill/select string values go through substituteVars first and fail outright on missing vars, avoiding writing {{var}} verbatim into the form.
  if (action.kind === 'fill' || action.kind === 'select') {
    const tpl = typeof action.value === 'string' ? action.value : '';
    if (tpl) {
      const { missing } = substituteVars(tpl, vars);
      if (missing.length > 0) return { ok: false, error: `var-missing: {{${missing[0]!}}}` };
    }
  }
  switch (action.kind) {
    case 'click':
      return domClick(root, action.locator);
    case 'fill':
      return domFill(root, action.locator, resolveEnvCredential(materializeValue(action.value ?? '', vars), opts.ctx));
    case 'check':
      return domCheck(root, action.locator, action.checked);
    case 'select':
      return domSelect(root, action.locator, materializeValue(action.value, vars));
    default:
      return { ok: false, error: 'unsupported' };
  }
}

/** Pre-execution stability check for interactive actions; tries DOM fallback when unstable, throws ElementNotStable when the fallback also fails. */
async function ensureStable(action: StepAction, opts: DispatchOpts, root: Page | Frame): Promise<string | undefined> {
  try {
    // waitForStable's locator parameter is currently unused; root.locator('body') isn't passed to avoid redundant probe calls.
    // Frame steps probe scoped to the frame document (Frame.evaluate shares the same signature); top-level steps match the old behavior.
    await waitForStable(root, undefined as never, { timeoutMs: 2000, pollMs: 100 });
    return undefined;
  } catch (e) {
    if (!(e instanceof ElementNotStable)) {
      // The probe itself failed (evaluate unavailable etc.) → stability can't be assessed; let it through and rely on the action's own timeout.
      return undefined;
    }
    if (
      DOM_FALLBACK_KINDS.includes(action.kind) &&
      // Only secretResolver can decrypt sensitive-fill plaintext; DOM fallback would write the placeholder, so it's skipped.
      !(action.kind === 'fill' && action.sensitive)
    ) {
      const r = await tryDomFallback(action, opts, root);
      if (r.ok) return 'dom-fallback';
    }
    throw e;
  }
}

/** Default attachment resolver: looks up test_attachments by fileId (non-UUIDs miss directly, avoiding 22P02).
 * With projectId provided, adds a project filter so a fileId from another project can't be resolved. */
async function defaultAttachmentResolver(fileId: string, projectId?: string): Promise<{ storedPath: string; originalName: string } | null> {
  if (!fileId || !UUID_RE.test(fileId)) return null;
  const where = projectId
    ? and(eq(testAttachments.id, fileId), eq(testAttachments.projectId, projectId))
    : eq(testAttachments.id, fileId);
  const rows = await db.select().from(testAttachments).where(where);
  const row = rows[0];
  return row ? { storedPath: row.storedPath, originalName: row.originalName } : null;
}

/** Default secret resolver: looks up test_steps by stepId and decrypts (non-UUID or missing ciphertext fields → null). */
async function defaultSecretResolver(stepId: string): Promise<string | null> {
  if (!stepId || !UUID_RE.test(stepId)) return null;
  const rows = await db.select().from(testSteps).where(eq(testSteps.id, stepId));
  const s = rows[0];
  if (!s || !s.sensitive || !s.secretCiphertext || !s.secretIv || !s.secretTag) return null;
  return decrypt({
    ciphertext: Buffer.from(s.secretCiphertext, 'base64'),
    iv: Buffer.from(s.secretIv, 'base64'),
    tag: Buffer.from(s.secretTag, 'base64'),
  });
}

/** fill-value replacer for the mechanical dispatch path — shares makeCredentialValueSub with the AI phase (one implementation,
 *  avoiding a second hand-rolled literal-exact matcher that forks again; this was exactly the 2026-10-21 prod228 root cause).
 *  The mechanical path has no web-attribution semantics; the ref chain always lands on the case's bound web service. */
function resolveEnvCredential(raw: string, ctx: ExecContext): string {
  const parsed = parseCredentialPlaceholder(raw);
  if (!parsed) return raw;
  if (parsed.kind === 'secret' && !parsed.ref) {
    // Step-level ciphertext is only decryptable by the sensitive branch (secretResolver); a placeholder written in compiled has no way to be resolved.
    const e = new Error(`secret-missing: 步骤 compiled 含 ${SECRET_PH}，敏感值只能走 sensitive=true + 密文，不能写占位符`);
    e.name = 'SecretMissing';
    throw e;
  }
  return makeCredentialValueSub(buildCredentialSource(ctx))(raw);
}

/** When the instruction references the sensitive placeholder, decrypts this step's ciphertext for the AI-phase valueSub; referenced but no usable ciphertext → SecretMissing (fail-fast,
 *  no LLM turns burned). Untouched when not referenced. */
async function resolveStepSecretForAi(ctx: ExecContext, stepId: string | undefined, inst: string): Promise<string | undefined> {
  if (!inst.includes(SECRET_PH) || !stepId) return undefined;
  const secret = ctx.secretResolver ? await ctx.secretResolver(stepId) : await defaultSecretResolver(stepId);
  if (!secret) {
    const e = new Error(`secret-missing: 步骤引用了 ${SECRET_PH}，但本步没有可用的敏感值（需 sensitive 步骤密文）`);
    e.name = 'SecretMissing';
    throw e;
  }
  return secret;
}

/** AI-phase pre-check: a credential placeholder (incl. @ref) referenced by the instruction but unresolvable in the current environment → named EnvMissing.
 *  Intercepted before burning LLM turns — a placeholder typed verbatim into the login form always fails (2026-10-21 prod228 measured a whole idle run of 12+ calls). */
function credentialPreflightError(inst: string, ctx: ExecContext): Error | null {
  const phs = inst.match(new RegExp(CREDENTIAL_PLACEHOLDER_SCAN.source, 'g')) ?? [];
  if (phs.length === 0) return null;
  let sub: (v: string) => string;
  try {
    sub = makeCredentialValueSub(buildCredentialSource(ctx));
  } catch (e) {
    return e instanceof Error ? e : null;
  }
  for (const ph of phs) {
    try {
      sub(ph);
    } catch (e) {
      return e instanceof Error ? e : null;
    }
  }
  return null;
}

/** Credential valueSub for the AI phase (fallback / compiled aiTask actions): built at the same construction point as the mechanical phase,
 *  plus the step ciphertext. Real values are substituted only at fill-execution time and never enter LLM context/feedback/logs. */
function aiCredentialSub(ctx: ExecContext, secret: string | undefined): (v: string) => string {
  return makeCredentialValueSub(buildCredentialSource(ctx, secret));
}

/**
 * Executes a single step; returns warning text (undefined if none). Throws on failure; the caller records failed.
 * The entry wraps a finally that clears the action highlight (blackboard): whether the action succeeds or not, the subsequent step screenshot / vision assertion /
 * aiTask turn screenshots all happen after the clear and are never polluted by the drawn border. Recursion (aiTask cache replay dispatching sub-actions) also passes through this entry.
 */
async function dispatch(action: StepAction, opts: DispatchOpts): Promise<string | undefined> {
  try {
    const warning = await dispatchInner(action, opts);
    // Post-click quiet period: the pre-action stability checks (waitForStable/waitTargetEnabled) can't catch "the click succeeded
    // but its effect was wiped by a later async re-render" (prod228 14dd97e2/e3f9a616: the row click landed 275ms before
    // the Search response arrived; once it did, the el-table re-render cleared the current-row selection and the next step
    // waited for Modify until target-disabled). Best-effort wait for settle, never fails the step; also applies to clicks on the dom-fallback warning path.
    // press (Enter submit) is the same family as click — a submit also has a navigation/re-render settle window.
    if (action.kind === 'click' || action.kind === 'press') await waitForDomQuiet(opts.page);
    return warning;
  } finally {
    await clearAnnotation(opts.page);
  }
}

/**
 * Variable substitution in locator expressions: a locator's value often carries dataset variables (e.g. waitFor text={{expectedError}}).
 *
 * Gotcha measured on 2026-10-26 prod228: the waitFor / assertVisible branches missed substitution, so the mechanical layer was actually waiting for
 * **the literal text `{{expectedError}}`** — a string that never exists, so the「wait for the error message to appear」step
 * inevitably failed with count=0, handing the whole step to AI-fallback acceptance (where the AI tends to fabricate the phenomenon → false positive).
 * The fill branch already substituted (action.value); the assertion branches lacked it entirely — the same class of problem fixed in one pass.
 */
function substituteLocators(
  locator: Locator[] | undefined,
  vars: Record<string, string>,
): { locator: Locator[]; missing: string[] } {
  if (!locator || locator.length === 0) return { locator: [], missing: [] };
  const missing: string[] = [];
  const out = locator.map((l) => {
    const { value, missing: miss } = substituteVars(l.value, vars);
    missing.push(...miss);
    return { ...l, value };
  });
  return { locator: out, missing };
}

/** Bounded readiness wait for interactive targets: while the target element (or its ancestor button — recorded locators often land
 *  on a span inside a button, with the disabled attribute on the ancestor) is disabled/loading, wait for it to recover. The fast-paced steps of
 *  recorded replay can outrun page loading (prod228 report 2b64ba27: Modify was clicked during the table's spinner phase and the app never entered
 *  edit mode). Zero wait when already ready (one evaluate of overhead); a probe failure (strict-mode multi-match etc.) is treated as ready,
 *  keeping current behavior; still disabled at the deadline → returns false — the caller must give up (prod228 5b86de6e record: force-clicking
 *  a still-disabled Modify is an ineffective click that doesn't enter edit mode yet keeps going, triggering fill timeout + cascade fallback;
 *  if it can't be waited out, failing is better — handing to AI fallback or going red outright both beat a silent no-op action). Budget 15s: MRM edit-mode
 *  activation measured over 15s, so 5s isn't enough; polls only while the target is genuinely disabled — zero cost for healthy apps. */
const WAIT_TARGET_ENABLED_MS = 15000;

async function waitTargetEnabled(
  page: Page,
  loc: ReturnType<Page['locator']>,
  timeoutMs = WAIT_TARGET_ENABLED_MS,
  pollMs = 250,
): Promise<boolean> {
  const notReady = async (): Promise<boolean | null> => {
    try {
      return await loc.evaluate((el) => {
        const t = (el.closest('button') ?? el) as HTMLElement & { disabled?: boolean };
        return t.disabled === true
          || t.getAttribute('aria-busy') === 'true'
          || t.getAttribute('data-loading') === 'true'
          || t.getAttribute('aria-disabled') === 'true';
      });
    } catch {
      return null;
    }
  };
  const deadline = Date.now() + timeoutMs;
  const maxIters = Math.max(2, Math.ceil(timeoutMs / Math.max(1, pollMs)) + 5);
  for (let iter = 0; iter < maxIters && Date.now() < deadline; iter++) {
    const r = await notReady();
    if (!r) return true; // false=ready; null=unprobeable (strict-mode multi-match etc.) → operate as-is
    await page.waitForTimeout(pollMs).catch(() => undefined);
  }
  return false; // still disabled at the deadline: the caller gives up
}

async function dispatchInner(action: StepAction, opts: DispatchOpts): Promise<string | undefined> {
  const { page, vars } = opts;
  // Frame-chain resolution: steps with frameChain execute in the target frame's context; on resolution failure, fail outright rather than mis-target
  // (falling back to the top document without a chain would execute on the wrong target). Page-level semantics (navigate/switchTab/page-level assertions) carry no chain and are always page.
  // The 'in' guard: 13 DOM actions declare frameChain (optional); navigate/switchTab etc. lack the field.
  const root: Page | Frame = 'frameChain' in action && action.frameChain?.length
    ? await resolveFrameRoot(page, action.frameChain)
    : page;
  // Pre-execution stability check for interactive actions; on instability with a successful DOM fallback, short-circuits with a warning.
  if (INTERACTIVE_KINDS.includes(action.kind)) {
    const stableWarning = await ensureStable(action, opts, root);
    if (stableWarning) return stableWarning;
  }
  switch (action.kind) {
    case 'navigate': {
      const { value, missing } = substituteVars(action.url, vars);
      if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.url}")`);
      // Relative urls (leading /) get joined onto the case's bound web service origin; absolute pass through; other shapes error (spec 2026-10-16).
      const target = value.startsWith('/')
        ? `${opts.ctx.caseWebOrigin ?? ''}${value}`
        : value;
      if (!/^https?:\/\//.test(target)) {
        throw new Error(`invalid-navigate-url: ${target}${value.startsWith('/') ? '(环境未配置 web 服务,无法拼接相对地址)' : ''}`);
      }
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // navigate also waits for SPA hydration before later steps probe elements (aligned with init-goto).
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      return;
    }
    case 'click':
      try {
        // React controlled forms' buttons often remain disabled until onChange → setState → re-render.
        // Here force: true skips the enabled check and clicks directly (a button triggers submit on click as long as the password state is non-empty).
        // But outrunning a genuine loading state loses the click (see the waitTargetEnabled comment) — first do a bounded wait for recovery;
        // if still disabled at the deadline, throw and give up: force-clicking a disabled element is a no-op — prefer failing over doing it wrongly (5b86de6e record).
        const clickLoc = await tryFirstMatch(page, root, action.locator, action.intentLocator, opts.hitSink, repairFor(opts, action));
        if (!(await waitTargetEnabled(page, clickLoc))) {
          throw new Error(`target-disabled: 目标等待 ${WAIT_TARGET_ENABLED_MS}ms 仍处禁用/加载态，拒绝无效强点`);
        }
        // clickCount: 2/3 = double/triple click (set to 2 when the recorder captures a native dblclick); default 1 matches historical behavior.
        await clickLoc.click({ timeout: 5000, force: true, clickCount: action.clickCount ?? 1 });
      } catch (e) {
        if (e instanceof Error && /strict mode violation/.test(e.message)) {
          const loc = await tryFirstMatch(page, root, action.locator, action.intentLocator, opts.hitSink, repairFor(opts, action));
          // No bare first(): Element-UI renders a display:none .hidden-columns template clone as .el-table's first child
          // (.el-table__fixed holds hidden clones too), which precedes the real element in DOM order, so first() grabs
          // an invisible copy and times out after 5s (the 规则查看 replay root cause). Same visible filtering as the assertVisible fallback.
          await loc.filter({ visible: true }).first().click({ timeout: 5000, clickCount: action.clickCount ?? 1 });
          return;
        }
        throw e;
      }
      return;
    case 'scroll': {
      // Absolute-position scrolling: the locator points at the actual scrolling container (window-level scrolling records document.scrollingElement).
      // evaluate sets scrollTop/scrollLeft and the browser clamps to content bounds automatically → replay is deterministic and independent of the starting point.
      // A read-only position write; no stability check/strict fallback needed.
      const scrollLoc = await tryFirstMatch(page, root, action.locator, action.intentLocator, opts.hitSink, repairFor(opts, action));
      await scrollLoc.evaluate(
        (el, [top, left]) => { el.scrollTop = top; el.scrollLeft = left; },
        [action.scrollTop, action.scrollLeft] as [number, number],
      );
      return;
    }
    case 'fill': {
      let value: string;
      if (action.sensitive) {
        const secret = opts.ctx.secretResolver
          ? await opts.ctx.secretResolver(opts.stepId ?? '')
          : await defaultSecretResolver(opts.stepId ?? '');
        if (secret == null) throw new Error(`secret-missing: step ${opts.stepId ?? '(no id)'}`);
        value = secret;
      } else {
        if (typeof action.value === 'string') {
          const sub = substituteVars(action.value, vars);
          if (sub.missing.length > 0) {
            throw new Error(`var-missing: {{${sub.missing[0]!}}} (template="${action.value}")`);
          }
        }
        value = resolveEnvCredential(materializeValue(action.value, vars), opts.ctx);
      }
      const fillLoc = await tryFirstMatch(page, root, action.locator, action.intentLocator, opts.hitSink, repairFor(opts, action));
      if (!(await waitTargetEnabled(page, fillLoc))) {
        throw new Error(`target-disabled: 输入框等待 ${WAIT_TARGET_ENABLED_MS}ms 仍处禁用/加载态，无法填入`);
      }
      try {
        // React controlled forms: fill() only changes the DOM value; onChange doesn't necessarily fire.
        // fill('') first, then pressSequentially to simulate real typing, ensuring the component recomputes state (disabled status, error messages, etc.).
        await fillLoc.fill('', { timeout: 5000 });
        await fillLoc.pressSequentially(value, { delay: 20 });
        // Trigger blur so onChange commits (Antd and friends validate/format synchronously on blur)
        // but the target being an「expanded dropdown's filter box」must not blur: blur clears the query text and closes the candidate list
        // (fatal for remote-search dropdowns); keeping focus and the panel open lets later steps click a candidate.
        if (!(await isOpenDropdownFilter(fillLoc))) {
          await page.keyboard.press('Tab').catch(() => undefined);
        }
      } catch (e) {
        // strict-mode violation (getByRole hits multiple same-named elements) → fall back to the visible match's first()
        // (visible filtering guards against hidden-clone hijacking, same as the click fallback)
        if (e instanceof Error && /strict mode violation/.test(e.message)) {
          await fillLoc.filter({ visible: true }).first().fill(value, { timeout: 5000 });
          return;
        }
        throw e;
      }
      return;
    }
    case 'press': {
      // 2026-11-04: in-input key presses captured by the recorder (Enter submit etc.). Isomorphic with fill:
      // tryFirstMatch → bounded wait for the disabled state → strict violation fallback to visible first().
      // Not in DOM_FALLBACK_KINDS: a synthetic KeyboardEvent can't trigger the browser's native form submit, so fallback is unreliable.
      const pressLoc = await tryFirstMatch(page, root, action.locator, action.intentLocator, opts.hitSink, repairFor(opts, action));
      if (!(await waitTargetEnabled(page, pressLoc))) {
        throw new Error(`target-disabled: 目标等待 ${WAIT_TARGET_ENABLED_MS}ms 仍处禁用/加载态，无法按键`);
      }
      try {
        await pressLoc.press(action.key, { timeout: 5000 });
      } catch (e) {
        if (e instanceof Error && /strict mode violation/.test(e.message)) {
          await pressLoc.filter({ visible: true }).first().press(action.key, { timeout: 5000 });
          return;
        }
        throw e;
      }
      return;
    }
    case 'hover': {
      const hoverLoc = await tryFirstMatch(page, root, action.locator, undefined, opts.hitSink, repairFor(opts, action));
      try {
        await hoverLoc.hover({ timeout: 5000 });
      } catch (e) {
        // strict-mode violation (text/role hits multiple elements; common in recorded scenarios: repeated dates in tables, same-named links)
        // → fall back to the visible match's first(), consistent with the click/fill fallbacks (visible filtering guards against hidden-clone hijacking).
        if (e instanceof Error && /strict mode violation/.test(e.message)) {
          await hoverLoc.filter({ visible: true }).first().hover({ timeout: 5000 });
          return;
        }
        throw e;
      }
      return;
    }
    case 'waitFor': {
      // Empty locator = fixed-duration wait (waiting on no element), sleeping the full timeoutMs.
      if (!action.locator || action.locator.length === 0) {
        await page.waitForTimeout(action.timeoutMs ?? 5000);
        return;
      }
      // The locator value may be a dataset variable (text={{expectedError}}) — without substitution it waits on the literal template string and always times out.
      const { locator: waitLoc, missing: waitMissing } = substituteLocators(action.locator, vars);
      if (waitMissing.length > 0) {
        throw new Error(`var-missing: {{${waitMissing[0]!}}} (locator="${action.locator[0]?.value}")`);
      }
      // tryFirstMatch's count() is a single-frame probe: waitFor's semantics are「wait for the element to appear」,
      // so after a click/navigation when the element doesn't exist yet it must poll and retry; otherwise a single t=0 probe with count=0 fails immediately.
      const timeoutMs = action.timeoutMs ?? 5000;
      const deadline = Date.now() + timeoutMs;
      let lastErr: unknown;
      while (Date.now() < deadline) {
        try {
          const loc = await tryFirstMatch(page, root, waitLoc, action.intentLocator, opts.hitSink, repairFor(opts, action));
          await loc.waitFor({ state: 'visible', timeout: Math.max(100, deadline - Date.now()) });
          return;
        } catch (e) {
          lastErr = e;
          await page.waitForTimeout(200);
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(`waitFor timeout: ${waitLoc[0]?.value}`);
    }
    case 'assertVisible': {
      const { locator: assertLocArr, missing: assertMissing } = substituteLocators(action.locator, vars);
      if (assertMissing.length > 0) {
        throw new Error(`var-missing: {{${assertMissing[0]!}}} (locator="${action.locator[0]?.value}")`);
      }
      const assertLoc = await tryFirstMatch(page, root, assertLocArr, action.intentLocator, opts.hitSink, repairFor(opts, action));
      try {
        if (!(await assertLoc.isVisible({ timeout: 5000 }))) {
          throw new Error(`assertVisible failed: ${assertLocArr[0]?.value}`);
        }
      } catch (e) {
        // strict-mode violation (text/role hits multiple elements, e.g. same-named text in a table column header + the filter area)
        // → fall back to「any match visible」passing, consistent with the click/fill/hover fallbacks.
        // Note you can't just check first(): Element-UI fixed columns render hidden clones in .el-table__fixed,
        // and DOM-earlier matches may be visibility:hidden copies — must filter before judging.
        if (e instanceof Error && /strict mode violation/.test(e.message)) {
          if (!(await assertLoc.filter({ visible: true }).first().isVisible())) {
            throw new Error(`assertVisible failed: ${assertLocArr[0]?.value}`);
          }
          return;
        }
        throw e;
      }
      return;
    }
    case 'assertText': {
      const a = action as StepAction & { kind: 'assertText' };
      const { value, missing } = substituteVars(a.equals, vars);
      if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${a.equals}")`);
      // The locator value may carry a dataset variable (text={{expectedError}}) — without substitution the target element can't be found.
      const { locator: assertLocArr, missing: locMissing } = substituteLocators(a.locator, vars);
      if (locMissing.length > 0) {
        throw new Error(`var-missing: {{${locMissing[0]!}}} (locator="${a.locator[0]?.value}")`);
      }
      const actual = await resolveAssertTextActual(page, root, { ...a, locator: assertLocArr }, opts.hitSink, repairFor(opts, a));
      const ok = matchAssertText(actual, value, a.match ?? 'equals');
      if (!ok) {
        throw new Error(`assertText failed (${a.target ?? 'specifiedElement'}/${a.match ?? 'equals'}): expected ${JSON.stringify(value)}, actual ${JSON.stringify(actual.slice(0, 100))}`);
      }
      return;
    }
    case 'assertJson': {
      const { value: textTemplate, missing: missingJson } = substituteVars(
        JSON.stringify(action.equals ?? null),
        vars,
      );
      if (missingJson.length > 0) {
        throw new Error(`var-missing: {{${missingJson[0]!}}} (template="${JSON.stringify(action.equals).slice(0, 100)}")`);
      }
      const { locator: jsonLocArr, missing: jsonLocMissing } = substituteLocators(action.locator, vars);
      if (jsonLocMissing.length > 0) {
        throw new Error(`var-missing: {{${jsonLocMissing[0]!}}} (locator="${action.locator[0]?.value}")`);
      }
      const text = (await (await tryFirstMatch(page, root, jsonLocArr, action.intentLocator, opts.hitSink, repairFor(opts, action))).innerText({ timeout: 5000 })).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`assertJson: 元素文本不是合法 JSON: ${text.slice(0, 100)}`);
      }
      let expected: unknown;
      try {
        expected = JSON.parse(textTemplate);
      } catch {
        throw new Error(`assertJson: 变量替换后期望值不是合法 JSON: ${textTemplate.slice(0, 100)}`);
      }
      if (!deepEqual(parsed, expected)) {
        throw new Error(`assertJson 深比较失败: 实际 ${text.slice(0, 100)}`);
      }
      return;
    }
    case 'screenshot': {
      const { value, missing } = substituteVars(action.name, vars);
      if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.name}")`);
      await page.screenshot({ path: value || 'snap' });
      return;
    }
    case 'check': {
      const loc = await tryFirstMatch(page, root, action.locator, action.intentLocator, opts.hitSink, repairFor(opts, action));
      const current = await loc.isChecked({ timeout: 5000 });
      if (current !== action.checked) {
        if (action.checked) await loc.check({ timeout: 5000 });
        else await loc.uncheck({ timeout: 5000 });
      }
      return;
    }
    case 'select': {
      const { value, missing } = substituteVars(action.value, vars);
      if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.value}")`);
      const selectLoc = await tryFirstMatch(page, root, action.locator, action.intentLocator, opts.hitSink, repairFor(opts, action));
      if (!(await waitTargetEnabled(page, selectLoc))) {
        throw new Error(`target-disabled: 下拉框等待 ${WAIT_TARGET_ENABLED_MS}ms 仍处禁用/加载态，无法选择`);
      }
      await selectLoc.selectOption(value, { timeout: 5000 });
      return;
    }
    case 'upload': {
      const meta = opts.ctx.attachmentResolver
        ? await opts.ctx.attachmentResolver(action.fileId)
        : await defaultAttachmentResolver(action.fileId, opts.ctx.projectId);
      if (!meta) throw new Error(`attachment-missing: ${action.fileId}`);
      await (await tryFirstMatch(page, root, action.locator, action.intentLocator, opts.hitSink, repairFor(opts, action))).setInputFiles(meta.storedPath, { timeout: 5000 });
      return;
    }
    case 'switchTab': {
      let target = opts.ctx.tabMap?.get(action.tabRef);
      if (!target) {
        // Fuzzy-match fallback: when tabMap misses, take the last page in the context.
        try {
          const pages = page.context().pages();
          if (pages.length > 0) target = pages[pages.length - 1]!;
        } catch {
          // context unavailable (closed/test stub) → keep the tab-missing semantics
        }
        if (!target) throw new Error(`tab-missing: ${action.tabRef}`);
        opts.ctx.tabMap?.set(action.tabRef, target);
        await target.bringToFront();
        // Subsequent steps (incl. screenshots) all land on the switched-to page.
        opts.page = target;
        return 'tab-fuzzy-match';
      }
      await target.bringToFront();
      // Subsequent steps (incl. screenshots) all land on the switched-to page.
      opts.page = target;
      return;
    }
    case 'extract': {
      const loc = await tryFirstMatch(page, root, action.locator, action.intentLocator, opts.hitSink, repairFor(opts, action));
      let text: string;
      try {
        text = await loc.inputValue({ timeout: 5000 });
      } catch {
        text = await loc.innerText({ timeout: 5000 });
      }
      const raw = text.trim();
      let resolved = raw;
      if (action.mode === 'regex') {
        if (!action.pattern) throw new Error(`extract-missing: var=${action.varName} 未配置 pattern`);
        const re = new RegExp(action.pattern, 'g');
        const matches = [...raw.matchAll(re)];
        if (matches.length === 0) {
          throw new Error(`extract-missing: var=${action.varName} pattern=${action.pattern} 无匹配 (raw="${raw.slice(0, 100)}")`);
        }
        const group = action.group ?? 0;
        const m = matches[0]!;
        resolved = group === 0 ? (m[0] ?? '') : (m[group] ?? '');
      }
      // completeValue and smartExtract both use raw; smartExtract is compiled to regex but keeps the mode field for UI labeling
      vars[action.varName] = resolved;
      return;
    }
    case 'aiTask': {
      const { value, missing } = substituteVars(action.instruction, vars);
      // Credential placeholders don't come from dataset vars (substituteVars always reports {{ITEST_USERNAME}} missing):
      // missing credentials alone isn't a missing variable — valueSub substitutes the real value at action-execution time; a missing real variable is still judged dead as var-missing.
      const realMissing = missing.filter((m) => !referencesCredential(m));
      if (realMissing.length > 0) {
        throw new Error(`var-missing: {{${realMissing[0]!}}} (template="${action.instruction}")`);
      }
      const preErr = credentialPreflightError(value, opts.ctx);
      if (preErr) throw preErr;
      // Runtime action cache (automatic-solidify): cacheable = a DB step (UUID stepId) + a case-replay context
      // + non-captcha (every run must genuinely recognize) + an instruction with no dataset variables (cached values hold materialized data; cross-row reuse is always wrong).
      const cacheable = !!opts.caseId && !!opts.stepId && UUID_RE.test(opts.stepId)
        && !CAPTCHA_TASK_RE.test(action.instruction)
        && value === action.instruction;
      if (cacheable) {
        const cached = await readAiTaskCache(opts.stepId!, action.instruction);
        if (cached && cached.length > 0) {
          let cacheDiverged = false;
          try {
            // Cached actions go through the full dispatch: stability check / multi-candidate probing / DOM fallback / hitSink all take effect.
            for (const sub of cached) await dispatch(sub, opts);
            void bumpAiTaskCacheHit(opts.stepId!).catch(() => undefined);
            if (opts.cacheSink) opts.cacheSink.current = true;
            return `aiTask(缓存命中): ${cached.length} 个机械动作`;
          } catch {
            // Page diverged: silently fall back to an AI redo (self-heal); overwrite the cache on success.
            cacheDiverged = true;
          }
          if (cacheDiverged && opts.healedSink) opts.healedSink.current = true;
        }
      }
      const client = opts.ctx.llmClient ?? (await resolveLlmClient()).client;
      const collected: AiAction[] = [];
      const resourceManifest = renderWebResourceManifest({ envCtx: opts.ctx.envCtx });
      const aiOpts: { onAction: (a: AiAction, ok: boolean) => void; onUsage?: (r: AiUsageAddend) => void; valueSub?: (v: string) => string; resourceManifest?: string } = {
        onAction: (a, ok) => { if (ok) collected.push(a); },
      };
      if (opts.aiUsage) aiOpts.onUsage = (r) => opts.aiUsage!.add(r);
      // Credential capability granted on demand: valueSub / the resource manifest mount only when the instruction explicitly references a credential placeholder.
      // Unconditional mounting lets the AI see the placeholder form and actively refill the account/password boxes — negative cases (overlong/illegal accounts)
      // get "corrected" to the environment's real credentials and genuinely log in (2026-10-26 prod228 measured: with the credential section the AI outputs
      // fill __ITEST_USERNAME@web__; without it, only literals).
      if (referencesCredential(value)) {
        aiOpts.valueSub = aiCredentialSub(opts.ctx, await resolveStepSecretForAi(opts.ctx, opts.stepId, value));
        if (resourceManifest) aiOpts.resourceManifest = resourceManifest;
      }
      const summary = await runAiTask(opts.page, value, client, undefined, aiOpts);
      // Captcha-class instructions: register the multi-round verification context. If the submit (a later click step) is judged wrong/expired captcha by the system,
      // the executor automatically re-recognizes (the captcha is usually refreshed by the frontend after a failure) and resubmits, instead of failing the case outright.
      if (CAPTCHA_TASK_RE.test(value)) {
        opts.ctx.captchaRetry = { hint: action.intentLocator?.semanticRole ?? null, roundsLeft: CAPTCHA_RETRY_ROUNDS };
      }
      if (cacheable) {
        const mapped = mapAiActionsToCompiled(collected);
        if (mapped.ok) {
          void writeAiTaskCache(opts.stepId!, action.instruction, mapped.compiled).catch(() => undefined);
        }
      }
      return summary ? `aiTask: ${summary}` : undefined;
    }
    case 'sql': {
      // Queries the SUT's own database. dbRef absent = the environment's default db object.
      const envCtx = opts.ctx.envCtx;
      if (!envCtx) {
        const e = new Error('env-db-missing: 当前环境未配置数据库连接');
        e.name = 'EnvDbMissing';
        throw e;
      }
      const dbRef = action.dbRef ?? null;
      const pool = await envCtx.resolveDbPool(dbRef);
      const result = await runSql({
        pool,
        action,
        vars: opts.vars,
        dbRef: envCtx.resolveDb(dbRef)?.label ?? null,
      });
      // Bound parameter values may contain sensitive dataset column values; masked before landing in the report (the SQL text is placeholder-shaped and holds no plaintext itself).
      if (result.params && opts.ctx.sensitiveVarKeys?.length) {
        result.params = maskSqlParams(result.params, opts.vars, opts.ctx.sensitiveVarKeys);
      }
      // Write the sink before judging the assertion: the rows must still be visible in the report when the assertion fails
      if (opts.sqlSink) opts.sqlSink.current = result;
      if (result.assertion && !result.assertion.matched) {
        const e = new Error('sql assertion failed'); e.name = 'SqlAssertionFailed'; throw e;
      }
      return;
    }
    case 'observeLog': {
      const a = action as StepAction & { kind: 'observeLog' };
      const envCtx = opts.ctx.envCtx;
      // An explicit syslogRef miss is a hard error, never a silent fallback to the default — connecting to the wrong machine reads someone else's logs,
      // and a misjudged assertion is far harder to troubleshoot than an outright failure.
      const conn = envCtx?.resolveSyslog(a.syslogRef ?? null);
      if (!conn) {
        const ref = a.syslogRef ?? null;
        const available = envCtx?.syslogs.map((s) => s.label).join('、') || '(无)';
        // Empty ref and the default syslog exists but is incomplete → name it and state what's missing,
        // never say「未配置任何 syslog 对象」(no syslog objects configured) — that sentence contradicts the available list in the same message.
        const defaultIncomplete = !ref && (envCtx?.syslogs.length ?? 0) !== 0 && !envCtx?.syslog;
        const e = new Error(
          defaultIncomplete
            ? `env-syslog-missing: 环境「${envCtx?.envName ?? ''}」默认 syslog 对象配置不完整（需 host/user/filePath/凭据），可用:${available}`
            : `env-syslog-missing: ${ref
              ? `环境「${envCtx?.envName ?? ''}」不存在名为 ${ref} 的 syslog 对象，可用:${available}`
              : '当前环境未配置任何 syslog 对象'}`
        );
        e.name = 'EnvSyslogMissing';
        throw e;
      }
      const result = await runObserveLog({ env: conn, action: a, since: new Date() });
      if (result.assertion && !result.assertion.matched) {
        if (opts.logSink) opts.logSink.current = result;
        const e = new Error('observeLog assertion failed'); e.name = 'LogAssertionFailed'; throw e;
      }
      if (opts.logSink) opts.logSink.current = result;
      return;
    }
    case 'httpRequest': {
      const result = await runHttpRequest({ action, page: opts.page, vars: opts.vars });
      // Variables extracted via saveAs are written back to vars for later steps' {{var}} consumption
      if (result.saved) opts.vars[result.saved.varName] = result.saved.value;
      if (result.assertion && !result.assertion.matched) {
        // Write the result to the sink first so the caller still sees the request/response in step.result.http even when throwing
        if (opts.httpSink) opts.httpSink.current = result;
        const e = new Error('httpRequest assertion failed'); e.name = 'HttpRequestAssertionFailed'; throw e;
      }
      if (opts.httpSink) opts.httpSink.current = result;
      return;
    }
    case 'sendSyslog': {
      // UDP/TCP send (page-independent); failures (unreachable/timeout) propagate up to the unified failure path
      const result = await runSendSyslog({ action, vars: opts.vars });
      if (opts.syslogSink) opts.syslogSink.current = result;
      return;
    }
  }
}

/** Normalizes test_steps.assertion into a StepAction dispatch understands; invalid shapes return undefined meaning skip the assertion.
 *  Track 1: the「whole-page fuzzy text assertion」shape (target:'page' + match:'contains' + empty locator) is always skipped;
 *  descriptive assertions written by the AI ("登录表单正常展示" etc.) are exactly this shape, and after filtering, replay no longer fails on page innerText misses.
 *  Real element assertions (specifiedElement + non-empty locator) keep working. */
function normalizeStepAssertion(raw: unknown): StepAction | undefined {
  if (raw == null) return undefined;
  const migrated = migrateAssertion(raw);
  if (!migrated || typeof migrated !== 'object') return undefined;
  // Only assertText passes (the sole supported step-level assertion type); other kinds are treated as unset to keep error messages clean.
  if ((migrated as { kind?: string }).kind !== 'assertText') return undefined;
  const a = migrated as StepAction & { target?: string; match?: string; locator?: ReadonlyArray<unknown> };
  // Whole-page fuzzy text assertion → skip (the case-level expectedOutcome + vision is the final-state verdict)
  if (a.target === 'page' && (a.locator?.length ?? 0) === 0) return undefined;
  return migrated as StepAction;
}

/** Reverse-resolves a readable locator expression from the hit candidate kind (for report display). */
function locatorForCandidate(locator: Locator[], intent: IntentLocator | undefined, kind: string): string {
  if (kind === 'intent-testid' && intent?.semanticRole) return `[data-testid="${intent.semanticRole}"]`;
  if (kind === 'intent-text' && intent?.contextText) return `text=${intent.contextText}`;
  for (const l of locator) {
    if (kind === 'stable-css' && l.strategy === 'css') return l.value;
    if (kind === 'css' && l.strategy === 'css') return l.value;
    if (kind === 'xpath' && l.strategy === 'xpath') return l.value;
    if (kind === 'role' && l.strategy === 'role') return l.value;
    if (kind === 'text' && l.strategy === 'text') return l.value;
    if (kind === 'testId' && l.strategy === 'testId') return l.value;
  }
  return kind;
}

/** The locator shape as tryFirstMatch probes it: count() probes existence, filter({visible}) takes the visible subset. */
interface ProbeLocator {
  count?: () => Promise<number>;
  filter?: (opts: { visible: boolean }) => ProbeLocator;
}

/**
 * Tries locator candidates in order, three tiers; returns on the first success. Throws when all candidates fail.
 * Builds candidates via buildCandidates: intent.testid / contextText first, then stable #id CSS, finally XPath / other CSS.
 * Candidates probe via count() so later actions (e.g. click) don't throw; text/role paths may lack count() and succeed on acceptance.
 * On hit, writes the candidate's kind/value into hitSink (if provided) for the step result's hitLocator.
 */
async function tryFirstMatch(
  page: Page,
  root: Page | Frame,
  locator: Locator[],
  intentLocator?: IntentLocator,
  hitSink?: { current: HitLocator | null },
  repairLoc?: Locator | null,
): Promise<ReturnType<Page['locator']>> {
  // 2026-10-07: mobile-only locator strategies are marked unsupported in the web engine dispatcher,
  // guarding against misuse (e.g. a web case using accessibilityId, hitting an empty node and failing).
  // This guard runs before buildCandidates: buildCandidates is purely web-shaped; accepting a mobile-only strategy would wrongly generate css candidates,
  // so it throws right here. MobileEngine doesn't go through buildCandidates and is unaffected.
  for (const l of locator) {
    if (l.strategy === 'accessibilityId' || l.strategy === 'label' || l.strategy === 'predicate') {
      throw new Error(`locator strategy '${l.strategy}' is mobile-only; cannot run on web engine`);
    }
  }
  const cands = buildCandidates(root, { locator, intentLocator, repair: repairLoc });
  // hitSink display value: repair-cache candidates aren't in the author's locator array, so use their DSL value directly; reverse-lookup for the rest.
  const hitFor = (c: { kind: string; src?: string }): HitLocator => ({
    kind: c.kind,
    value: c.kind === 'repair-cache' ? (c.src ?? '') : locatorForCandidate(locator, intentLocator, c.kind),
  });
  if (cands.length === 0) {
    throw new Error('locator array is empty');
  }
  // 2026-10-10: candidate probing changed from "single candidate, one 150ms retry after count=0" to a bounded polling window —
  // the first round probes all candidates in order immediately; on a total miss it re-probes in rotation every 250ms, returning on any hit, up to 12 rounds (≈3s).
  // Root cause one (a11y lag; 150ms suffices): playwright's count() walks the a11y tree whose rebuild is lazy —
  //   after networkidle the DOM is rendered but the a11y tree may lag ~100-200ms (measured: the SOC login page turned to 1 after 150ms).
  // Root cause two (SPA mount lag; 150ms off by an order of magnitude): deep-link route mounting can keep running for seconds after networkidle —
  //   measured on the 8a178d83 replay: probing gave up on step-1 about 2s before the page finished mounting (the failure screenshot already showed a fully rendered page).
  // A round cap rather than a wall-clock deadline: the window semantics are fixed (12×250ms≈3s), and mocked waitForTimeout in tests
  // doesn't advance the wall clock, where a wall-clock deadline would spin forever. Probe exceptions are treated as that round's miss and flow into the next (transient errors can self-heal);
  // candidates without count() (e.g. the getByText path) keep being accepted directly.
  let lastErr: unknown;
  for (let round = 0; round < LOCATOR_PROBE_ROUNDS; round++) {
    if (round > 0) await page.waitForTimeout(LOCATOR_PROBE_INTERVAL_MS);
    for (const c of cands) {
      const probe = c.loc as unknown as ProbeLocator;
      if (!probe || typeof probe.count !== 'function') {
        // No count() (e.g. the getByText path): accept directly
        if (hitSink) hitSink.current = hitFor(c);
        await annotateAction(page, () => c.loc.boundingBox().catch(() => null));
        return c.loc;
      }
      const n = await probe.count().catch((e) => { lastErr = e; return -1; });
      if (n > 0) {
        // 2026-10-10 Fix C (visibility-aware probing): after a raw hit, a「visible」instance must exist before returning,
        // and the visible subset is handed to the subsequent action. Element-UI fixed columns/template clones make chained selectors resolve to
        // invisible copies; production saw two failure shapes:
        //  ① single match invisible → click has no coordinates to compute, throwing "Element is not visible" after ~1s (clone/import-export);
        //  ② force:true clicking the invisible copy "passes" but has no real effect, and later steps hit count=0 (查看/编辑).
        // Empty visible subset → treated as this round's miss; keep polling / move to the next candidate (a visible instance shows up next round under row re-render races);
        // visibility probe failure or a locator without filter() → keep the old behavior and return the original locator.
        const visibleLoc = probe.filter?.({ visible: true });
        const vn = visibleLoc && typeof visibleLoc.count === 'function'
          ? await visibleLoc.count().catch((e) => { lastErr = e; return -1; })
          : -1;
        if (vn === 0) {
          lastErr = new Error(`resolved ${n} match(es) but none visible (${c.kind})`);
          continue;
        }
        if (hitSink) hitSink.current = hitFor(c);
        const chosen = (vn > 0 ? visibleLoc! : c.loc) as ReturnType<Page['locator']>;
        await annotateAction(page, () => chosen.boundingBox().catch(() => null));
        return chosen;
      }
      if (n === 0) lastErr = new Error(`count=0 (${c.kind})`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('all locator candidates failed');
}

/** Resolves a single level of the frame chain: probes candidates one by one (count→elementHandle→contentFrame) and returns that iframe's Frame.
 *  Reuses buildCandidates for candidate construction (Frame and Page share signatures for locator/getBy*).
 *  FrameLocator is not used: it has no count()/evaluate, strict multi-matches only explode at action time, and it can't probe candidates one by one. */
async function resolveFrameLevel(root: Page | Frame, candidates: Locator[]): Promise<Frame | null> {
  const cands = buildCandidates(root, { locator: candidates });
  let lastErr: unknown;
  for (let round = 0; round < LOCATOR_PROBE_ROUNDS; round++) {
    if (round > 0) await root.waitForTimeout(LOCATOR_PROBE_INTERVAL_MS);
    for (const c of cands) {
      const n = await c.loc.count().catch((e) => { lastErr = e; return 0; });
      if (n <= 0) continue;
      const handle = await c.loc.first().elementHandle().catch(() => null);
      const frame = handle ? await handle.contentFrame().catch(() => null) : null;
      await handle?.dispose().catch(() => undefined);
      if (frame) return frame;
    }
  }
  if (lastErr) logger.debug({ err: lastErr }, 'resolveFrameLevel probe error');
  return null;
}

/** Resolves a step's iframe frame chain → the innermost Frame (returns the original page with no chain). Drills level by level; any level whose candidates all miss throws
 *  frame-unresolved — the frame chain is the recorder's deterministic description of the frame structure, so a miss means the page structure changed; fail outright rather than mis-target.
 *  Exported for unit tests (mock root injection). */
export async function resolveFrameRoot(page: Page, chain: FrameChain): Promise<Page | Frame> {
  let root: Page | Frame = page;
  for (let level = 0; level < chain.length; level++) {
    const frame = await resolveFrameLevel(root, chain[level]!.locator);
    if (!frame) {
      throw new Error(`frame-unresolved: 帧链第 ${level + 1}/${chain.length} 级候选全部落空（iframe 未挂载或结构已变）`);
    }
    root = frame;
  }
  return root;
}

/** resolveAssertTextActual: decides the actual string's source from action.target.
 *  root is used only by the specifiedElement branch (the Frame resolved from the frame chain); page/url/errorMessage are page-level semantics and always look at the top-level page. */
async function resolveAssertTextActual(
  page: Page,
  root: Page | Frame,
  action: StepAction & { kind: 'assertText' },
  hitSink?: { current: HitLocator | null },
  repairLoc?: Locator | null,
): Promise<string> {
  const target = action.target ?? 'specifiedElement';
  if (target === 'page') {
    return (await page.evaluate(() => (globalThis as { document?: { body?: { innerText?: string } } }).document?.body?.innerText ?? '')) as string;
  }
  if (target === 'url') {
    return page.url();
  }
  if (target === 'errorMessage') {
    const sel = ERROR_MESSAGE_SELECTORS.join(', ');
    const loc = page.locator(sel).first();
    await loc.waitFor({ state: 'visible', timeout: 5000 });
    return (await loc.innerText({ timeout: 5000 })).trim();
  }
  // specifiedElement (default)
  if (action.locator.length === 0) throw new Error('assertText: specifiedElement 模式需要 locator');
  const loc = await tryFirstMatch(page, root, action.locator, action.intentLocator, hitSink, repairLoc);
  return (await loc.innerText({ timeout: 5000 })).trim();
}

/** matchAssertText: assertion matching rules (equals/contains/notContains/regex). */
function matchAssertText(actual: string, expected: string, match: 'equals' | 'contains' | 'notContains' | 'regex'): boolean {
  switch (match) {
    case 'equals': return actual.trim() === expected.trim();
    case 'contains': return actual.includes(expected);
    case 'notContains': return !actual.includes(expected);
    case 'regex': return new RegExp(expected).test(actual);
  }
}

/** Multi-round captcha verification: when a captcha-failure notice appears after the submit (click), re-recognize and resubmit.
 *  Covers both real failure modes: LLM recognition errors and expired captchas — most systems refresh the captcha on the frontend after a failed login,
 *  so recognizing the current image and retrying suffices. Failure notice persisting after the rounds are exhausted → throw, failing the step. Returns warning text. */
async function runCaptchaRetry(opts: DispatchOpts, clickActions: StepAction[]): Promise<string | undefined> {
  const pending = opts.ctx.captchaRetry;
  if (!pending) return undefined;
  const client = opts.ctx.llmClient ?? (await resolveLlmClient()).client;
  const notes: string[] = [];
  try {
    while (pending.roundsLeft > 0) {
      // Leaves time for the login API round-trip and the error notice to render
      await opts.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
      await opts.page.waitForTimeout(600);
      const onUsage = opts.aiUsage ? (r: AiUsageAddend) => opts.aiUsage!.add(r) : undefined;
      if (!(await isCaptchaFailed(opts.page, client, onUsage))) break;
      pending.roundsLeft--;
      const round = CAPTCHA_RETRY_ROUNDS - pending.roundsLeft;
      // Fast path: one vision call (~10s, racing the TTL); on mechanical failure falls back to the generic multi-turn loop.
      const solved = await solveCaptchaOnce(opts.page, client, pending.hint, onUsage).catch(() => null)
        ?? await runAiTask(opts.page, '识别当前验证码图片中的字符并填入验证码输入框', client, undefined, onUsage ? { onUsage } : undefined).catch(() => null);
      if (!solved) {
        notes.push(`第 ${round} 轮：识别失败`);
        break;
      }
      notes.push(`第 ${round} 轮：${solved}`);
      for (const a of clickActions) {
        await dispatch(a, opts);
      }
    }
    if (pending.roundsLeft <= 0) {
      await opts.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
      await opts.page.waitForTimeout(600);
      const onUsage = opts.aiUsage ? (r: AiUsageAddend) => opts.aiUsage!.add(r) : undefined;
      if (await isCaptchaFailed(opts.page, client, onUsage)) {
        throw new Error('验证码多轮重试后仍校验失败（识别错误或验证码已过期）');
      }
    }
  } finally {
    opts.ctx.captchaRetry = null;
  }
  return notes.length > 0 ? `验证码重试：${notes.join('；')}` : undefined;
}

export async function writeStepScreenshot(reportId: string, stepIndex: number, page: Page): Promise<string | undefined> {
  try {
    // Screenshotting right after a navigate/click-triggered navigation captures a white screen (SPAs render only after domcontentloaded).
    // Wait for networkidle first to let rendering land; with a 2s fallback so long-connection pages that never idle don't block the screenshot.
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined);
    const dir = join(SCREENSHOTS_DIR, reportId);
    await mkdir(dir, { recursive: true });
    const filename = `step-${stepIndex}.png`;
    await page.screenshot({ path: join(dir, filename), fullPage: false });
    return `/screenshots/${reportId}/${filename}`;
  } catch (e) {
    logger.warn({ err: e, reportId, stepIndex }, 'failed to capture step screenshot');
    return undefined;
  }
}

/** Mechanically captures a page-text snapshot after each step (process evidence): the case-level vision verdict takes its final screenshot only after the page settles,
 *  by which time short-lived notices like toasts have already unmounted from the DOM — the text must be gathered by deterministic code within its living window.
 *  Captured at the same moment as the step screenshot (after writeStepScreenshot). Whitespace collapsing + truncation bound the verdict's token cost;
 *  pure read, best-effort; returns null on failure without affecting the step. */
export async function capturePageTextSnapshot(page: Page): Promise<string | null> {
  try {
    const raw = await page.evaluate(() => document.body?.innerText ?? '');
    const t = raw.replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 2000) : null;
  } catch {
    return null;
  }
}

/** Report-side masking: replaces every occurrence of sensitive variable values in text with ******.
 *  Uses split/join rather than RegExp to avoid values containing regex metacharacters;
 *  substitutes in descending value-length order so a short value that's a substring of a longer one leaves no residue. */
export function maskSensitiveValues(text: string, vars: Record<string, string>, keys: readonly string[]): string {
  const vals = keys
    .map((k) => vars[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of vals) out = out.split(v).join('******');
  return out;
}

/** Report-side masking: SQL bound parameter values may contain sensitive dataset column values (e.g. looking up a user by password).
 *  The SQL text itself is placeholder-shaped ($n / ?) with no plaintext; only the values inside params need masking. */
function maskSqlParams(params: unknown[], vars: Record<string, string>, keys: readonly string[]): unknown[] {
  if (keys.length === 0) return params;
  return params.map((p) =>
    typeof p === 'string' ? maskSensitiveValues(p, vars, keys) : p,
  );
}

/** Row-level expectation materialization: the expectedOutcome template is substituted with the run's final vars (dataset initial variables + extract) before the vision verdict.
 *  missing keeps the literal — the vision verdict likely won't match → the row fails with a visible reason in the report; an honest failure beats a silent skip. */
export function materializeExpectedOutcome(text: string, vars: Record<string, string>): string {
  return substituteVars(text, vars).value;
}

/** URL normalization for deep-link landing checks: origin+path lowercased, trailing slash stripped, search stripped, hash kept (qiankun routing may live in the hash).
 *  Only http(s) is normalized; non-http shapes like about:blank return as-is (new URL('about:blank') doesn't throw and its origin is the string "null"). */
export function normalizeUrlForLandedCheck(raw: string): string {
  if (!/^https?:\/\//i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    return `${u.origin.toLowerCase()}${u.pathname.replace(/\/+$/, '').toLowerCase()}${u.hash}`;
  } catch {
    return raw;
  }
}

/** Page「has substantive content」probe: body exists and (has visible text or interactive/media elements have appeared). On slow SPA cold starts
 *  the body can still be an empty shell after domcontentloaded + networkidle (networkidle falsely releases early in the quiet window of「HTML arrived, XHR not yet fired」)
 *  — prod228 report 02c812ea: after init-goto the whole page was blank and step 1's locator hit count=0 within its 3s budget. Bounded polling
 *  (deadline + maxIters double insurance, same pattern as waitForPageSettled: mocked wall clocks in unit tests don't advance, so an iteration cap is needed);
 *  when the probe is unusable (evaluate missing/throwing), give up waiting immediately — never worse than not waiting. */
async function waitForPageSubstance(page: Page, timeoutMs = 8000, pollMs = 250): Promise<boolean> {
  const hasSubstance = async (): Promise<boolean | null> => {
    try {
      return await page.evaluate(() => {
        const b = document.body;
        if (!b) return false;
        if ((b.innerText ?? '').trim().length > 0) return true;
        return !!document.querySelector('button, input, select, textarea, a, img, canvas, [role="button"]');
      });
    } catch {
      return null;
    }
  };
  const deadline = Date.now() + timeoutMs;
  const maxIters = Math.max(2, Math.ceil(timeoutMs / Math.max(1, pollMs)) + 5);
  for (let iter = 0; iter < maxIters && Date.now() < deadline; iter++) {
    const r = await hasSubstance();
    if (r === null) return false; // unprobeable (evaluate missing/throwing) → don't wait
    if (r) return true;
    await page.waitForTimeout(pollMs).catch(() => undefined);
  }
  return false;
}

/** init goto + landed-check retry: an SPA cold-start deep link may be bounced back to the home page by the frontend's static fallback route (prod228 SOC
 *  permission.js route-guard race; 2026-10-27 record: 1 of 6 runs was bounced). When goto succeeds but the final URL
 *  differs from the target, retry once — resources are cached and the shell starts faster, usually winning the route-guard race. Still unlanded
 *  doesn't block (returns landed=false for the upper layer to continue under existing semantics); goto's own throw semantics are identical to a bare goto. */
export async function gotoWithLandedRetry(
  page: Page,
  targetUrl: string,
): Promise<{ landed: boolean; finalUrl: string }> {
  const target = normalizeUrlForLandedCheck(targetUrl);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // SPA readiness wait (same semantics as the existing init-goto): Vue/React still mounts asynchronously after domcontentloaded.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    const finalUrl = page.url();
    if (normalizeUrlForLandedCheck(finalUrl) === target) {
      // The URL has landed but the SPA may still be starting (empty-shell body) — boundedly wait for content before releasing later steps; a timeout only
      // warns without blocking and doesn't trigger a second goto (reloading an SPA only pushes its startup further out).
      if (!(await waitForPageSubstance(page))) {
        logger.warn({ targetUrl }, 'init goto 已落地但页面内容探针超时(可能仍在启动),继续执行');
      }
      return { landed: true, finalUrl };
    }
  }
  return { landed: false, finalUrl: page.url() };
}

/** Runs case steps inside an already-held browser context: init-goto → preflight → step loop → vision fallback.
 *  Shares core logic with `executeCaseReal`; the difference is it doesn't own launch/newContext/close — the caller holds the lifecycle. */
async function runStepsInContext(
  caseId: string,
  steps: Array<{
    order: number;
    assertion?: unknown;
    delayMs?: number | null;
    id?: string;
    tabRef?: string | null;
    componentKind?: string | null;
    sensitive?: boolean | null;
    /** Executable DSL array; the sole replay source. Empty array/null = not compiled, throws compile-missing. */
    compiled?: unknown[] | null;
    /** Row-level natural-language instruction; replay reads it only for AI fallback, mechanical replay never does. */
    instruction?: string | null;
  }>,
  ctx: ExecContext,
  context: BrowserContext,
  targetUrl?: string,
  onPreflight?: (report: PreflightReport) => void,
  caseWindow?: CaseWindow,
  /** Per-step callback (after passed/failed) — the caller persists incrementally; the report page polls and sees results step by step. */
  onStep?: (r: ExecStepResult) => void,
  /** Stop-on-failure hook (verify_case): fired before the failure break with the failed step index and the current page; hook throws are ignored. */
  onFailurePage?: (page: Page, failedIndex: number) => Promise<void>,
): Promise<ExecStepResult[]> {
  const results: ExecStepResult[] = [];
  const vars: Record<string, string> = { ...(ctx.initialVars ?? {}) };
  const page = await context.newPage();
  // Playground live view follows: switch to this page (both switchTab switches and per-case new pages pass through here).
  ctx.liveView?.setPage(page);
  // Page-ready notification (the verify_case resume path uses it to get back the page created by mechanical replay).
  ctx.onPageReady?.(page);
  // Browser console error / pageerror capture: one subscription; each step-result construction point drains its slice for attribution
  // (frontend JS errors are first-hand attribution evidence for "click had no effect / white screen" class failures).
  const consoleCapture = createConsoleCapture(page);
  // Initial navigation: the case-level init URL (targetUrl) always gets one goto first.
  // If the first step is also a navigate with the same URL as init, let the step do it to avoid a duplicate load.
  const firstCompiled = steps[0]?.compiled;
  const firstStepKind = (Array.isArray(firstCompiled) && firstCompiled.length > 0
    ? (firstCompiled[0] as { kind?: string } | undefined)?.kind
    : undefined);
  const firstStepIsSameNav =
    steps.length > 0
    && firstStepKind === 'navigate'
    && (() => {
        const u = (Array.isArray(firstCompiled) && firstCompiled.length > 0
          ? (firstCompiled[0] as { url?: string }).url
          : undefined);
        return typeof u === 'string' && u === targetUrl;
      })();
  let initLanded = false;
  if (targetUrl && !firstStepIsSameNav) {
    // goto + landed-check retry (an SPA deep-link cold start may be bounced back to the home page by the frontend's fallback route; one retry usually wins the race;
    // wait semantics and comments in gotoWithLandedRetry). Still unlanded doesn't block — the failure-page evidence exposes the real location.
    const landed = await gotoWithLandedRetry(page, targetUrl);
    initLanded = landed.landed;
    if (!landed.landed) {
      logger.warn({ caseId, targetUrl, finalUrl: landed.finalUrl }, 'init goto 未落到目标页(深链被重定向),继续执行');
    }
  }
  // preflight: pre-execution checks (URL reachable / login state / tabs / origin). Failures don't block execution.
  // skipNavigate=init already landed: preflight's second goto equals a full-page reload with no settle wait, throwing a slow SPA back
  // into its startup phase (prod228 02c812ea blank-first-step root cause) — already on the page, so only check, never navigate again.
  try {
    const report = await preflight(page, { url: targetUrl ?? null, title: '' }, { skipNavigate: initLanded });
    onPreflight?.(report);
  } catch (e) {
    logger.warn({ err: e, caseId }, 'preflight failed; continuing');
  }
  const opts: DispatchOpts = { page, vars, ctx, caseId };
  // Process evidence collection: after each passed step, capture a page-text snapshot (same moment as the step screenshot) so the case-level vision verdict
  // can identify transient notices (toasts) already gone from the final screenshot. Not captured on the failure path — the vision verdict doesn't run after a failure.
  const pageTextSnaps: string[] = [];
  // Mechanical-failure AI redo switch (global setting; runCase injects ctx.aiFallback; default off = a failure is a failure).
  // compile-missing is no longer governed by it: NL vision steps (empty compiled + an instruction) are official execution semantics, unconditionally AI-executed on the spot.
  const fallback = ctx.aiFallback ?? { locatorFailed: false };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const started = Date.now();
    // Plan-run abort checkpoint: probes the cancel flag before each step (in-memory fast path + DB fallback).
    // On hit, this step is recorded as a Cancelled failure and later steps stop — the report finalizes as failed immediately,
    // and plan_run marks the remaining cases skipped, converging the whole run to cancelled.
    if (ctx.shouldAbort && await ctx.shouldAbort()) {
      const cancelledConsole = consoleCapture.drain();
      const cancelled: ExecStepResult = {
        order: step.order,
        status: 'failed',
        durationMs: Date.now() - started,
        startedAt: new Date(started).toISOString(),
        error: 'cancelled',
        failureReason: 'Cancelled',
        humanMessage: '计划运行已终止，本步及后续步骤不再执行',
        ...(cancelledConsole.length ? { console: cancelledConsole } : {}),
      };
      results.push(cancelled);
      onStep?.(cancelled);
      break;
    }
    opts.stepId = step.id;
    opts.hitSink = { current: null };
    opts.sqlSink = { current: null };
    opts.logSink = { current: null };
    opts.httpSink = { current: null };
    opts.syslogSink = { current: null };
    opts.cacheSink = { current: false };
    const aiUsage = newAiUsage();
    opts.aiUsage = aiUsage;
    opts.healedSink = { current: false };
    // Repair memory: when this step has a cached repair locator (written on AI-fallback success), inject it at the candidate-chain tail if the kind matches.
    opts.repairLocator = { current: step.id ? await readLocatorCache(step.id) : null };
    // AI-fallback failure reason (written jointly at the compileMissing / locatorFailed sites; shown in the failed result's warning);
    // the "compileMissing already tried AI" marker — locatorFailed doesn't re-run the same instruction after that failure
    // (2026-10-21 prod228 measured one instruction double-AI spinning 12+ calls).
    let aiDegradedErr: string | undefined;
    let aiTriedInCompileFallback = false;
    const tabIndex =
      ctx.tabMap && step.tabRef ? Array.from(ctx.tabMap.keys()).indexOf(step.tabRef) : 0;
    const assertionAction = normalizeStepAssertion(step.assertion);
    // Explicit trail for skipped step-level assertions: normalizeStepAssertion only admits element-level assertText; whole-page fuzzy
    // text assertions (exactly the shape the AI's descriptive assertions take) used to be silently skipped — the report couldn't show
    // "this step actually never asserted". An advisory warning doesn't affect pass judgment; the final state is still ruled by the case-level expectedOutcome vision verdict.
    const skippedAssertionWarn = step.assertion != null && !assertionAction
      ? '步骤级断言未执行：整页模糊文本断言不参与逐步判定，终态由用例级预期结果（expectedOutcome）判定裁决'
      : undefined;
    try {
      if (step.delayMs) await opts.page.waitForTimeout(step.delayMs);
      // The dispatcher's sole replay path: dispatch atomic actions per the compiled array.
      // 1) compiled is a non-empty array → dispatch one by one, collecting warnings
      // 2) compiled is an empty array / null / undefined → not compiled, throws compile-missing
      let warning: string | undefined;
      let degraded = false;
      const compiled = (step as { compiled?: unknown }).compiled;
      if (Array.isArray(compiled) && compiled.length > 0) {
        for (const sub of compiled as StepAction[]) {
          const w = await dispatch(sub, opts);
          if (w && !warning) warning = w;
        }
      } else {
        // Vision-mode execution: empty compiled + a row-level instruction → the AI executes the instruction on the spot (the official execution
        // semantics of vision steps; solidify optional — the creation flow produces NL steps by default). Success keeps a warning and passes as usual; failure keeps the original
        // compile-missing semantics (no LLM / undefined variables in the instruction / the AI giving up all land here).
        const inst = step.instruction?.trim();
        if (inst) {
          const { value: instResolved, missing } = substituteVars(inst, vars);
          // Credential placeholders don't come from dataset vars (substituteVars always reports missing): missing credentials alone isn't a missing variable.
          if (missing.every((m) => referencesCredential(m))) {
            aiTriedInCompileFallback = true;
            const preErr = credentialPreflightError(instResolved, ctx);
            if (preErr) throw preErr;
            try {
              const client = ctx.llmClient ?? (await resolveLlmClient()).client;
              // Credential capability granted on demand (same gate as the compiled aiTask step): valueSub / the resource manifest mount only when the instruction
              // explicitly references a credential placeholder; otherwise the prompt never shows the credential form, and the AI won't grab environment credentials
              // to refill the account/password boxes (negative cases would be "corrected" to real credentials and genuinely log in).
              const credRef = referencesCredential(instResolved);
              const summary = await runAiTask(opts.page, instResolved, client, undefined, {
                onUsage: (r) => aiUsage.add(r),
                ...(ctx.shouldAbort ? { shouldAbort: ctx.shouldAbort } : {}),
                // A pure natural-language step has no mechanical semantics to reference, but the "observe, don't manufacture" rule still applies:
                // when the instruction asks to "observe a phenomenon", the AI must not fill values/resubmit to induce it.
                degradeContext: buildDegradeContext({ compiled: null }),
                ...(credRef
                  ? {
                      valueSub: aiCredentialSub(ctx, await resolveStepSecretForAi(ctx, opts.stepId, instResolved)),
                      resourceManifest: renderWebResourceManifest({ envCtx: ctx.envCtx }),
                    }
                  : {}),
              });
              degraded = true;
              warning = `未编译，AI 按指令临场执行${summary ? `：${summary}` : ''}`;
            } catch (e) {
              // Missing credentials is an environment-level hard error: rethrow (the classifier files it under EnvMissing/SecretMissing) instead of swallowing it as compile-missing;
              // other AI failures keep the original compile-missing semantics, but the reason is recorded for the failed warning display.
              if (e instanceof Error && (e.name === 'EnvMissing' || e.name === 'SecretMissing')) throw e;
              aiDegradedErr = e instanceof Error ? e.message : String(e);
            }
          }
        }
        if (!warning) {
          throw new Error(`compile-missing: 第 ${step.order} 步未编译,请点击「AI 编译」生成 DSL`);
        }
      }
      // The step-level assertion runs only after the actions pass; an assertion failure is likewise recorded failed and stops the rest.
      if (assertionAction) {
        await dispatch(assertionAction, opts);
      }
      // Multi-round captcha verification: when this step contains a click (submit) and a captcha aiTask step registered earlier, retry on page failure signals.
      if (ctx.captchaRetry) {
        const clickActions = (compiled as StepAction[]).filter((a) => a.kind === 'click');
        if (clickActions.length > 0) {
          const retryWarning = await runCaptchaRetry(opts, clickActions);
          if (retryWarning) warning = warning ? `${warning}; ${retryWarning}` : retryWarning;
        }
      }
      // Repair-memory hit trail: hitLocator already shows the repair-cache candidate; add a warning note + a hit counter.
      // degraded/healed stay unset — a purely mechanical hit doesn't enter the dual pass-rate accounting.
      if (opts.hitSink.current?.kind === 'repair-cache') {
        warning = `${warning ? `${warning}；` : ''}locator 修复缓存命中：${opts.hitSink.current.value}`;
        if (opts.stepId && UUID_RE.test(opts.stepId)) void bumpLocatorCacheHit(opts.stepId).catch(() => undefined);
      }
      const screenshot = await writeStepScreenshot(ctx.reportId, i + 1, opts.page);
      const pageTextSnap = await capturePageTextSnapshot(opts.page);
      if (pageTextSnap) pageTextSnaps.push(pageTextSnap);
      const passedConsole = consoleCapture.drain();
      const passedResult: ExecStepResult = {
        order: step.order,
        status: 'passed',
        durationMs: Date.now() - started,
        startedAt: new Date(started).toISOString(),
        instruction: step.instruction ?? undefined,
        compiled: Array.isArray(step.compiled) ? step.compiled : undefined,
        warning: [warning, skippedAssertionWarn].filter(Boolean).join('；') || undefined,
        screenshot,
        hitLocator: opts.hitSink.current ?? undefined,
        tabIndex: tabIndex >= 0 ? tabIndex : 0,
        sql: opts.sqlSink.current ?? undefined,
        log: opts.logSink.current ?? undefined,
        http: opts.httpSink.current ?? undefined,
        syslog: opts.syslogSink.current ?? undefined,
        ...(opts.cacheSink.current ? { cached: true } : {}),
        ...(aiUsage.stat.calls > 0 ? { aiUsage: aiUsage.stat } : {}),
        ...(opts.healedSink.current ? { healed: true } : {}),
        ...(degraded ? { degraded: true } : {}),
        ...(passedConsole.length ? { console: passedConsole } : {}),
      };
      results.push(passedResult);
      onStep?.(passedResult);
    } catch (e) {
      const durationMs = Date.now() - started;
      const screenshot = await writeStepScreenshot(ctx.reportId, i + 1, opts.page);
      // On assertion failure, classify should receive the assertion's shape (should the classifier care about action.kind);
      // feeding the actually-run action as the classification input is more accurate — whether it failed on an action or the assertion is obvious at a glance.
      // The classification input takes compiled[0] (empty when not compiled; classify walks the default branch on an empty kind).
      const compiledForClassify = (step as { compiled?: unknown }).compiled;
      const firstCompiledAction = (Array.isArray(compiledForClassify) && compiledForClassify.length > 0
        ? (compiledForClassify[0] as StepAction)
        : undefined);
      const failedAction = (assertionAction ?? firstCompiledAction);
      // Dataset sensitive-column masking: error messages like assertText carry materialized expected values ({{password}} plaintext);
      // classify/humanMessage may reuse e.message — mask uniformly before landing in the report (non-Error throws are String-ified then masked too), closing the loop on column-level encryption.
      let rawMsg = e instanceof Error ? e.message : String(e);
      if (ctx.sensitiveVarKeys && ctx.sensitiveVarKeys.length > 0) {
        rawMsg = maskSensitiveValues(rawMsg, vars, ctx.sensitiveVarKeys);
        if (e instanceof Error) e.message = rawMsg;
      }
      const classified = classify(e, { action: failedAction, durationMs });
      // AI fallback (optional): mechanical execution failed (any failure reason) + global switch on + a row-level instruction → the AI redoes the whole step per the instruction.
      // Success → step passed + warning note (healed stays unset, keeping the dual pass-rate accounting unpolluted); failure keeps the original failedResult.
      // An aiTask step is already running the AI — on failure, “execute per the instruction on the spot” adds nothing → never fall back, keep the original failure.
      // compileMissing already tried the AI on the same instruction (aiTriedInCompileFallback), or the original failure is itself a credential miss
      // (EnvMissing/SecretMissing — running the AI again only hits the same wall) → likewise no fallback.
      const inst = step.instruction?.trim();
      if (
        fallback.locatorFailed
        && inst
        && failedAction?.kind !== 'aiTask'
        // Non-browser steps (HTTP / DB / syslog) never fall back: the AI can only drive the browser and structurally cannot complete them.
        // Example: the httpRequest Host-header injection probe — browsers forbid scripts from setting protected headers, so the AI inevitably gives up
        // (prod228 report 15dd42d9 burned 44.5s / 1 call for zero gain).
        && !NON_BROWSER_KINDS.has(failedAction?.kind as string)
        && !aiTriedInCompileFallback
        && !(e instanceof Error && (e.name === 'EnvMissing' || e.name === 'SecretMissing'))
      ) {
        const { value: instResolved, missing } = substituteVars(inst, vars);
        // Repair-memory cacheability check (same semantics as the aiTask runtime-cache gate):
        // instruction interpolation being a no-op = no dataset variables (different rows mean different page states; a materialized selector is always wrong cross-row);
        // the captcha exemption aligns with the aiTask cache; the target action must carry a locator (navigate and friends have none to repair).
        const repairCacheable = !!opts.caseId && !!opts.stepId && UUID_RE.test(opts.stepId)
          && instResolved === inst
          && !CAPTCHA_TASK_RE.test(inst)
          && !!firstCompiledAction
          && Array.isArray((firstCompiledAction as { locator?: unknown }).locator)
          && ((firstCompiledAction as { locator?: unknown[] }).locator?.length ?? 0) > 0;
        // Credential placeholders don't come from dataset vars: missing credentials alone isn't a missing variable (values are substituted by valueSub at execution time).
        if (missing.every((m) => referencesCredential(m))) {
          const preErr = credentialPreflightError(instResolved, ctx);
          if (preErr) {
            aiDegradedErr = preErr.message;
          } else {
            let aiSummary: string | undefined;
            // Collect the AI redo's successful actions: after fallback success, parse the target element selector from them to write the repair cache (self-heal protocol).
            const collected: AiAction[] = [];
            try {
              const client = ctx.llmClient ?? (await resolveLlmClient()).client;
              // Credential capability granted on demand (same gate as the compiled aiTask step): valueSub / the resource manifest mount only when the instruction
              // explicitly references a credential placeholder; otherwise the prompt never shows the credential form, and the AI won't grab environment credentials
              // to refill the account/password boxes (negative cases would be "corrected" to real credentials and genuinely log in).
              const credRef = referencesCredential(instResolved);
              aiSummary = (await runAiTask(opts.page, instResolved, client, undefined, {
                onAction: (a, ok) => { if (ok) collected.push(a); },
                onUsage: (r) => aiUsage.add(r),
                ...(ctx.shouldAbort ? { shouldAbort: ctx.shouldAbort } : {}),
                // Tell the AI both the mechanical semantics and the mechanical failure reason: the fallback path used to pass only the natural-language instruction,
                // so the AI neither knew "this step meant waiting 10s for some text" nor "the mechanical run had already confirmed it never appears",
                // and would fabricate data to produce the expected phenomenon (2026-10-26 prod228 measured: filling a fabricated wrong captcha
                // + resubmitting, the negative case false-passed).
                degradeContext: buildDegradeContext({
                  compiled: compiledForClassify,
                  failedAction,
                  mechanicalError: rawMsg,
                }),
                ...(credRef
                  ? {
                      valueSub: aiCredentialSub(ctx, await resolveStepSecretForAi(ctx, opts.stepId, instResolved)),
                      resourceManifest: renderWebResourceManifest({ envCtx: ctx.envCtx }),
                    }
                  : {}),
              })) || undefined;
            } catch (err) {
              // AI unavailable/gave up/turn-exhausted → keep the original failure (flows to failedResult below), but record the reason for the warning display
              aiDegradedErr = err instanceof Error ? err.message : String(err);
            }
            if (aiSummary !== undefined) {
              // Repair-memory write: pick the target element selector from the AI's successful actions (same kind first, otherwise the first
              // click/fill carrying a selector), sanitize it with mapSelectorStrict (rejecting proprietary syntax/active-state classes/bare tags),
              // then persist it to step_locator_cache by stepId; fire-and-forget — a failure doesn't affect this step's result.
              if (repairCacheable) {
                const kind = firstCompiledAction!.kind;
                const withSelector = (a: AiAction): a is AiAction & { selector: string } =>
                  (a.type === 'click' || a.type === 'fill') && typeof a.selector === 'string' && a.selector.length > 0;
                const targetable = collected.filter(withSelector);
                const pick = targetable.find((a) => a.type === kind) ?? targetable[0];
                const loc = pick ? mapSelectorStrict(pick.selector) : null;
                if (loc) void writeLocatorCache(opts.stepId!, loc, kind).catch(() => undefined);
              }
              const aiScreenshot = await writeStepScreenshot(ctx.reportId, i + 1, opts.page);
              const aiTextSnap = await capturePageTextSnapshot(opts.page);
              if (aiTextSnap) pageTextSnaps.push(aiTextSnap);
              const aiConsole = consoleCapture.drain();
              const aiPassed: ExecStepResult = {
                order: step.order,
                status: 'passed',
                durationMs: Date.now() - started,
                startedAt: new Date(started).toISOString(),
                instruction: step.instruction ?? undefined,
                compiled: Array.isArray(step.compiled) ? step.compiled : undefined,
                // The original mechanical failure reason (e.g. count=0 (css #gone)) goes into the warning too; the report page can see “how far recognition got before failing”.
                warning: `机械执行失败（${rawMsg}），AI 按指令重做本步${aiSummary ? `：${aiSummary}` : ''}`,
                screenshot: aiScreenshot,
                hitLocator: opts.hitSink.current ?? undefined,
                tabIndex: tabIndex >= 0 ? tabIndex : 0,
                        sql: opts.sqlSink.current ?? undefined,
                log: opts.logSink.current ?? undefined,
                http: opts.httpSink.current ?? undefined,
                syslog: opts.syslogSink.current ?? undefined,
                ...(aiUsage.stat.calls > 0 ? { aiUsage: aiUsage.stat } : {}),
                degraded: true,
                ...(aiConsole.length ? { console: aiConsole } : {}),
              };
              results.push(aiPassed);
              onStep?.(aiPassed);
              continue; // this step passed via fallback, jump to the next step (no break / onFailurePage)
            }
          }
        }
      }
      const failedConsole = consoleCapture.drain();
      const failedResult: ExecStepResult = {
        order: step.order,
        status: 'failed',
        durationMs,
        startedAt: new Date(started).toISOString(),
        instruction: step.instruction ?? undefined,
        compiled: Array.isArray(step.compiled) ? step.compiled : undefined,
        error: rawMsg,
        screenshot,
        failureReason: classified.reason,
        humanMessage: classified.humanMessage,
        hitLocator: opts.hitSink.current ?? undefined,
        tabIndex: tabIndex >= 0 ? tabIndex : 0,
        sql: opts.sqlSink.current ?? undefined,
        log: opts.logSink.current ?? undefined,
        http: opts.httpSink.current ?? undefined,
        syslog: opts.syslogSink.current ?? undefined,
        // AI fallback ran but failed (gave up/turn-exhausted/exception): append a warning noting the AI attempt's outcome,
        // otherwise the report keeps only the mechanical error + an orphan aiUsage, hiding that the AI intervened but couldn't save it.
        ...(aiDegradedErr ? { warning: `AI 降级尝试未成功：${aiDegradedErr}` } : {}),
        ...(aiUsage.stat.calls > 0 ? { aiUsage: aiUsage.stat } : {}),
        ...(failedConsole.length ? { console: failedConsole } : {}),
      };
      results.push(failedResult);
      onStep?.(failedResult);
      if (onFailurePage) await onFailurePage(opts.page, i).catch(() => undefined);
      // Terminate immediately on failure so later steps aren't scrambled by the failed step's polluted page state.
      break;
    }
  }
  // Track 1: case-level vision verdict. Runs only after all step.actions pass; uses the final screenshot.
  // If a step already failed, vision doesn't override (avoiding a vision misjudgment whitewashing a real failure).
  const failedSoFar = results.some((r) => r.status === 'failed');
  if (!failedSoFar && ctx.expectedOutcome && ctx.expectedOutcome.trim()) {
    // Process evidence: transient notices (toasts) are necessarily gone by the settled final screenshot, so two more evidence channels —
    // the last step's screenshot (taken right after the action finished, while short-lived notices are still alive) + the last few steps' text snapshots (DOM text).
    // Adjacent duplicate snapshots (http/db and other page-untouched steps) are deduped, keeping the last 3 to bound the verdict's token cost.
    let lastShot: string | null = null;
    for (let k = results.length - 1; k >= 0; k--) {
      const s = results[k]!.screenshot;
      if (s) { lastShot = s; break; }
    }
    const dedupedTexts: string[] = [];
    for (const t of pageTextSnaps) {
      if (t !== dedupedTexts[dedupedTexts.length - 1]) dedupedTexts.push(t);
    }
    // Step execution record: each step's warning/error (incl. the on-the-spot AI's description of page phenomena). A transient notice may appear
    // mid-step and vanish before the step ends (worst when an AI-fallback redo takes tens of seconds), so neither the end-of-step snapshot
    // nor the final screenshot can catch it — only the executor that saw it at the time wrote it into a note.
    const stepNotes: string[] = [];
    for (const r of results) {
      const note = [r.warning, r.error].filter(Boolean).join('；');
      if (note) stepNotes.push(`第 ${r.order} 步：${note.slice(0, 300)}`);
    }
    const va = await runCaseVisionAssert({
      page: opts.page,
      reportId: ctx.reportId,
      caseTitle: ctx.caseTitle ?? caseId,
      caseUrl: ctx.caseUrl ?? null,
      caseWebOrigin: ctx.caseWebOrigin ?? null,
      expectedOutcome: ctx.expectedOutcome,
      vars,
      sensitiveVarKeys: ctx.sensitiveVarKeys ?? [],
      llmClient: ctx.llmClient,
      processScreenshotPath: lastShot,
      ...(dedupedTexts.length ? { processPageTexts: dedupedTexts.slice(-3) } : {}),
      ...(stepNotes.length ? { processStepNotes: stepNotes } : {}),
    });
    if (va?.failureStep) {
      results.push(va.failureStep);
    } else if (va?.onLastPass) {
      const last = results[results.length - 1];
      if (last) last.visionAssert = { passed: true, ...va.onLastPass };
    }
  }
  return results;
}

/** Executes a case in a real browser (playwright-core driving chromium). Returns step-granularity results.
 * onPreflight: side-channel callback for the pre-execution preflight report (runCase decides whether to persist it),
 * keeping the existing return signature (ExecStepResult[]) unchanged for existing callers.
 * caseWindow/incognito: window strategy and incognito mode; storageState isn't injected when incognito. */
export async function executeCaseReal(
  caseId: string,
  steps: Array<{
    order: number;
    /** Optional step-level assertion (any StepAction subset); skipped when null/undefined. */
    assertion?: unknown;
    delayMs?: number | null;
    id?: string;
    tabRef?: string | null;
    componentKind?: string | null;
    sensitive?: boolean | null;
    /** Executable DSL array; the sole replay source. Empty array/null = not compiled, throws compile-missing. */
    compiled?: unknown[] | null;
    /** Row-level natural-language instruction; replay reads it only for AI fallback, mechanical replay never does. */
    instruction?: string | null;
  }>,
  ctx: ExecContext,
  targetUrl?: string,
  storageState?: unknown,
  onPreflight?: (report: PreflightReport) => void,
  caseWindow?: CaseWindow,
  incognito?: boolean,
  onStep?: (r: ExecStepResult) => void,
): Promise<ExecStepResult[]> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    const viewport =
      caseWindow?.strategy === 'custom' && caseWindow.width && caseWindow.height
        ? { width: caseWindow.width, height: caseWindow.height }
        : caseWindow?.strategy === 'current'
          ? undefined
          : { width: 1280, height: 800 }; // maximize approximation (headless)
    const context = await browser.newContext({
      ...(storageState && !incognito ? { storageState: storageState as never } : {}),
      ...(viewport ? { viewport } : {}),
      // Self-signed certs / intranet https sites: allow ERR_CERT_AUTHORITY_INVALID during execution and keep going
      // (users can still manually trust the cert in a browser; this only affects the replay path).
      ignoreHTTPSErrors: true,
      // navigator.language set to zh-CN: most SUTs are Chinese products and i18next renders by browser locale;
      // hardcoded for now; move to envContext later if per-env/project switching is needed.
      locale: 'zh-CN',
    });
    return await runStepsInContext(caseId, steps, ctx, context, targetUrl, onPreflight, caseWindow, onStep);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

/** Runs case steps in a caller-held chromium + context (for the loginPrepare path's shared login state).
 *  Behaves like `executeCaseReal` but skips launch / newContext / close — the context already carries the login cookies,
 *  so storageState is not injected (overwriting it would break the login state); incognito is ignored (the caller-held ctx is already logged in). */
export async function executeCaseInBrowser(
  caseId: string,
  steps: Array<{
    order: number;
    assertion?: unknown;
    delayMs?: number | null;
    id?: string;
    tabRef?: string | null;
    componentKind?: string | null;
    sensitive?: boolean | null;
    compiled?: unknown[] | null;
    /** Row-level natural-language instruction; replay reads it only for AI fallback, mechanical replay never does. */
    instruction?: string | null;
  }>,
  ctx: ExecContext,
  browser: Browser,
  context: BrowserContext,
  targetUrl?: string,
  onPreflight?: (report: PreflightReport) => void,
  caseWindow?: CaseWindow,
  onStep?: (r: ExecStepResult) => void,
  onFailurePage?: (page: Page, failedIndex: number) => Promise<void>,
): Promise<ExecStepResult[]> {
  // The browser parameter is held explicitly for the caller's reading intent; the execution path doesn't use browser directly (the context is ready).
  void browser;
  return runStepsInContext(caseId, steps, ctx, context, targetUrl, onPreflight, caseWindow, onStep, onFailurePage);
}