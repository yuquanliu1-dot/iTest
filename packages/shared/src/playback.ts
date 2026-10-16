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
  /** 2026-10-12: httpRequest 步骤失败归类 */
  'HttpRequestError',
  'HttpRequestTimeout',
  'HttpRequestAssertionFailed',
  'HttpRequestSaveAsFailed',
  /** 2026-10-13: LLM 网关/提供商异常（缺 content、被安全策略静默拦截等平台侧错误，非页面/定位问题） */
  'LLMProviderError',
  'EnvMissing',
  'EnvProjectMismatch',
  /** 2026-10-16: 相对 url 执行——环境无可拼 origin 的 web 服务或 ref 非法 */
  'WebServiceMissing',
  /** Track 1: 用例级 vision LLM 判定最终截图与 expectedOutcome 不符 */
  'VisionAssertionFailed',
  /** 2026-10-07: mobile engine 失败归类 */
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

/** httpRequest 步骤执行结果：请求/响应（敏感头打码、body 截断 64KB）/断言命中/变量提取。 */
export interface HttpStepResult {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    bodyPreview?: string;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyText: string;
    durationMs: number;
  };
  assertion?: { matched: boolean; statusExpected?: number; match?: 'equals' | 'contains' | 'regex'; expected?: string };
  saved?: { varName: string; value: string };
}
