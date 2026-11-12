import { z } from 'zod';

// xpath is kept in the schema (legacy data compatibility), but neither the recorder nor newly generated AI cases should emit it.
export const LocatorStrategy = z.enum(['role', 'text', 'testId', 'css', 'xpath', 'accessibilityId', 'label', 'predicate']);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const Locator = z.object({
  strategy: LocatorStrategy,
  value: z.string().min(1),
});
export type Locator = z.infer<typeof Locator>;

/** navigate.url three forms: absolute http(s) (external link) / relative (starts with /, assembled with the case-bound web service at execution time) /
 *  leading {{variable}} (e.g. {{web_backend}}/api/x — substituted first, then judged by the first two forms). */
const navigateUrl = z.string().refine(
  (u) => /^https?:\/\//i.test(u) || u.startsWith('/') || u.startsWith('{{'),
  { message: 'url 必须是绝对 http(s) 地址、以 / 开头的相对路径,或 {{变量}} 打头' },
);
export const NavigateAction = z.object({ kind: z.literal('navigate'), url: navigateUrl });

export const IntentLocator = z.object({
  /** Semantic role determined at recording time (data-testid / name etc.), used as a supplementary candidate at replay. */
  semanticRole: z.string().min(1).max(64),
  /** Business copy; participates in text fallback at replay. */
  contextText: z.string().max(500).optional(),
});
export type IntentLocator = z.infer<typeof IntentLocator>;

/** iframe frame chain (recorder artifact): top-down, each level being the candidate chain of that iframe element itself.
 *  Replay resolves elementHandle.contentFrame() in order, drilling down level by level; page-level assertions (target=page/url/errorMessage)
 *  and non-DOM actions do not carry it. Recorder-side same-origin constraint: cross-origin frames cannot resolve a chain — the step is recorded, but without one. */
export const FrameChain = z.array(z.object({ locator: z.array(Locator).min(1) }));
export type FrameChain = z.infer<typeof FrameChain>;

export const ValueGenerator = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('randomString'), length: z.number().int().min(1).max(200).default(12) }),
    z.object({ mode: z.literal('randomNumber'), min: z.number().int().default(0), max: z.number().int().default(999999) }),
    z.object({ mode: z.literal('timestamp') }),
    z.object({ mode: z.literal('prefixTimestamp'), prefix: z.string().min(1).max(100) }),
  ])
  .refine((d) => d.mode !== 'randomNumber' || d.max >= d.min, { message: 'max must be >= min' });
export type ValueGenerator = z.infer<typeof ValueGenerator>;

export const ClickAction = z.object({
  kind: z.literal('click'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  /** 2=double click 3=triple click; default 1 (single click). Set to 2 when the recorder captures a native dblclick. */
  clickCount: z.number().int().min(2).max(3).optional(),
  frameChain: FrameChain.optional(),
});

/** Scroll: absolute-position scrolling (not incremental delta — replay is independent of the start point; the browser clamps to content bounds automatically).
 *  locator points at the actually scrolling container; window-level scrolling records document.scrollingElement (css 'html'). */
export const ScrollAction = z.object({
  kind: z.literal('scroll'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  scrollTop: z.number().int().min(0),
  scrollLeft: z.number().int().min(0).default(0),
  frameChain: FrameChain.optional(),
});

/** Possible shapes of a single CompositeValue segment; concatenated in order to produce the final input. */
export const ValueFragment = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), value: z.string().max(500) }),
  z.object({ mode: z.literal('date'), format: z.enum(['YYYYMMDD', 'YYYY-MM-DD', 'YYYY/MM/DD']) }),
  z.object({
    mode: z.literal('randomNumber'),
    min: z.number().int().min(0).default(0),
    max: z.number().int().default(999999),
    /** Fixed digit count; when present, left-padded with zeros to that length. */
    length: z.number().int().min(1).max(128).optional(),
  }),
  z.object({ mode: z.literal('randomString'), length: z.number().int().min(1).max(1024).default(12) }),
  z.object({ mode: z.literal('timestamp') }),
]);
export type ValueFragment = z.infer<typeof ValueFragment>;

/** Estimates the max length (reused by refine + the frontend builder). */
export function estimateMaxLen(input: { fragments: ValueFragment[] }): number {
  let total = 0;
  for (const f of input.fragments) {
    switch (f.mode) {
      case 'fixed': total += f.value.length; break;
      case 'date': total += f.format.length; break;
      case 'randomNumber': total += f.length ?? String(f.max).length; break;
      case 'randomString': total += f.length; break;
      case 'timestamp': total += 13; break;
    }
  }
  return total;
}

export const CompositeValue = z
  .object({
    mode: z.literal('composite'),
    fragments: z.array(ValueFragment).min(1).max(20),
  })
  .refine((v) => estimateMaxLen(v) <= 1024, {
    message: 'CompositeValue 总长度超过 1024 上限',
    path: ['fragments'],
  });
export type CompositeValue = z.infer<typeof CompositeValue>;

export const FillValue = z.union([z.string(), ValueGenerator, CompositeValue]);
export type FillValue = z.infer<typeof FillValue>;

export const FillAction = z.object({
  kind: z.literal('fill'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  value: FillValue,
  sensitive: z.boolean().optional(),
  frameChain: FrameChain.optional(),
});
export const HoverAction = z.object({ kind: z.literal('hover'), locator: z.array(Locator).min(1), frameChain: FrameChain.optional() });
export const WaitForAction = z.object({
  kind: z.literal('waitFor'),
  /** Empty array = fixed-duration wait (no specific element), sleeping timeoutMs (default 5000). */
  locator: z.array(Locator),
  intentLocator: IntentLocator.optional(),
  timeoutMs: z.number().int().positive().optional(),
  frameChain: FrameChain.optional(),
});
export const AssertTextAction = z.object({
  kind: z.literal('assertText'),
  locator: z.array(Locator),
  intentLocator: IntentLocator.optional(),
  target: z.enum(['specifiedElement', 'page', 'errorMessage', 'url']).default('specifiedElement'),
  match: z.enum(['equals', 'contains', 'notContains', 'regex']).default('equals'),
  equals: z.string(),
  /** Carried only when target=specifiedElement. */
  frameChain: FrameChain.optional(),
});
export const AssertVisibleAction = z.object({
  kind: z.literal('assertVisible'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  frameChain: FrameChain.optional(),
});
export const ScreenshotAction = z.object({ kind: z.literal('screenshot'), name: z.string() });

export const CheckAction = z.object({
  kind: z.literal('check'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  checked: z.boolean(),
  frameChain: FrameChain.optional(),
});
export const SelectAction = z.object({
  kind: z.literal('select'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  value: z.string().min(1),
  frameChain: FrameChain.optional(),
});
/** 2026-11-04: press step — press a single key on the located element (the recorder captures keyboard actions like Enter-to-submit inside inputs).
 *  key uses Playwright key names (e.g. "Enter" / "Tab"); replay maps to locator.press(key). */
export const PressAction = z.object({
  kind: z.literal('press'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  key: z.string().min(1).max(30),
  frameChain: FrameChain.optional(),
});
export const UploadAction = z.object({
  kind: z.literal('upload'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  fileId: z.string().min(1),
  frameChain: FrameChain.optional(),
});
export const SwitchTabAction = z.object({
  kind: z.literal('switchTab'),
  tabRef: z.string().min(1).max(64),
});
/** Smart task: a natural-language step driven by multi-turn LLM execution at replay (not precompiled; decisions made from screenshots at runtime).
 * Fits scenarios that resist solidifying into DSL, such as CAPTCHA recognition and dynamic/unstable page interactions. */
export const AiTaskAction = z.object({
  kind: z.literal('aiTask'),
  instruction: z.string().min(1).max(2000),
  intentLocator: IntentLocator.optional(),
});
export const AssertJsonAction = z.object({
  kind: z.literal('assertJson'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  equals: z.unknown(),
  frameChain: FrameChain.optional(),
});
export const ExtractMode = z.enum(['completeValue', 'smartExtract', 'regex']);
export type ExtractMode = z.infer<typeof ExtractMode>;

export const ExtractAction = z.object({
  kind: z.literal('extract'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  varName: z.string().min(1).max(64),
  mode: ExtractMode.default('completeValue'),
  /** Required in regex mode; in smartExtract mode written in by the backend after a one-time compile. */
  pattern: z.string().min(1).max(500).optional(),
  /** Capture group in regex mode, 1-based; 0 means the whole match. */
  group: z.number().int().min(0).max(10).optional(),
  /** The user's natural-language description in smartExtract mode, for UI display only. */
  description: z.string().max(500).optional(),
  frameChain: FrameChain.optional(),
});
export type ExtractAction = z.infer<typeof ExtractAction>;

export const DbAssertionMatch = z.enum(['equals', 'contains', 'regex']);
export type DbAssertionMatch = z.infer<typeof DbAssertionMatch>;

export const ObserveLogAction = z.object({
  kind: z.literal('observeLog'),
  /** The environment syslog object's label; omitted = the environment's default syslog object. */
  syslogRef: z.string().min(1).max(64).optional(),
  windowMs: z.number().int().min(1000).max(600000).default(60000),
  keywords: z.array(z.string().min(1).max(200)).max(10).default([]),
  fromLine: z.number().int().min(1).max(10000).default(200),
  assertion: z.object({
    match: DbAssertionMatch.default('contains'),
    expected: z.string().max(2000),
  }).optional(),
});
export type ObserveLogAction = z.infer<typeof ObserveLogAction>;

export const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export type HttpMethod = z.infer<typeof HttpMethod>;

/** RFC3164 facility; the enum index is the facility code (kernel=0 ... local7=23); 12-15 are named per RFC5424 to keep local* aligned. */
export const SyslogFacility = z.enum([
  'kernel', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
  'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clockDaemon2',
  'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7',
]);
export type SyslogFacility = z.infer<typeof SyslogFacility>;

/** RFC3164 severity; the enum index is the severity code (emerg=0 ... debug=7). */
export const SyslogSeverity = z.enum(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']);
export type SyslogSeverity = z.infer<typeof SyslogSeverity>;

/** 2026-10-20: sendSyslog step — send one RFC3164 log message to a syslog server. */
export const SendSyslogAction = z.object({
  kind: z.literal('sendSyslog'),
  protocol: z.enum(['udp', 'tcp']).default('udp'),
  /** Syslog server address; supports {{var}} substitution. */
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(514),
  facility: SyslogFacility.default('user'),
  severity: SyslogSeverity.default('info'),
  /** Log body (RFC3164 MSG part), no variable substitution. */
  message: z.string().min(1).max(2000),
  timeoutMs: z.number().int().min(1000).max(30000).default(5000),
});
export type SendSyslogAction = z.infer<typeof SendSyslogAction>;

/** 2026-10-22: sql step — execute a single read-only SQL against the SUT's own database.
 *  2026-11-08: queryDb has been retired (it connected to the environment's default db object = the SUT database, yet hardcoded
 *  the platform's own table names — the two sides never matched, so it failed constantly). Database queries uniformly go through sql:
 *  dbRef omitted = the environment's default db object. */
export const SqlAction = z.object({
  kind: z.literal('sql'),
  /** The environment db object's label; omitted = the environment's default db object. */
  dbRef: z.string().min(1).max(64).optional(),
  /** A single read-only SQL (starting with SELECT / WITH); the execution layer applies a further lexical guard. */
  sql: z.string().min(1).max(8000),
  /** Positional parameters; dialect adaptation handled by the execution layer (postgres $n / mysql ?). */
  params: z.array(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).max(20).default([]),
  limit: z.number().int().min(1).max(200).default(50),
  assertion: z.object({
    match: DbAssertionMatch.default('contains'),
    expected: z.string().max(2000),
    column: z.string().max(64).optional(),
  }).optional(),
});
export type SqlAction = z.infer<typeof SqlAction>;

/** httpRequest's body match mode. Kept separate from DbAssertionMatch (which is shared by sql/observeLog —
 *  adding an enum value there would ripple into both execution and UI); this one adds notContains — security assertions often need "response body does not contain the injection string". */
export const HttpBodyMatch = z.enum(['equals', 'contains', 'notContains', 'regex']);
export type HttpBodyMatch = z.infer<typeof HttpBodyMatch>;

export const HttpRequestAction = z.object({
  kind: z.literal('httpRequest'),
  method: HttpMethod.default('GET'),
  /** Supports {{var}} substitution. */
  url: z.string().min(1).max(2000),
  headers: z.array(z.object({
    key: z.string().min(1).max(128),
    /** Supports {{var}} substitution. */
    value: z.string().max(2000),
  })).max(20).default([]),
  /** Raw request body; supports {{var}} substitution. */
  body: z.string().max(65536).optional(),
  timeoutMs: z.number().int().min(1000).max(30000).default(10000),
  /** When true, forwards the browser login-state Cookie to the request by URL host (never overwrites a hand-filled Cookie header). */
  carryLoginState: z.boolean().optional(),
  /** Extracts a response value into a variable for subsequent steps to consume via {{var}}. */
  saveAs: z.object({
    varName: z.string().min(1).max(64),
    from: z.enum(['body', 'status']),
    /** Simplified dot-path (e.g. data.items[0].id); effective only when from='body'; omitted = the full body text. */
    path: z.string().max(200).optional(),
  }).optional(),
  /** status and body are both optional; when both are set, both must pass. */
  assertion: z.object({
    status: z.number().int().min(100).max(599).optional(),
    match: HttpBodyMatch.default('contains'),
    /** The expected value matched against the response body text. */
    expected: z.string().max(2000).optional(),
    /**
     * When true, "transport-layer failure" (connection refused / reset / timeout) is judged as an assertion hit.
     *
     * 2026-10-22: security cases often expect "the service rejects the forged Host at the transport layer" — the SUT
     * RSTs the connection outright and there is no HTTP response to assert (prod228 case 4608e4f4: curl (52) Empty reply from server).
     * Default (false): transport failure throws immediately, marking the step failed and bypassing the assertion — a false failure.
     * When enabled: transport failure → assertion hit, step passes, and the failure reason is recorded; with a response present, status/expected judging proceeds as usual.
     */
    allowTransportFailure: z.boolean().optional(),
  }).optional(),
});
export type HttpRequestAction = z.infer<typeof HttpRequestAction>;

/** 2026-10-07: mobile-testing step DSL additions (Task 1 of the iTest mobile-testing plan). */
export const TapAction = z.object({
  kind: z.literal('tap'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  doubleTap: z.boolean().optional(),
  longPressMs: z.number().int().min(100).max(5000).optional(),
});
export const SwipeAction = z.object({
  kind: z.literal('swipe'),
  from: z.array(Locator).min(1),
  to: z.array(Locator).min(1),
  durationMs: z.number().int().min(50).max(3000).default(300),
});
export const SetAppearanceAction = z.object({
  kind: z.literal('setAppearance'),
  mode: z.enum(['light', 'dark']),
});
export const SetNetworkAction = z.object({
  kind: z.literal('setNetwork'),
  state: z.enum(['online', 'offline', 'airplane']),
});
export const SetLocationAction = z.object({
  kind: z.literal('setLocation'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export const AppOpenAction = z.object({
  kind: z.literal('appOpen'),
  bundleId: z.string().min(1).optional(),
});
export const AppBackAction = z.object({ kind: z.literal('appBack') });
export const AppRestartAction = z.object({ kind: z.literal('appRestart') });
export const HomeAction = z.object({ kind: z.literal('home') });

export type StepAction =
  | z.infer<typeof NavigateAction>
  | z.infer<typeof ClickAction>
  | z.infer<typeof ScrollAction>
  | z.infer<typeof FillAction>
  | z.infer<typeof HoverAction>
  | z.infer<typeof WaitForAction>
  | z.infer<typeof AssertTextAction>
  | z.infer<typeof AssertVisibleAction>
  | z.infer<typeof ScreenshotAction>
  | z.infer<typeof CheckAction>
  | z.infer<typeof SelectAction>
  | z.infer<typeof PressAction>
  | z.infer<typeof UploadAction>
  | z.infer<typeof SwitchTabAction>
  | z.infer<typeof AiTaskAction>
  | z.infer<typeof AssertJsonAction>
  | z.infer<typeof ExtractAction>
  | z.infer<typeof ObserveLogAction>
  | z.infer<typeof HttpRequestAction>
  | z.infer<typeof SendSyslogAction>
  | z.infer<typeof SqlAction>
  | z.infer<typeof TapAction>
  | z.infer<typeof SwipeAction>
  | z.infer<typeof SetAppearanceAction>
  | z.infer<typeof SetNetworkAction>
  | z.infer<typeof SetLocationAction>
  | z.infer<typeof AppOpenAction>
  | z.infer<typeof AppBackAction>
  | z.infer<typeof AppRestartAction>
  | z.infer<typeof HomeAction>;

export const StepAction: z.ZodType<StepAction> = z.discriminatedUnion('kind', [
  NavigateAction,
  ClickAction,
  ScrollAction,
  FillAction,
  HoverAction,
  WaitForAction,
  AssertTextAction,
  AssertVisibleAction,
  ScreenshotAction,
  CheckAction,
  SelectAction,
  PressAction,
  UploadAction,
  SwitchTabAction,
  AiTaskAction,
  AssertJsonAction,
  ExtractAction,
  ObserveLogAction,
  HttpRequestAction,
  SendSyslogAction,
  SqlAction,
  TapAction,
  SwipeAction,
  SetAppearanceAction,
  SetNetworkAction,
  SetLocationAction,
  AppOpenAction,
  AppBackAction,
  AppRestartAction,
  HomeAction,
]) as z.ZodType<StepAction>;
