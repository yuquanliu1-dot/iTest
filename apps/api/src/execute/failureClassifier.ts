import type { FailureReason } from '@itest/shared';
import type { StepAction } from '@itest/shared';

const DEFAULT_KEYWORDS = ['请先登录', '未登录', '未授权', '登录后'];

export interface ClassifiedFailure {
  reason: FailureReason;
  humanMessage: string;
}

const HUMAN: Record<FailureReason, string> = {
  URLUnreachable: '起始 URL 无法访问，请检查网络或地址',
  NotLoggedIn: '检测到登录态失效，请先登录或启用登录准备',
  SlowLoad: '页面加载过慢，超出预期耗时',
  ElementOccluded: '目标元素被遮挡，无法操作',
  PageStructureChanged: '页面结构疑似变化，多步连续失败',
  TestDataMissing: '目标测试数据不存在',
  AssertionMismatch: '断言不匹配',
  FixedValueConflict: '固定输入值重复导致新建失败',
  TabMissing: '切换的目标标签页已不可用',
  AttachmentMissing: '上传附件未绑定或已失效',
  SecretMissing: '敏感字段未配置或解密失败',
  DisabledTimeout: '元素被禁用，等待超时',
  LoadingTimeout: '元素仍在加载，等待超时',
  OverlayTimeout: '元素被遮罩覆盖，等待超时',
  LocatorAllFailed: '所有定位候选均未命中',
  CDPUnavailable: '真实浏览器不可用，已尝试 DOM 降级仍失败',
  QueryDbError: '数据库查询失败',
  QueryDbTableNotAllowed: '该表不在允许查询的列表中',
  QueryDbColumnNotAllowed: '该列不在允许查询的列表中',
  QueryDbAssertionFailed: '数据库断言未命中',
  EnvMissing: '缺少环境配置，请到项目设置配置测试环境',
  EnvProjectMismatch: '环境所属项目与当前用例不匹配',
  EnvDbMissing: '当前环境未配置数据库连接',
  EnvSyslogMissing: '当前环境未配置 syslog 连接',
  SyslogConnectFailed: '连接 syslog 服务器失败',
  SyslogAuthFailed: 'syslog 鉴权失败',
  SyslogFileMissing: 'syslog 日志文件不可访问',
  SyslogTimeout: '读取 syslog 超时',
  LogAssertionFailed: '日志断言未命中',
  HttpRequestError: 'HTTP 请求失败（网络错误或无法读取响应）',
  HttpRequestTimeout: 'HTTP 请求超时',
  HttpRequestAssertionFailed: 'HTTP 断言未命中（状态码或响应体不匹配）',
  HttpRequestSaveAsFailed: 'HTTP 响应值提取失败',
  VisionAssertionFailed: '最终页面与用例预期不符(vision 判定失败)',
  EngineUnavailable: '移动端引擎不可用，请检查设备配置或 agent-device daemon',
  MobileUnsupportedCapability: '当前 mobile 引擎不支持该动作',
  MobileStepFailed: 'agent-device 命令失败',
  AppInstallFailed: '移动端 app 安装失败',
  Unknown: '未知错误',
};

interface ClassifyCtx {
  action?: StepAction | { kind?: string; value?: unknown; equals?: string };
  durationMs?: number;
}

function asErrorWithName(err: unknown): Error & { name?: string; reason?: string } {
  return err as Error & { name?: string; reason?: string };
}

export function classify(err: unknown, ctx: ClassifyCtx = {}): ClassifiedFailure {
  const e = asErrorWithName(err);
  const msg = e?.message ?? '';
  if (e?.name === 'ElementNotStable') {
    if (e.reason === 'disabled') return { reason: 'DisabledTimeout', humanMessage: HUMAN.DisabledTimeout };
    if (e.reason === 'loading') return { reason: 'LoadingTimeout', humanMessage: HUMAN.LoadingTimeout };
    if (e.reason === 'overlay') return { reason: 'OverlayTimeout', humanMessage: HUMAN.OverlayTimeout };
  }
  if (msg.includes('tab-missing')) return { reason: 'TabMissing', humanMessage: HUMAN.TabMissing };
  if (msg.includes('assertText failed') || msg.includes('assertJson')) {
    if (ctx.action && 'equals' in (ctx.action as { equals?: string }) && typeof (ctx.action as { equals?: string }).equals === 'string') {
      const equals = (ctx.action as { equals: string }).equals;
      if (DEFAULT_KEYWORDS.some((k) => equals.includes(k))) {
        return { reason: 'NotLoggedIn', humanMessage: HUMAN.NotLoggedIn };
      }
    }
    return { reason: 'AssertionMismatch', humanMessage: HUMAN.AssertionMismatch };
  }
  if (msg.includes('attachment-missing')) return { reason: 'AttachmentMissing', humanMessage: HUMAN.AttachmentMissing };
  if (msg.includes('secret-missing')) return { reason: 'SecretMissing', humanMessage: HUMAN.SecretMissing };
  if (msg.includes('all locator candidates failed') || msg.includes('count=0')) {
    return { reason: 'LocatorAllFailed', humanMessage: HUMAN.LocatorAllFailed };
  }
  if (e?.name === 'QueryDbError') return { reason: 'QueryDbError', humanMessage: HUMAN.QueryDbError };
  if (e?.name === 'QueryDbTableNotAllowed') return { reason: 'QueryDbTableNotAllowed', humanMessage: HUMAN.QueryDbTableNotAllowed };
  if (e?.name === 'QueryDbColumnNotAllowed') return { reason: 'QueryDbColumnNotAllowed', humanMessage: HUMAN.QueryDbColumnNotAllowed };
  if (e?.name === 'QueryDbAssertionFailed') return { reason: 'QueryDbAssertionFailed', humanMessage: HUMAN.QueryDbAssertionFailed };
  if (e?.name === 'EnvMissing') return { reason: 'EnvMissing', humanMessage: HUMAN.EnvMissing };
  if (e?.name === 'EnvDbMissing') return { reason: 'EnvDbMissing', humanMessage: HUMAN.EnvDbMissing };
  if (e?.name === 'EnvSyslogMissing') return { reason: 'EnvSyslogMissing', humanMessage: HUMAN.EnvSyslogMissing };
  if (e?.name === 'SyslogConnectFailed') return { reason: 'SyslogConnectFailed', humanMessage: HUMAN.SyslogConnectFailed };
  if (e?.name === 'SyslogAuthFailed') return { reason: 'SyslogAuthFailed', humanMessage: HUMAN.SyslogAuthFailed };
  if (e?.name === 'SyslogFileMissing') return { reason: 'SyslogFileMissing', humanMessage: HUMAN.SyslogFileMissing };
  if (e?.name === 'SyslogTimeout') return { reason: 'SyslogTimeout', humanMessage: HUMAN.SyslogTimeout };
  if (e?.name === 'LogAssertionFailed') return { reason: 'LogAssertionFailed', humanMessage: HUMAN.LogAssertionFailed };
  if (e?.name === 'HttpRequestError') return { reason: 'HttpRequestError', humanMessage: HUMAN.HttpRequestError };
  if (e?.name === 'HttpRequestTimeout') return { reason: 'HttpRequestTimeout', humanMessage: HUMAN.HttpRequestTimeout };
  if (e?.name === 'HttpRequestAssertionFailed') return { reason: 'HttpRequestAssertionFailed', humanMessage: HUMAN.HttpRequestAssertionFailed };
  if (e?.name === 'HttpRequestSaveAsFailed') return { reason: 'HttpRequestSaveAsFailed', humanMessage: HUMAN.HttpRequestSaveAsFailed };
  if (ctx.action && (ctx.action as { kind?: string }).kind === 'fill' &&
      (msg.includes('unique constraint') || msg.includes('duplicate'))) {
    return { reason: 'FixedValueConflict', humanMessage: HUMAN.FixedValueConflict };
  }
  if (typeof ctx.durationMs === 'number' && ctx.durationMs > 15000) {
    return { reason: 'SlowLoad', humanMessage: HUMAN.SlowLoad };
  }
  return { reason: 'Unknown', humanMessage: HUMAN.Unknown };
}

export const __test = { HUMAN, DEFAULT_KEYWORDS };