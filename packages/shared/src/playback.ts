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
  'QueryDbError',
  'QueryDbTableNotAllowed',
  'QueryDbColumnNotAllowed',
  'QueryDbAssertionFailed',
  'EnvMissing',
  'EnvDbMissing',
  'EnvSyslogMissing',
  'SyslogConnectFailed',
  'SyslogAuthFailed',
  'SyslogFileMissing',
  'SyslogTimeout',
  'LogAssertionFailed',
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

/** queryDb 步骤执行结果：行数 / 耗时 / 命中行（最多 50 行）/ 断言命中情况。 */
export interface DbQueryRowResult {
  rowCount: number;
  durationMs: number;
  rows: Record<string, unknown>[];
  truncated?: boolean;
  assertion?: { matched: boolean; expected: string; match: 'equals' | 'contains' | 'regex' };
}

/** observeLog 步骤执行结果：匹配行数 / 耗时 / 行内容（带可选 ts）/ 断言命中情况。 */
export interface ObserveLogLineResult {
  matchedLineCount: number;
  durationMs: number;
  lines: { ts?: string; raw: string }[];
  truncated?: boolean;
  assertion?: { matched: boolean; expected: string; match: 'equals' | 'contains' | 'regex' };
}
