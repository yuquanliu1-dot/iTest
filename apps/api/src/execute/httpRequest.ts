import type { HttpRequestAction, HttpBodyMatch, HttpStepResult } from '@itest/shared';
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

/** For report display: masks sensitive values in request headers. */
const SENSITIVE_HEADER_RE = /^(authorization|cookie)$/i;
const MASK = '***';
const BODY_MAX = 64 * 1024;

function masked(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SENSITIVE_HEADER_RE.test(k) ? MASK : v;
  return out;
}

/** Simplified dot-path parsing: `a.b[0].c` (quotes/escapes unsupported; anything beyond throws). */
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

function compareBody(bodyText: string, match: HttpBodyMatch, expected: string): boolean {
  if (match === 'equals') return bodyText === expected;
  if (match === 'contains') return bodyText.includes(expected);
  if (match === 'notContains') return !bodyText.includes(expected);
  if (match === 'regex') {
    try { return new RegExp(expected).test(bodyText); } catch { return false; }
  }
  return false;
}

/**
 * The request headers undici fetch sends by default (captured from raw headers in a live probe). node:http sends only Host+Connection,
 * so swapping the client outright would make SUT endpoints relying on Accept / Accept-Encoding content negotiation return HTML instead of JSON,
 * silently regressing existing httpRequest cases. When the user explicitly wrote a same-named header in the DSL, it is not overridden (explicit wins).
 * Host/Connection are derived by node:http itself and can be overridden by the user, so they are not in this list.
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
  /** node:http's multi-value headers are arrays (set-cookie etc.); kept as-is here. */
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Decompresses the response body: node:http doesn't do it automatically, fetch does. Preserves the existing「断言作用于明文 body」semantics.
 *  deflate first tries the zlib wrapper, then falls back to raw deflate on failure (some servers send the bare stream). */
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
  // Unknown encoding (zstd etc.): node:zlib doesn't support it; return a utf8 view of the raw bytes and let the assertion judge it a mismatch.
  return buf.toString('utf8');
}

/**
 * The low-level request: node:http / node:https direct send.
 *
 * Why not fetch (2026-10-22): undici silently drops protected headers — Host gets replaced with the connection's real host,
 * and Connection / Transfer-Encoding / Keep-Alive throw "invalid xxx header" outright. Security test cases rely on
 * `Host: <注入探针>` to trigger the SUT's 4xx; the probe simply never goes out → assertion never matches, false failure
 * (prod228 report 15dd42d9: expected 400, got 200 + SPA shell page). node:http passes these headers through verbatim.
 *
 * redirect: node:http never follows redirects anyway, same semantics as fetch's redirect:'manual'.
 *
 * Self-signed certs: SUTs commonly use self-signed https (ubiquitous in intranet test environments), and the browser path already allows them
 * (cdp.ts builds the context with ignoreHTTPSErrors: true). node:https validates the cert chain by default —
 * a self-signed cert fails outright with ERR DEPTH_ZERO_SELF_SIGNED_CERT — the same SUT is reachable from the browser,
 * yet the httpRequest step fails 100% of the time. So this side aligns with the browser side: skip cert chain validation.
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
    // Total wall-clock budget: timed from connection setup, covering the whole「建连 + 等响应头 + 读 body」span.
    // req.setTimeout won't do — that's a socket idle timeout (reset by every data chunk),
    // so a server trickling data continuously never triggers it, whereas the old AbortController was a hard wall.
    // Aligned with fetch's abort_signal semantics: at the deadline it's a timeout, without waiting for the body.
    // The timer handle lives on state (not a let variable): the settle closure reads it,
    // but the timer is created only after the request is built — a let would hit the TDZ.
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
        // path takes only pathname+search so the hash isn't carried along; URL encoding is already normalized by URL.
        path: `${u.pathname}${u.search}`,
        method: opts.method,
        headers: opts.headers,
        // Self-signed certs allowed (aligned with the browser path's ignoreHTTPSErrors; see the comment above).
        ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
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
      // A second fail after resolve/reject is a no-op (the promise swallows the second settle).
      reject(new RawTimeout());
    }, opts.timeoutMs);
    req.on('error', fail);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Timeout sentinel: node's socket timeout carries no distinguishable marker; a dedicated class lets callers tell it apart from network errors. */
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
      // Failing to get cookies (e.g. the context is closed) doesn't block the request; it just goes out without a login state.
    }
  }

  const body = action.body !== undefined ? sub(action.body) : undefined;

  // Default headers not explicitly specified are filled in as undici does (see the DEFAULT_REQUEST_HEADERS comment).
  // User-written headers win: default headers are all lowercase, so user headers are lowercased across the board to override them
  // (node:http matches by key name; a lowercase host / connection is recognized the same and passed through verbatim).
  const sendHeaders: Record<string, string> = { ...DEFAULT_REQUEST_HEADERS };
  for (const [k, v] of Object.entries(headers)) {
    sendHeaders[k.toLowerCase()] = v;
  }
  if (body !== undefined && !Object.keys(sendHeaders).some((k) => k.toLowerCase() === 'content-length')) {
    sendHeaders['content-length'] = String(Buffer.byteLength(body));
  }

  const t0 = Date.now();
  const requestInfo: HttpStepResult['request'] = {
    method: action.method,
    url,
    headers: masked(headers),
    ...(body !== undefined ? { bodyPreview: body.length > BODY_MAX ? body.slice(0, BODY_MAX) : body } : {}),
  };

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
    const reason = e instanceof RawTimeout
      ? `HTTP ${action.method} ${url} 超时（${action.timeoutMs}ms，实际 ${durationMs}ms）`
      : `HTTP ${action.method} ${url} 失败: ${e instanceof Error ? e.message : String(e)}`;

    // Transport-layer failures (connection refused/reset/timeout) usually leave no HTTP response to assert on.
    // Security cases expect exactly「SUT 在传输层拒绝伪造 Host」— judging the step failed here is a false failure
    // (prod228 case 4608e4f4: the SUT answered RST directly, curl (52) Empty reply from server).
    // When the assertion explicitly allows transport failure: record the failure reason + assertion matched, step passes (no response, nothing for saveAs to extract).
    if (action.assertion?.allowTransportFailure) {
      return {
        request: requestInfo,
        transportFailure: reason,
        assertion: { matched: true },
      };
    }
    if (e instanceof RawTimeout) throw new HttpRequestTimeout(reason);
    throw new HttpRequestError(reason);
  }
  const durationMs = Date.now() - t0;

  const bodyText = action.method === 'HEAD' ? '' : raw.body;
  const bodyTruncated = bodyText.length > BODY_MAX;
  const bodyForReport = bodyTruncated ? bodyText.slice(0, BODY_MAX) : bodyText;

  // node's multi-value headers (set-cookie etc.) are arrays; flattened into the same string shape as fetch,
  // multiple values joined with ", " (same behavior as undici Headers.forEach).
  const responseHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.headers)) {
    if (v === undefined) continue;
    responseHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
  }

  const result: HttpStepResult = {
    request: requestInfo,
    response: {
      status: raw.status,
      statusText: raw.statusText,
      headers: responseHeaders,
      bodyText: bodyForReport,
      durationMs,
    },
  };

  // Assertion: status exact comparison + body text match; when both are set, both must pass
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

  // saveAs: extracts a variable from the response into vars (the return value is written into opts.vars by dispatch)
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
