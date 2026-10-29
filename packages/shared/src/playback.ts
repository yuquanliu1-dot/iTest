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
  /** 2026-10-22: sql 步骤（查被测系统库）失败 */
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
  /** 计划运行被用户终止：当前步及后续步骤不再执行（步级取消检查点） */
  'Cancelled',
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

/** queryDb 步骤执行结果：行数 / 耗时 / 命中行（最多 50 行）/ 断言命中情况。
 *  sql/params = 实际发给库的语句与绑定参数值（模板变量已换成占位符，值在 params 里），
 *  报告页要能同时看到「发了什么」和「回了什么」。老报告缺这两个字段。 */
export interface DbQueryRowResult {
  rowCount: number;
  durationMs: number;
  rows: Record<string, unknown>[];
  /** 实际执行的 SQL（占位符形态：pg $n / mysql ?）。 */
  sql?: string;
  /** 绑定参数值（与 sql 里的占位符一一对应）。 */
  params?: unknown[];
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

/** sql 步骤执行结果：命中的 db 对象 label / 行数 / 行内容（值截断）/ 断言命中。
 *  sql/params = 实际发给库的语句与绑定参数值（模板变量已换成占位符，值在 params 里），
 *  报告页要能同时看到「发了什么」和「回了什么」。老报告缺这两个字段。 */
export interface SqlStepResult {
  dbRef: string | null;
  rowCount: number;
  durationMs: number;
  rows: Record<string, unknown>[];
  /** 实际执行的 SQL（占位符形态：pg $n / mysql ?）。 */
  sql?: string;
  /** 绑定参数值（与 sql 里的占位符一一对应）。 */
  params?: unknown[];
  truncated?: boolean;
  assertion?: { matched: boolean; expected: string; match: 'equals' | 'contains' | 'regex' };
}

/** httpRequest 步骤执行结果：请求/响应（敏感头打码、body 截断 64KB）/断言命中/变量提取。
 *  response 在传输层失败（连接被拒/重置/超时）且断言允许传输失败时缺省——那时没有任何 HTTP 响应。 */
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
  /** 传输层失败原因（连接被拒/被重置/超时等）。仅在传输失败且断言允许时记录。 */
  transportFailure?: string;
  assertion?: { matched: boolean; statusExpected?: number; match?: 'equals' | 'contains' | 'notContains' | 'regex'; expected?: string };
  saved?: { varName: string; value: string };
}

/** sendSyslog 步骤执行结果：发出的原始 RFC3164 报文与耗时/字节数。 */
export interface SyslogStepResult {
  protocol: 'udp' | 'tcp';
  host: string;
  port: number;
  facility: string;
  severity: string;
  /** 实际发出的报文（TCP 帧尾 \n 不计入 packet，计入 bytes）。 */
  packet: string;
  durationMs: number;
  bytes: number;
}
