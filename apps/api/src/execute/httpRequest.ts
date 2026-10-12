import type { HttpRequestAction, DbAssertionMatch, HttpStepResult } from '@itest/shared';
import { substituteVars } from '@itest/shared';
import type { Page } from 'playwright-core';

export class HttpRequestError extends Error {
  constructor(msg: string) { super(msg); this.name = 'HttpRequestError'; }
}
export class HttpRequestTimeout extends Error {
  constructor(msg: string) { super(msg); this.name = 'HttpRequestTimeout'; }
}
export class HttpRequestAssertionFailed extends Error {
  constructor(msg: string) { super(msg); this.name = 'HttpRequestAssertionFailed'; }
}
export class HttpRequestSaveAsFailed extends Error {
  constructor(msg: string) { super(msg); this.name = 'HttpRequestSaveAsFailed'; }
}

export type { HttpStepResult };

/** 报告展示用：请求头里的敏感值打码。 */
const SENSITIVE_HEADER_RE = /^(authorization|cookie)$/i;
const MASK = '***';
const BODY_MAX = 64 * 1024;

function masked(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SENSITIVE_HEADER_RE.test(k) ? MASK : v;
  return out;
}

/** 简化 dot-path 解析：`a.b[0].c`（引号/转义不支持，超出即抛错）。 */
export function resolveDotPath(data: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((s) => s.length > 0);
  if (segments.length === 0) throw new HttpRequestSaveAsFailed(`saveAs path 为空: ${path}`);
  let cur: unknown = data;
  for (const seg of segments) {
    if (cur === null || cur === undefined) throw new HttpRequestSaveAsFailed(`saveAs path 中断于 "${seg}"（值为 null/undefined）`);
    if (/^\d+$/.test(seg)) {
      if (!Array.isArray(cur)) throw new HttpRequestSaveAsFailed(`saveAs path "${seg}" 期望数组，实际 ${typeof cur}`);
      const idx = Number(seg);
      if (idx >= cur.length) throw new HttpRequestSaveAsFailed(`saveAs path 下标越界: [${idx}]（长度 ${cur.length}）`);
      cur = cur[idx];
    } else {
      if (typeof cur !== 'object' || !(seg in (cur as Record<string, unknown>))) {
        throw new HttpRequestSaveAsFailed(`saveAs path "${seg}" 不存在`);
      }
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

function compareBody(bodyText: string, match: DbAssertionMatch, expected: string): boolean {
  if (match === 'equals') return bodyText === expected;
  if (match === 'contains') return bodyText.includes(expected);
  if (match === 'regex') {
    try { return new RegExp(expected).test(bodyText); } catch { return false; }
  }
  return false;
}

export async function runHttpRequest(opts: {
  action: HttpRequestAction;
  page: Page;
  vars: Record<string, string>;
}): Promise<HttpStepResult> {
  const { action, page, vars } = opts;

  const sub = (text: string): string => {
    const { value, missing } = substituteVars(text, vars);
    if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${text.slice(0, 100)}")`);
    return value;
  };

  const url = sub(action.url);
  const headers: Record<string, string> = {};
  for (const h of action.headers) headers[sub(h.key)] = sub(h.value);

  if (action.carryLoginState && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) {
    try {
      const cookies = await page.context().cookies(url);
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      if (cookieHeader) headers['Cookie'] = cookieHeader;
    } catch {
      // 取不到 cookie（如 context 已关闭）不阻断请求，仅按无登录态发出
    }
  }

  const body = action.body !== undefined ? sub(action.body) : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), action.timeoutMs);
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: action.method,
      headers,
      body: body !== undefined && action.method !== 'GET' && action.method !== 'HEAD' ? body : undefined,
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (e) {
    const durationMs = Date.now() - t0;
    clearTimeout(timer);
    if (e instanceof Error && e.name === 'AbortError') {
      throw new HttpRequestTimeout(`HTTP ${action.method} ${url} 超时（${action.timeoutMs}ms，实际 ${durationMs}ms）`);
    }
    throw new HttpRequestError(`HTTP ${action.method} ${url} 失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  clearTimeout(timer);
  const durationMs = Date.now() - t0;

  let bodyText = '';
  if (action.method !== 'HEAD') {
    try { bodyText = await res.text(); } catch (e) {
      throw new HttpRequestError(`HTTP ${action.method} ${url} 读取响应体失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const bodyTruncated = bodyText.length > BODY_MAX;
  const bodyForReport = bodyTruncated ? bodyText.slice(0, BODY_MAX) : bodyText;

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });

  const result: HttpStepResult = {
    request: {
      method: action.method,
      url,
      headers: masked(headers),
      ...(body !== undefined ? { bodyPreview: body.length > BODY_MAX ? body.slice(0, BODY_MAX) : body } : {}),
    },
    response: {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
      bodyText: bodyForReport,
      durationMs,
    },
  };

  // 断言：status 精确比对 + body 文本匹配，二者都设置则都须通过
  const a = action.assertion;
  if (a && (a.status !== undefined || a.expected !== undefined)) {
    const statusOk = a.status === undefined || res.status === a.status;
    const bodyOk = a.expected === undefined || compareBody(bodyText, a.match ?? 'contains', a.expected);
    result.assertion = {
      matched: statusOk && bodyOk,
      ...(a.status !== undefined ? { statusExpected: a.status } : {}),
      ...(a.expected !== undefined ? { match: a.match ?? 'contains', expected: a.expected } : {}),
    };
  }

  // saveAs：从响应提取变量写入 vars（返回值由 dispatch 写入 opts.vars）
  if (action.saveAs) {
    const { varName, from, path } = action.saveAs;
    let value: string;
    if (from === 'status') {
      value = String(res.status);
    } else if (path) {
      let parsed: unknown;
      try { parsed = JSON.parse(bodyText); } catch {
        throw new HttpRequestSaveAsFailed(`saveAs 失败: 响应 body 不是合法 JSON，无法按 path "${path}" 提取`);
      }
      const v = resolveDotPath(parsed, path);
      if (v === null || v === undefined) throw new HttpRequestSaveAsFailed(`saveAs path "${path}" 提取结果为空`);
      value = typeof v === 'object' ? JSON.stringify(v) : String(v);
    } else {
      value = bodyText;
    }
    result.saved = { varName, value };
  }

  return result;
}
