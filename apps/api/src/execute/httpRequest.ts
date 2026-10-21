import type { HttpRequestAction, DbAssertionMatch, HttpStepResult } from '@itest/shared';
import { substituteVars } from '@itest/shared';
import type { Page } from 'playwright-core';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

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

/**
 * undici fetch 默认发送的请求头（实测抓 raw headers 得到）。node:http 只发 Host+Connection，
 * 直接换客户端会让依赖 Accept / Accept-Encoding 内容协商的被测接口返回 HTML 而非 JSON，
 * 存量 httpRequest 用例会静默回归。用户在 DSL 里显式写了同名头时不覆盖（显式优先）。
 * Host/Connection 由 node:http 自行推导且可被用户覆盖，不在此列。
 */
const DEFAULT_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  accept: '*/*',
  'accept-language': '*',
  'sec-fetch-mode': 'cors',
  'user-agent': 'node',
  'accept-encoding': 'gzip, deflate',
};

interface RawResponse {
  status: number;
  statusText: string;
  /** node:http 的多值头是数组（set-cookie 等），这里原样保留。 */
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** 解压响应体：node:http 不自动解，fetch 会。保持「断言作用于明文 body」的既有语义。
 *  deflate 先按 zlib 包装试、失败再按裸 deflate 试（部分服务端发裸流）。 */
function decompress(buf: Buffer, encoding: string | undefined): string {
  const enc = (encoding ?? '').toLowerCase();
  if (enc === '' || enc === 'identity') return buf.toString('utf8');
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf).toString('utf8');
  if (enc === 'deflate') {
    try {
      return zlib.inflateSync(buf).toString('utf8');
    } catch {
      return zlib.inflateRawSync(buf).toString('utf8');
    }
  }
  if (enc === 'br') return zlib.brotliDecompressSync(buf).toString('utf8');
  // 未知编码（zstd 等）：node:zlib 不支持，原样返回字节的 utf8 视图，交由断言判定不匹配。
  return buf.toString('utf8');
}

/**
 * 底层请求：node:http / node:https 直发。
 *
 * 为什么不用 fetch（2026-10-22）：undici 会静默丢弃受保护头——Host 被替换成连接的真实 host，
 * Connection / Transfer-Encoding / Keep-Alive 直接抛 "invalid xxx header"。安全测试用例靠
 * `Host: <注入探针>` 触发 SUT 的 4xx，探针根本送不出去 → 断言恒不命中、假失败
 * （prod228 报告 15dd42d9：期望 400 实际 200 + SPA 外壳页）。node:http 原样透传这些头。
 *
 * redirect：node:http 本就不跟随重定向，与 fetch 的 redirect:'manual' 语义一致。
 */
function rawRequest(opts: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}): Promise<RawResponse> {
  const u = new URL(opts.url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise<RawResponse>((resolve, reject) => {
    // 总时长预算：从建连开始计时，覆盖「建连 + 等响应头 + 读 body」全程。
    // 不能用 req.setTimeout——那是 socket 空闲超时（每个数据块都会重置计时器），
    // 服务端持续慢慢吐数据时它永不触发，而原 AbortController 是硬墙。
    // 与 fetch 的 abort_signal 语义对齐：到点即判超时，不等 body。
    // 计时器句柄放在 state 上（而非 let 变量）：settle 闭包要读它，
    // 但定时器在 request 建好之后才创建，用 let 会踩 TDZ。
    const state: { timer?: NodeJS.Timeout } = {};
    const settle = <T>(fn: (v: T) => void) => (v: T) => {
      if (state.timer) clearTimeout(state.timer);
      fn(v);
    };
    const done = settle(resolve);
    const fail = settle(reject);

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        // path 只取 pathname+search，避免把 hash 带上；URL 编码已由 URL 规范化。
        path: `${u.pathname}${u.search}`,
        method: opts.method,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            done({
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              headers: res.headers,
              body: decompress(Buffer.concat(chunks), res.headers['content-encoding']),
            });
          } catch (e) {
            fail(e instanceof Error ? e : new Error(String(e)));
          }
        });
        res.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));
      },
    );
    state.timer = setTimeout(() => {
      req.destroy();
      // 已 resolve/reject 过则 fail 无副作用（promise 吞掉第二次 settle）。
      reject(new RawTimeout());
    }, opts.timeoutMs);
    req.on('error', fail);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** 超时哨兵：node 的 socket 超时不带可辨识标记，用独立类让调用方与网络错误区分开。 */
class RawTimeout extends Error {
  constructor() { super('timeout'); this.name = 'RawTimeout'; }
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

  // 未显式指定的默认头按 undici 原样补齐（见 DEFAULT_REQUEST_HEADERS 注释）。
  // 用户显式写的头优先：默认头都是小写，故把用户头一律降为小写覆盖默认
  // （node:http 按 key 名字匹配，小写 host / connection 同样被认并原样透传）。
  const sendHeaders: Record<string, string> = { ...DEFAULT_REQUEST_HEADERS };
  for (const [k, v] of Object.entries(headers)) {
    sendHeaders[k.toLowerCase()] = v;
  }
  if (body !== undefined && !Object.keys(sendHeaders).some((k) => k.toLowerCase() === 'content-length')) {
    sendHeaders['content-length'] = String(Buffer.byteLength(body));
  }

  const t0 = Date.now();
  let raw: RawResponse;
  try {
    raw = await rawRequest({
      url,
      method: action.method,
      headers: sendHeaders,
      ...(body !== undefined && action.method !== 'GET' && action.method !== 'HEAD' ? { body } : {}),
      timeoutMs: action.timeoutMs,
    });
  } catch (e) {
    const durationMs = Date.now() - t0;
    if (e instanceof RawTimeout) {
      throw new HttpRequestTimeout(`HTTP ${action.method} ${url} 超时（${action.timeoutMs}ms，实际 ${durationMs}ms）`);
    }
    throw new HttpRequestError(`HTTP ${action.method} ${url} 失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  const durationMs = Date.now() - t0;

  const bodyText = action.method === 'HEAD' ? '' : raw.body;
  const bodyTruncated = bodyText.length > BODY_MAX;
  const bodyForReport = bodyTruncated ? bodyText.slice(0, BODY_MAX) : bodyText;

  // node 的多值头（set-cookie 等）是数组；摊平成与 fetch 一致的字符串形态，
  // 多值以 ", " 连接（与 undici Headers.forEach 行为相同）。
  const responseHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.headers)) {
    if (v === undefined) continue;
    responseHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
  }

  const result: HttpStepResult = {
    request: {
      method: action.method,
      url,
      headers: masked(headers),
      ...(body !== undefined ? { bodyPreview: body.length > BODY_MAX ? body.slice(0, BODY_MAX) : body } : {}),
    },
    response: {
      status: raw.status,
      statusText: raw.statusText,
      headers: responseHeaders,
      bodyText: bodyForReport,
      durationMs,
    },
  };

  // 断言：status 精确比对 + body 文本匹配，二者都设置则都须通过
  const a = action.assertion;
  if (a && (a.status !== undefined || a.expected !== undefined)) {
    const statusOk = a.status === undefined || raw.status === a.status;
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
      value = String(raw.status);
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
