import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright-core';
import type { HttpRequestAction } from '@itest/shared';
import {
  runHttpRequest,
  resolveDotPath,
  HttpRequestSaveAsFailed,
  HttpRequestTimeout,
  HttpRequestError,
} from '../src/execute/httpRequest.js';
import { buildVariableReport } from '../src/lib/variable-report.js';
import type { StepAction } from '@itest/shared';

describe('resolveDotPath', () => {
  const data = { data: { items: [{ id: 'a1' }, { id: 'a2' }], total: 2 }, meta: null };

  it('解析嵌套对象与数组下标', () => {
    expect(resolveDotPath(data, 'data.items[0].id')).toBe('a1');
    expect(resolveDotPath(data, 'data.items[1].id')).toBe('a2');
    expect(resolveDotPath(data, 'data.total')).toBe(2);
  });

  it('路径缺失/类型不符抛 HttpRequestSaveAsFailed', () => {
    expect(() => resolveDotPath(data, 'data.missing.deep')).toThrow(HttpRequestSaveAsFailed);
    expect(() => resolveDotPath(data, 'data.items[5].id')).toThrow(HttpRequestSaveAsFailed);
    expect(() => resolveDotPath(data, 'data.items.id')).toThrow(HttpRequestSaveAsFailed);
    expect(() => resolveDotPath(data, '')).toThrow(HttpRequestSaveAsFailed);
  });
});

describe('buildVariableReport × httpRequest', () => {
  it('saveAs 定义变量、url/body/断言引用变量；前向引用被检出', () => {
    const steps: StepAction[] = [
      { kind: 'httpRequest', method: 'GET', url: '{{apiBase}}/users', headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }], timeoutMs: 10000, saveAs: { varName: 'userId', from: 'body', path: 'data.id' } },
      { kind: 'navigate', url: 'https://x.test/detail?u={{userId}}' },
      { kind: 'fill', locator: [{ strategy: 'css', value: '#q' }], value: '{{userId}}' },
      { kind: 'httpRequest', method: 'POST', url: 'https://x.test/o', headers: [], body: '{"uid":"{{userId}}","ref":"{{later}}"}', timeoutMs: 10000 },
      { kind: 'extract', locator: [{ strategy: 'css', value: '#q' }], varName: 'later', mode: 'completeValue' },
    ];
    const report = buildVariableReport(steps, ['apiBase', 'token']);
    // later is a forward reference; userId is consumed normally
    expect(report.forwardRefs.map((f) => f.name)).toEqual(['later']);
    expect(report.undefined).toEqual([]);
    expect(report.duplicates).toEqual([]);
  });

  it('未定义变量（无初始变量）报 undefined', () => {
    const steps: StepAction[] = [
      { kind: 'httpRequest', method: 'GET', url: '{{apiBase}}/x', headers: [], timeoutMs: 10000 },
    ];
    const report = buildVariableReport(steps);
    expect(report.undefined.map((u) => u.name)).toEqual(['apiBase']);
  });
});

/**
 * Transport-layer behavior (loopback real server).
 *
 * Core regression: undici fetch silently drops protected headers (Host gets replaced by the connection's real host); security test cases rely on
 * `Host: <injection probe>` to trigger the SUT's 4xx — the probe never goes out → assertion never matches, false failure
 * (prod228 report 15dd42d9: expected 400, got 200). After switching to node:http, protected headers are delivered verbatim.
 */
describe('runHttpRequest 传输层（node:http）', () => {
  /** Records the raw headers received, for asserting "the headers really reached the server". */
  let seen: { raw: string[]; method: string; body: string } | null = null;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen = { raw: req.rawHeaders, method: req.method ?? '', body: Buffer.concat(chunks).toString('utf8') };
        const url = req.url ?? '/';
        if (url === '/gzip') {
          res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
          res.end(zlib.gzipSync(Buffer.from('GZIPPED-BODY')));
          return;
        }
        if (url === '/multi-cookie') {
          res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('ok');
          return;
        }
        if (url === '/status400') {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('rejected');
          return;
        }
        if (url === '/json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: { id: 'a1' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const stubPage = { context: () => ({ cookies: async () => [] }) } as unknown as Page;

  function action(partial: Partial<HttpRequestAction> & { url: string }): HttpRequestAction {
    return {
      kind: 'httpRequest',
      method: 'GET',
      headers: [],
      timeoutMs: 5000,
      ...partial,
    } as HttpRequestAction;
  }

  it('Host 头原样送达服务端（fetch 会被静默丢弃）', async () => {
    const r = await runHttpRequest({
      action: action({ url: `${base}/`, headers: [{ key: 'Host', value: "' OR '1'='1" }] }),
      page: stubPage,
      vars: {},
    });
    // The host the server received is the injected value, not 127.0.0.1
    const hostIdx = seen!.raw.findIndex((h) => h.toLowerCase() === 'host');
    expect(seen!.raw[hostIdx + 1]).toBe("' OR '1'='1");
    expect(r.response.status).toBe(200);
  });

  it('未显式指定时补齐 undici 默认头（存量用例的内容协商行为不变）', async () => {
    await runHttpRequest({ action: action({ url: `${base}/` }), page: stubPage, vars: {} });
    const lower = seen!.raw.map((h) => h.toLowerCase());
    expect(lower).toContain('accept');
    expect(lower).toContain('accept-encoding');
    expect(lower).toContain('user-agent');
  });

  it('用户显式写的头覆盖同名默认头', async () => {
    await runHttpRequest({
      action: action({ url: `${base}/`, headers: [{ key: 'Accept', value: 'application/json' }] }),
      page: stubPage,
      vars: {},
    });
    const acceptIdx = seen!.raw.findIndex((h) => h.toLowerCase() === 'accept');
    expect(seen!.raw[acceptIdx + 1]).toBe('application/json');
  });

  it('gzip 响应体解压为明文（断言作用于明文）', async () => {
    const r = await runHttpRequest({ action: action({ url: `${base}/gzip` }), page: stubPage, vars: {} });
    expect(r.response.bodyText).toBe('GZIPPED-BODY');
  });

  it('多值 set-cookie 摊平成字符串形态', async () => {
    const r = await runHttpRequest({ action: action({ url: `${base}/multi-cookie` }), page: stubPage, vars: {} });
    expect(r.response.headers['set-cookie']).toBe('a=1; Path=/, b=2; Path=/');
  });

  it('status 断言不命中时 assertion.matched=false 且状态码照实返回', async () => {
    const r = await runHttpRequest({
      action: action({ url: `${base}/status400`, assertion: { status: 200, match: 'contains', expected: 'ok' } }),
      page: stubPage,
      vars: {},
    });
    expect(r.response.status).toBe(400);
    expect(r.assertion?.matched).toBe(false);
    expect(r.assertion?.statusExpected).toBe(200);
  });

  it('status 断言命中', async () => {
    const r = await runHttpRequest({
      action: action({ url: `${base}/status400`, assertion: { status: 400, match: 'contains', expected: 'rejected' } }),
      page: stubPage,
      vars: {},
    });
    expect(r.assertion?.matched).toBe(true);
  });

  it('POST 请求体按 content-length 送达', async () => {
    await runHttpRequest({
      action: action({ method: 'POST', url: `${base}/`, body: '{"a":1}' }),
      page: stubPage,
      vars: {},
    });
    expect(seen!.method).toBe('POST');
    expect(seen!.body).toBe('{"a":1}');
  });

  it('saveAs 从 JSON body 按 path 提取', async () => {
    const r = await runHttpRequest({
      action: action({ url: `${base}/json`, saveAs: { varName: 'userId', from: 'body', path: 'data.id' } }),
      page: stubPage,
      vars: {},
    });
    expect(r.saved).toEqual({ varName: 'userId', value: 'a1' });
  });

  it('连接被拒归为 HttpRequestError', async () => {
    await expect(
      runHttpRequest({ action: action({ url: 'http://127.0.0.1:1/' }), page: stubPage, vars: {} }),
    ).rejects.toBeInstanceOf(HttpRequestError);
  });

  it('超时归为 HttpRequestTimeout', async () => {
    const slow = http.createServer(() => {
      // No response: triggers the socket timeout
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/`;
    try {
      await expect(
        runHttpRequest({ action: action({ url: slowUrl, timeoutMs: 1000 }), page: stubPage, vars: {} }),
      ).rejects.toBeInstanceOf(HttpRequestTimeout);
    } finally {
      slow.closeAllConnections?.();
      await new Promise<void>((r) => slow.close(() => r()));
    }
  });

  it('总时长预算：服务端持续慢速吐 body 也会超时（socket 空闲超时不适用）', async () => {
    // Regression point: req.setTimeout is an "idle" timeout, reset by every data chunk —
    // a server dribbling a byte every 200ms would never trigger it, whereas the original AbortController was a hard wall.
    const dribble = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const t = setInterval(() => res.write('x'), 200);
      res.on('close', () => clearInterval(t));
    });
    await new Promise<void>((r) => dribble.listen(0, '127.0.0.1', r));
    const dribbleUrl = `http://127.0.0.1:${(dribble.address() as AddressInfo).port}/`;
    try {
      await expect(
        runHttpRequest({ action: action({ url: dribbleUrl, timeoutMs: 1000 }), page: stubPage, vars: {} }),
      ).rejects.toBeInstanceOf(HttpRequestTimeout);
    } finally {
      dribble.closeAllConnections?.();
      await new Promise<void>((r) => dribble.close(() => r()));
    }
  });

  it('notContains 匹配：响应体不含期望串时命中', async () => {
    const r = await runHttpRequest({
      action: action({ url: `${base}/`, assertion: { match: 'notContains', expected: '<script>' } }),
      page: stubPage,
      vars: {},
    });
    expect(r.assertion?.matched).toBe(true);
  });

  it('notContains 匹配：响应体含期望串时不命中', async () => {
    const r = await runHttpRequest({
      action: action({ url: `${base}/`, assertion: { match: 'notContains', expected: 'ok' } }),
      page: stubPage,
      vars: {},
    });
    expect(r.assertion?.matched).toBe(false);
  });

  /**
   * Transport-layer failure (no HTTP response) + allowTransportFailure:true → assertion matches, step passes.
   *
   * Scenario: the SUT rejects the forged Host at the transport layer (RST disconnect directly; curl reports "Empty reply from server"),
   * leaving no HTTP response to assert — by default a transport failure throws directly, bypassing the assertion and producing a false failure.
   */
  it('allowTransportFailure：传输层失败时断言命中、不抛错、记录失败原因', async () => {
    const rst = http.createServer((_req, res) => {
      res.socket?.destroy();
    });
    await new Promise<void>((r) => rst.listen(0, '127.0.0.1', r));
    const rstUrl = `http://127.0.0.1:${(rst.address() as AddressInfo).port}/`;
    try {
      const r = await runHttpRequest({
        action: action({ url: rstUrl, assertion: { allowTransportFailure: true } }),
        page: stubPage,
        vars: {},
      });
      expect(r.assertion?.matched).toBe(true);
      expect(r.response).toBeUndefined();
      expect(r.transportFailure).toBeTruthy();
    } finally {
      rst.closeAllConnections?.();
      await new Promise<void>((r) => rst.close(() => r()));
    }
  });

  it('allowTransportFailure：未开启时传输层失败仍抛 HttpRequestError', async () => {
    await expect(
      runHttpRequest({ action: action({ url: 'http://127.0.0.1:1/' }), page: stubPage, vars: {} }),
    ).rejects.toBeInstanceOf(HttpRequestError);
  });
});

/**
 * Self-signed certificates (https).
 *
 * Regression point: the browser path already allows self-signed certs (cdp.ts sets ignoreHTTPSErrors: true when building the context),
 * while node:https validates the chain by default → the same SUT is reachable from the browser but httpRequest steps fail 100% of the time
 * (ERR DEPTH_ZERO_SELF_SIGNED_CERT). Self-signed https is extremely common in intranet test environments.
 */
describe('runHttpRequest 自签证书（https）', () => {
  // Fixed self-signed cert/private key (CN=127.0.0.1, SAN includes IP:127.0.0.1). Test-only; not any real credential.
  const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDBj5X6FiK0WeKy
+KdV3X4fePDC/grllza6c74sihbaf5I0ucz2cHfQg3MHftbA6XF9wmOe2f1dxyEn
7DfKubZCyY5yMOe9UL9vXcTMBmR52mtahiUlTJgh3XUwarny9KHlfcdsFsDmGjTn
2kWWnU/+6sBKB5N3R+gjWgMWgZTi6O9+jiACbB7h52JIqvf/4WJjxd3XyfNTkZsb
qn8jD/9JVYktUKSrqEM5XnunrhKw/7EEtKxQ1R2qg0zFX9pavgX1EERV0R1V5A/P
lSaBaXbfSi5cGPYG09QB1LdQd6Ggtnl7vdoJDybUxCFTbIQyVErnj5qDwSXE00Qc
BL5pd/TxAgMBAAECggEAI6CpS2oNo0K0PpsUOfLWBzb8ofeey9nEghdR1uLoB/nZ
UIkul+Hlu+SmJKgNIV8Wu74vFgsr3roLeUy6jD8YtDxjUtN7pFYbloUc9yzqC5/P
iM8OQUpS6lDYBDxw066Bqjs3nManZPNH77E2g92a3uIY2MeCNj9vFCq6TMc3P3is
nM1gFkRjtSnrVf6l5N2tLmtJxuVD327IQhZs3U+a5rZWXmge5pYR/v4JVyh/oKN1
qdUWmdOh7hlH+g4XZZnZOKBDMliwAxJyzzLR29x/JVtt6whS7SppQQqpWi51dFD1
tTqG3ipEkqUjk1//m4EGMbKt8iKrWUymYVPdE9WXkQKBgQDsRdq42wRQCG3kG9ni
xvEXUSeojGRhaHe/RWEuXzz+L8H6Yp5KB0vkrIzJY6q/zchkCRgEllZ8u5+Z0kyf
6dTSAgWU5hm23w0B1UiginHASrBqTx01m49GkrgdoED+JANyp/QIcPKwZ/K+kWov
ABe99DlKkoJhAIPKMTCGUORSLQKBgQDRuMvqpwuT/Uir/rkawBwzTVmtrrxUgi/q
NQGr2uHrNp/HppZ7sNcFCOG7qbDL2X6Zlnk6A1LEolZm4g2+UhH+x0WZ4hrhiQR4
1munlkXlBGKwaR+z0vNu8yKTmdl7bMYrF3BYVrPNOXz7RNR+a3VpF2VYTsdB+hDL
IlGyG3LcVQKBgQC/Ls8LIX3d3NQ+7iJilCPlgC+c/O0EvOmYheVbBoluDOrjVgVL
VZgdk1ngY5t41GTAPXOH0rZs+8zrRPXnt+gTfrtRftdz2AzIXPMFpMDing0eGKJE
DHnk2zfMES5F9pIrpqeaZPqbr6EGftfy7BpKBGKPavnA0A/T/fWL2czGiQKBgQCA
IU80hepk+BI2QuIEneqczV1E58TYPNHZXZkvzgLJGg50hCrcVyaHRO3lIb+KS881
NuHJt84RpLz1Dpcm+C1WY5j6c1HJCVVaHmaXdRAu44cIELH1w6RG3PT7CLv+1G4e
VaulzRL9B2p8eYj5091f35NjaH4EqSspcEZJcsuyIQKBgD1Avn5haVqRq8cwS81V
NsSnQFS8AD+DBBbg7PU5Un0LNaKxv0lFmhPtSbWzAIC9lfIkd43O3Po0fNiuANKs
tQHrosdHYolxlzEEifR7rC50v1fRNfFjGT3AByWAGXBHEz0yPGXY0F3itH2kmChR
rJvc0B63wf6d7Txgkl/03MXJ
-----END PRIVATE KEY-----`;
  const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIICwDCCAaigAwIBAgIJAOSbPIsUPqvgMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCTEyNy4wLjAuMTAgFw0yNjEwMjgxNTI3MjJaGA8yMTI2MTAwNDE1MjcyMlow
FDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB
CgKCAQEAwY+V+hYitFnisvinVd1+H3jwwv4K5Zc2unO+LIoW2n+SNLnM9nB30INz
B37WwOlxfcJjntn9XcchJ+w3yrm2QsmOcjDnvVC/b13EzAZkedprWoYlJUyYId11
MGq58vSh5X3HbBbA5ho059pFlp1P/urASgeTd0foI1oDFoGU4ujvfo4gAmwe4edi
SKr3/+FiY8Xd18nzU5GbG6p/Iw//SVWJLVCkq6hDOV57p64SsP+xBLSsUNUdqoNM
xV/aWr4F9RBEVdEdVeQPz5UmgWl230ouXBj2BtPUAdS3UHehoLZ5e73aCQ8m1MQh
U2yEMlRK54+ag8ElxNNEHAS+aXf08QIDAQABoxMwETAPBgNVHREECDAGhwR/AAAB
MA0GCSqGSIb3DQEBCwUAA4IBAQAmIT8ewof2nO88808z/QZp1yR+J+hroXDy+sOx
C0O2QyUs+Gx9GalO7Kw8Ab9OiJ7rHSd28CvWe4EDoyh7fWResM9XkB0z7md5x3iA
Wy743QjaDebxpLC5CiSbaXWJSMs1s8UlGhRXJjzAtrqWvI1Fxt5mD5XubVtsO/Sk
9tzygnHtQ3A8Sok7Xi3VR+x6c8yJVqNu5W6gJWoknWeXp6tRIv0J8Ix/SfMX+YYK
ETF1lPaHlpK4yHot7q4uh7LdMfqNauJxB4/+nuik2xFXDYkzoobt8ZbV0LqEFKSd
QKbP5/Ixifd5GFrXIN0dKgI4RFBD01Gs8HvFwwl136BCVdMG
-----END CERTIFICATE-----`;

  const stubPage = { context: () => ({ cookies: async () => [] }) } as unknown as Page;
  let server: https.Server;
  let base: string;

  beforeAll(async () => {
    server = https.createServer(
      { key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      },
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('自签证书的 https 被测系统照常请求成功（与浏览器路径 ignoreHTTPSErrors 对齐）', async () => {
    const r = await runHttpRequest({
      action: {
        kind: 'httpRequest',
        method: 'GET',
        url: `${base}/`,
        headers: [],
        timeoutMs: 5000,
      } as HttpRequestAction,
      page: stubPage,
      vars: {},
    });
    expect(r.response.status).toBe(200);
    expect(r.response.bodyText).toBe('ok');
  });
});
