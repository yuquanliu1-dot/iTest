import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
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
    // later 前向引用；userId 正常消费
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
 * 传输层行为（loopback 真实 server）。
 *
 * 核心回归：undici fetch 会静默丢弃受保护头（Host 被换成连接的真实 host），安全测试用例靠
 * `Host: <注入探针>` 触发 SUT 的 4xx，探针送不出去 → 断言恒不命中、假失败
 * （prod228 报告 15dd42d9：期望 400 实际 200）。换 node:http 后受保护头原样送达。
 */
describe('runHttpRequest 传输层（node:http）', () => {
  /** 记录收到的原始头，供断言「头真的发到了服务端」。 */
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
    // 服务端收到的 host 就是注入值，不是 127.0.0.1
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
      // 不响应：触发 socket 超时
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
    // 回归点：req.setTimeout 是「空闲」超时，每个数据块都会重置计时器——
    // 服务端每 200ms 吐一点就能永远不触发，而原 AbortController 是硬墙。
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
   * 传输层失败（无 HTTP 响应）+ allowTransportFailure:true → 断言命中、步骤通过。
   *
   * 场景：SUT 在传输层拒绝伪造 Host（直接 RST 断连，curl 报 "Empty reply from server"），
   * 没有任何 HTTP 响应可断言 —— 缺省时传输失败直接抛错，绕过 assertion 判假失败。
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
