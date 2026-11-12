import { z } from 'zod';

export const WindowStrategy = z.enum(['maximize', 'current', 'custom']);
export type WindowStrategy = z.infer<typeof WindowStrategy>;

export const FailureReason = z.enum([
  'URLUnreachable',
  'NotLoggedIn',
  'SlowLoad',
  'ElementOccluded',
  'PageStructureChanged',
  'TestDataMissing',
  'AssertionMismatch',
  'FixedValueConflict',
  'TabMissing',
  'AttachmentMissing',
  'SecretMissing',
  'DisabledTimeout',
  'LoadingTimeout',
  'OverlayTimeout',
  'LocatorAllFailed',
  'CDPUnavailable',
  /** 2026-10-22: sql step (querying the SUT database) failure */
  'SqlError',
  'SqlReadOnlyViolation',
  'SqlAssertionFailed',
  'EnvMissing',
  'EnvDbMissing',
  'EnvSyslogMissing',
  'SyslogConnectFailed',
  'SyslogAuthFailed',
  'SyslogFileMissing',
  'SyslogTimeout',
  'LogAssertionFailed',
  /** 2026-10-12: httpRequest step failure classification */
  'HttpRequestError',
  'HttpRequestTimeout',
  'HttpRequestAssertionFailed',
  'HttpRequestSaveAsFailed',
  /** 2026-10-13: LLM gateway/provider errors (missing content, silently blocked by safety policy, etc. — platform-side errors, not page/locator problems) */
  'LLMProviderError',
  'EnvMissing',
  'EnvProjectMismatch',
  /** 2026-10-16: relative-url execution — the environment has no web service to assemble an origin from, or the ref is invalid */
  'WebServiceMissing',
  /** Track 1: case-level vision LLM judges the final screenshot as mismatching expectedOutcome */
  'VisionAssertionFailed',
  /** Plan run terminated by the user: the current and subsequent steps no longer execute (step-level cancellation checkpoint) */
  'Cancelled',
  /** 2026-10-07: mobile engine failure classification */
  'EngineUnavailable',
  'MobileUnsupportedCapability',
  'MobileStepFailed',
  'AppInstallFailed',
  'Unknown',
]);
export type FailureReason = z.infer<typeof FailureReason>;

export interface HitLocator {
  kind: string;
  value: string;
}

export interface PreflightReport {
  urlReachable: boolean;
  urlNote?: string;
  loggedIn: boolean;
  sourceOrigin?: string;
  currentOrigin?: string;
  originMismatch?: boolean;
  tabsObserved?: number[];
  durationMs: number;
}

/** observeLog step execution result: matched line count / duration / line contents (with optional ts) / assertion outcome. */
export interface ObserveLogLineResult {
  matchedLineCount: number;
  durationMs: number;
  lines: { ts?: string; raw: string }[];
  truncated?: boolean;
  assertion?: { matched: boolean; expected: string; match: 'equals' | 'contains' | 'regex' };
}

/** sql step execution result: the matched db object label / row count / row contents (values truncated) / assertion outcome.
 *  sql/params = the statement actually sent to the database and its bound parameter values (template variables already replaced by placeholders, values live in params);
 *  the report page must show both "what was sent" and "what came back". Older reports lack these two fields. */
export interface SqlStepResult {
  dbRef: string | null;
  rowCount: number;
  durationMs: number;
  rows: Record<string, unknown>[];
  /** The SQL actually executed (placeholder form: pg $n / mysql ?). */
  sql?: string;
  /** Bound parameter values (one-to-one with the placeholders in sql). */
  params?: unknown[];
  truncated?: boolean;
  assertion?: { matched: boolean; expected: string; match: 'equals' | 'contains' | 'regex' };
}

/** httpRequest step execution result: request/response (sensitive headers masked, body truncated at 64KB) / assertion outcome / variable extraction.
 *  response is absent when the transport failed (connection refused/reset/timeout) and the assertion allows transport failures — there was no HTTP response at all then. */
export interface HttpStepResult {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    bodyPreview?: string;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyText: string;
    durationMs: number;
  };
  /** Transport-level failure reason (connection refused/reset, timeout, etc.). Recorded only on transport failure when allowed. */
  transportFailure?: string;
  assertion?: { matched: boolean; statusExpected?: number; match?: 'equals' | 'contains' | 'notContains' | 'regex'; expected?: string };
  saved?: { varName: string; value: string };
}

/** Browser console error / uncaught exception collection entries. The execution engine subscribes at page level
 *  and drains them per step start/end for attribution: console-error = console.error-level output, pageerror = uncaught JS exception.
 *  Older reports and synthesized failure steps (no page) lack this field. */
export interface ConsoleLogEntry {
  type: 'console-error' | 'pageerror';
  text: string;
  ts: number;
}

/** sendSyslog step execution result: the raw RFC3164 packet sent plus duration/byte count. */
export interface SyslogStepResult {
  protocol: 'udp' | 'tcp';
  host: string;
  port: number;
  facility: string;
  severity: string;
  /** The packet actually sent (TCP's trailing \n counts toward bytes, not packet). */
  packet: string;
  durationMs: number;
  bytes: number;
}
