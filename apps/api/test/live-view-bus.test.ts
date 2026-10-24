import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * liveViewBus 单元测试。真实 Redis 不在单测范围（prod228 冒烟覆盖）：
 * - 信封编解码：纯函数 round-trip / 非法输入；
 * - REDIS_URL 缺失：全部原语 no-op（本地 dev 与既有 live-view.test.ts 的运行前提）；
 * - vi.doMock('ioredis')：模拟 pub/sub 连接，验证发布参数与 messageBuffer 分发/订阅记账。
 */
import {
  encodeEvent,
  decodeEvent,
  heartbeatSet,
  heartbeatClear,
  publishFrame,
  publishEnd,
  appendRecording,
  expireRecording,
  clearRecording,
  remoteSourceAlive,
  readRemoteRecording,
  remoteRecordingInfo,
  subscribeMirror,
  viewersIncr,
  viewersDecr,
  viewersTouch,
  viewersGet,
  VIEWERS_TTL_MS,
  EV_FRAME,
  EV_END,
  MAX_REC_FRAMES,
  REC_TTL_MS,
} from '../src/execute/liveViewBus.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('信封编解码', () => {
  it('帧 round-trip：type/ts/jpeg 字节保真', () => {
    const ts = 1729750000123.456;
    const buf = encodeEvent(EV_FRAME, ts, JPEG);
    expect(buf.length).toBe(9 + JPEG.length);
    const ev = decodeEvent(buf)!;
    expect(ev.type).toBe(EV_FRAME);
    expect(ev.ts).toBe(ts);
    expect(ev.payload.equals(JPEG)).toBe(true);
  });

  it('end 信封无 payload；空 payload 帧也合法', () => {
    const end = decodeEvent(encodeEvent(EV_END, 42))!;
    expect(end.type).toBe(EV_END);
    expect(end.ts).toBe(42);
    expect(end.payload.length).toBe(0);
    const empty = decodeEvent(encodeEvent(EV_FRAME, 1, Buffer.alloc(0)))!;
    expect(empty.type).toBe(EV_FRAME);
    expect(empty.payload.length).toBe(0);
  });

  it('非法输入 → null：截断 / 未知 type / 空 buffer', () => {
    expect(decodeEvent(Buffer.alloc(8))).toBeNull();
    expect(decodeEvent(Buffer.alloc(0))).toBeNull();
    const bad = encodeEvent(EV_FRAME, 1, JPEG);
    bad.writeUInt8(0x7f, 0);
    expect(decodeEvent(bad)).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: 故意喂非 Buffer
    expect(decodeEvent(undefined as never)).toBeNull();
  });
});

describe('REDIS_URL 缺失 → 全部 no-op', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('发布/心跳/录制/观看者回写系列不抛、不建连接', () => {
    expect(() => {
      heartbeatSet('k');
      heartbeatClear('k');
      publishFrame('k', Date.now(), JPEG);
      publishEnd('k');
      appendRecording('k', Date.now(), JPEG);
      expireRecording('k');
      clearRecording('k');
      viewersIncr('k');
      viewersDecr('k');
      viewersTouch('k');
    }).not.toThrow();
  });

  it('读取系列返回空值：remoteSourceAlive=false / readRemoteRecording=[] / remoteRecordingInfo=null / viewersGet=0', async () => {
    await expect(remoteSourceAlive('k')).resolves.toBe(false);
    await expect(readRemoteRecording('k')).resolves.toEqual([]);
    await expect(remoteRecordingInfo('k')).resolves.toBeNull();
    await expect(viewersGet('k')).resolves.toBe(0);
  });

  it('subscribeMirror 退订函数可调（无连接、无异常）', () => {
    const unsub = subscribeMirror('k', { onFrame: () => {}, onEnd: () => {} });
    expect(() => unsub()).not.toThrow();
  });
});

// ── mock ioredis：按本模块用到的最小命令集模拟 ─────────────────────────────────

interface FakeCall {
  cmd: string;
  args: unknown[];
}

class FakeRedis {
  static all: FakeRedis[] = [];
  listeners: Record<string, Array<(...args: never[]) => void>> = {};
  calls: FakeCall[] = [];
  /** 按命令名固定返回值（缺省 null）；Error 实例 → reject（测 catch 路径）。 */
  results: Record<string, unknown> = {};
  pipelineOps: FakeCall[] = [];
  constructor() {
    FakeRedis.all.push(this);
  }
  on(evt: string, cb: (...args: never[]) => void) {
    (this.listeners[evt] ??= []).push(cb);
    return this;
  }
  emit(evt: string, ...args: unknown[]) {
    for (const cb of [...(this.listeners[evt] ?? [])]) (cb as (...a: unknown[]) => void)(...args);
  }
  private exec(cmd: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ cmd, args });
    const v = this.results[cmd];
    if (v instanceof Error) return Promise.reject(v);
    return Promise.resolve(v ?? null);
  }
  set(...args: unknown[]) { return this.exec('set', ...args); }
  del(...args: unknown[]) { return this.exec('del', ...args); }
  exists(...args: unknown[]) { return this.exec('exists', ...args); }
  publish(...args: unknown[]) { return this.exec('publish', ...args); }
  incr(...args: unknown[]) { return this.exec('incr', ...args); }
  decr(...args: unknown[]) { return this.exec('decr', ...args); }
  get(...args: unknown[]) { return this.exec('get', ...args); }
  llen(...args: unknown[]) { return this.exec('llen', ...args); }
  pexpire(...args: unknown[]) { return this.exec('pexpire', ...args); }
  pttl(...args: unknown[]) { return this.exec('pttl', ...args); }
  lrangeBuffer(...args: unknown[]) { return this.exec('lrangeBuffer', ...args); }
  subscribe(...args: unknown[]) { return this.exec('subscribe', ...args); }
  unsubscribe(...args: unknown[]) { return this.exec('unsubscribe', ...args); }
  pipeline() {
    const ops = this.pipelineOps;
    const api = {
      rpush: (...args: unknown[]) => { ops.push({ cmd: 'rpush', args }); return api; },
      ltrim: (...args: unknown[]) => { ops.push({ cmd: 'ltrim', args }); return api; },
      pexpire: (...args: unknown[]) => { ops.push({ cmd: 'pexpire', args }); return api; },
      incr: (...args: unknown[]) => { ops.push({ cmd: 'incr', args }); return api; },
      exec: async () => {
        this.calls.push({ cmd: 'pipeline.exec', args: [...ops] });
        return [] as unknown[];
      },
    };
    return api;
  }
  callsOf(cmd: string): FakeCall[] {
    return this.calls.filter((c) => c.cmd === cmd);
  }
}

/** 动态载入挂了 fake ioredis 的全新 bus 模块（连接状态随模块重置）。 */
async function freshBusWithFakeRedis() {
  vi.resetModules();
  FakeRedis.all = [];
  vi.doMock('ioredis', () => ({ default: FakeRedis }));
  return import('../src/execute/liveViewBus.js');
}

describe('源侧发布（mock ioredis）', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://localhost:6379';
  });
  afterEach(() => {
    delete process.env.REDIS_URL;
    vi.doUnmock('ioredis');
    vi.restoreAllMocks();
  });

  it('heartbeatSet/Clear：键名与 PX 参数正确（普通连接承载发布+读）', async () => {
    const bus = await freshBusWithFakeRedis();
    bus.heartbeatSet('planrun:1');
    bus.heartbeatClear('planrun:1');
    const pub = FakeRedis.all[0]!;
    expect(pub).toBeDefined();
    expect(pub.callsOf('set')[0]).toEqual({ cmd: 'set', args: ['itest:live-active:planrun:1', '1', 'PX', 10_000] });
    expect(pub.callsOf('del')[0]).toEqual({ cmd: 'del', args: ['itest:live-active:planrun:1'] });
  });

  it('publishFrame/End：信封字节可解码回原帧；appendRecording 走 pipeline（rpush/ltrim/pexpire）', async () => {
    const bus = await freshBusWithFakeRedis();
    const ts = 1729750000123.456;
    bus.publishFrame('case:2', ts, JPEG);
    bus.publishEnd('case:2');
    const pub = FakeRedis.all[0]!;
    const frameMsg = pub.callsOf('publish')[0]!.args[1] as Buffer;
    const ev = decodeEvent(frameMsg)!;
    expect(ev.type).toBe(EV_FRAME);
    expect(ev.ts).toBe(ts);
    expect(ev.payload.equals(JPEG)).toBe(true);
    const endMsg = pub.callsOf('publish')[1]!.args[1] as Buffer;
    expect(decodeEvent(endMsg)!.type).toBe(EV_END);

    bus.appendRecording('case:2', ts, JPEG);
    // fake 的 pipeline.exec 把 ops 展开进 args（args 即操作列表）
    const pipe = pub.callsOf('pipeline.exec')[0]!.args as unknown as FakeCall[];
    expect(pipe.map((o) => o.cmd)).toEqual(['rpush', 'ltrim', 'pexpire']);
    expect(pipe[0]!.args[0]).toBe('itest:live-rec:case:2');
    expect(decodeEvent(pipe[0]!.args[1] as Buffer)!.payload.equals(JPEG)).toBe(true);
    expect(pipe[1]!.args).toEqual(['itest:live-rec:case:2', -MAX_REC_FRAMES, -1]);
    expect(pipe[2]!.args).toEqual(['itest:live-rec:case:2', REC_TTL_MS]);
    bus.expireRecording('case:2');
    bus.clearRecording('case:2');
    expect(pub.callsOf('pexpire')[0]!.args).toEqual(['itest:live-rec:case:2', REC_TTL_MS]);
    expect(pub.callsOf('del')[0]!.args).toEqual(['itest:live-rec:case:2']);
  });

  it('观看者回写：INCR+PEXPIRE 走 pipeline、DECR/Touch 键与 TTL 正确、GET 钳负/报错→0', async () => {
    const bus = await freshBusWithFakeRedis();
    bus.viewersIncr('k');
    const pub = FakeRedis.all[0]!;
    const pipe = pub.callsOf('pipeline.exec')[0]!.args as unknown as FakeCall[];
    expect(pipe.map((o) => o.cmd)).toEqual(['incr', 'pexpire']);
    expect(pipe[0]!.args).toEqual(['itest:live-viewers:k']);
    expect(pipe[1]!.args).toEqual(['itest:live-viewers:k', VIEWERS_TTL_MS]);

    bus.viewersDecr('k');
    expect(pub.callsOf('decr')[0]!.args).toEqual(['itest:live-viewers:k']);
    bus.viewersTouch('k');
    expect(pub.callsOf('pexpire')[0]!.args).toEqual(['itest:live-viewers:k', VIEWERS_TTL_MS]);

    pub.results.get = '3';
    await expect(bus.viewersGet('k')).resolves.toBe(3);
    pub.results.get = '-2'; // 崩溃残留：decr 越过 0 → 读取端钳 0
    await expect(bus.viewersGet('k')).resolves.toBe(0);
    pub.results.get = null;
    await expect(bus.viewersGet('k')).resolves.toBe(0);
    pub.results.get = new Error('down');
    await expect(bus.viewersGet('k')).resolves.toBe(0);
  });
});

describe('镜像侧读取与订阅（mock ioredis）', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://localhost:6379';
  });
  afterEach(() => {
    delete process.env.REDIS_URL;
    vi.doUnmock('ioredis');
    vi.restoreAllMocks();
  });

  it('remoteSourceAlive：exists>0 → true；命令报错 → false', async () => {
    const bus = await freshBusWithFakeRedis();
    void bus.remoteSourceAlive('k');
    const pub = FakeRedis.all[0]!;
    pub.results.exists = 1;
    await expect(bus.remoteSourceAlive('k')).resolves.toBe(true);
    pub.results.exists = new Error('down');
    await expect(bus.remoteSourceAlive('k')).resolves.toBe(false);
    expect(pub.callsOf('exists')[0]!.args).toEqual(['itest:live-active:k']);
  });

  it('remoteRecordingInfo：LLEN/首末帧/PTTL 汇总；空列表 → null；读取报错 → null', async () => {
    const bus = await freshBusWithFakeRedis();
    void bus.remoteRecordingInfo('k');
    const pub = FakeRedis.all[0]!;
    const env = encodeEvent(EV_FRAME, 1000, JPEG);
    pub.results.llen = 1;
    pub.results.lrangeBuffer = [env];
    pub.results.pttl = 5000;
    await expect(bus.remoteRecordingInfo('k')).resolves.toEqual({ frames: 1, firstTs: 1000, lastTs: 1000, ttlMs: 5000 });
    pub.results.llen = 0;
    await expect(bus.remoteRecordingInfo('k')).resolves.toBeNull();
    pub.results.llen = new Error('down');
    await expect(bus.remoteRecordingInfo('k')).resolves.toBeNull();
  });

  it('readRemoteRecording：只保留帧事件、按序解出 payload；报错 → []', async () => {
    const bus = await freshBusWithFakeRedis();
    void bus.readRemoteRecording('k');
    const pub = FakeRedis.all[0]!;
    pub.results.lrangeBuffer = [
      encodeEvent(EV_FRAME, 1, JPEG),
      encodeEvent(EV_END, 2),
      Buffer.from('garbage'),
    ];
    const frames = await bus.readRemoteRecording('k');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.ts).toBe(1);
    expect(frames[0]!.data.equals(JPEG)).toBe(true);
    pub.results.lrangeBuffer = new Error('down');
    await expect(bus.readRemoteRecording('k')).resolves.toEqual([]);
  });

  it('subscribeMirror：首订阅触发 SUBSCRIBE；messageBuffer 分发帧/end；非本前缀忽略', async () => {
    const bus = await freshBusWithFakeRedis();
    const got: Array<{ ts: number; jpeg: Buffer }> = [];
    let ended = 0;
    const unsub = bus.subscribeMirror('planrun:9', {
      onFrame: (ts, jpeg) => got.push({ ts, jpeg }),
      onEnd: () => ended++,
    });
    const sub = FakeRedis.all[0]!;
    expect(sub.callsOf('subscribe')[0]!.args).toEqual(['itest:live:planrun:9']);

    const chan = Buffer.from('itest:live:planrun:9');
    sub.emit('messageBuffer', chan, encodeEvent(EV_FRAME, 7, JPEG));
    expect(got).toEqual([{ ts: 7, jpeg: JPEG }]);
    sub.emit('messageBuffer', chan, encodeEvent(EV_END, 8));
    expect(ended).toBe(1);
    sub.emit('messageBuffer', Buffer.from('itest:sse:planrun:9'), encodeEvent(EV_FRAME, 9, JPEG));
    sub.emit('messageBuffer', chan, Buffer.from('junk'));
    expect(got).toHaveLength(1);
    expect(ended).toBe(1);

    unsub();
    expect(sub.callsOf('unsubscribe')[0]!.args).toEqual(['itest:live:planrun:9']);
    sub.emit('messageBuffer', chan, encodeEvent(EV_FRAME, 10, JPEG));
    expect(got).toHaveLength(1); // 退订后本地回调不再触发
  });

  it('同 key 多镜像共享一条订阅；末个离开才 UNSUBSCRIBE', async () => {
    const bus = await freshBusWithFakeRedis();
    const aFrames: number[] = [];
    const bFrames: number[] = [];
    const unsubA = bus.subscribeMirror('k', { onFrame: (ts) => aFrames.push(ts), onEnd: () => {} });
    const unsubB = bus.subscribeMirror('k', { onFrame: (ts) => bFrames.push(ts), onEnd: () => {} });
    const sub = FakeRedis.all[0]!;
    expect(sub.callsOf('subscribe')).toHaveLength(1); // 共享订阅，不重复 SUBSCRIBE

    sub.emit('messageBuffer', Buffer.from('itest:live:k'), encodeEvent(EV_FRAME, 1, JPEG));
    expect(aFrames).toEqual([1]);
    expect(bFrames).toEqual([1]);

    unsubA();
    sub.emit('messageBuffer', Buffer.from('itest:live:k'), encodeEvent(EV_FRAME, 2, JPEG));
    expect(aFrames).toEqual([1]);
    expect(bFrames).toEqual([1, 2]);
    expect(sub.callsOf('unsubscribe')).toHaveLength(0); // b 还在

    unsubB();
    expect(sub.callsOf('unsubscribe')[0]!.args).toEqual(['itest:live:k']);
    unsubA(); // 幂等
    expect(sub.callsOf('unsubscribe')).toHaveLength(1);
  });
});

// ── liveView × bus 集成（mock 整个 bus 模块，断言钩子调用与镜像 fallback）─────────

const JPEG2 = Buffer.from([0xff, 0xd8, 0xff, 0xda]);
const FRAME_HEADER = Buffer.from('--frame\r\nContent-Type: image/jpeg');

function countBytes(buf: Buffer, pat: Buffer): number {
  let n = 0;
  let i = 0;
  while ((i = buf.indexOf(pat, i)) !== -1) {
    n++;
    i += pat.length;
  }
  return n;
}

/** fake req/res（同 live-view.test.ts 的 fakeConn：捕获 writeHead/write/end 与 close 回调）。 */
function fakeConn() {
  let onClose: (() => void) | null = null;
  const chunks: Array<string | Buffer> = [];
  const res = {
    headers: null as Record<string, string> | null,
    status: 0,
    writableEnded: false,
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    write(chunk: string | Buffer) {
      chunks.push(chunk);
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) chunks.push(chunk);
      this.writableEnded = true;
    },
  };
  const req = { on: (_e: 'close', fn: () => void) => { onClose = fn; } };
  return {
    req,
    res,
    close: () => onClose?.(),
    body: () => Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c))),
    hasJpeg: () => Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c))).includes(JPEG),
  };
}

/** 动态载入挂了 spy bus 的全新 liveView 模块。redisReady 默认 true（fallback 可测），按用例覆写。 */
async function freshLiveViewWithBus() {
  vi.resetModules();
  const bus = {
    redisReady: vi.fn(() => true),
    heartbeatSet: vi.fn(),
    heartbeatClear: vi.fn(),
    publishFrame: vi.fn(),
    publishEnd: vi.fn(),
    appendRecording: vi.fn(),
    expireRecording: vi.fn(),
    clearRecording: vi.fn(),
    remoteSourceAlive: vi.fn(async () => false),
    remoteRecordingInfo: vi.fn(async () => null),
    readRemoteRecording: vi.fn(async () => [] as Array<{ ts: number; data: Buffer }>),
    subscribeMirror: vi.fn(() => () => {}),
    viewersIncr: vi.fn(),
    viewersDecr: vi.fn(),
    viewersTouch: vi.fn(),
    viewersGet: vi.fn(async () => 0),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  vi.doMock('../src/execute/liveViewBus.js', () => ({
    MAX_REC_FRAMES: 1200,
    REC_TTL_MS: 30 * 60_000,
    EV_FRAME: 0x01,
    EV_END: 0x02,
    encodeEvent: vi.fn(),
    decodeEvent: vi.fn(),
    ...bus,
  }));
  vi.doMock('../src/logger.js', () => ({ logger }));
  const mod = await import('../src/execute/liveView.js');
  return { mod, bus, logger };
}

describe('liveView × bus 集成', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../src/execute/liveViewBus.js');
    vi.doUnmock('../src/logger.js');
    vi.restoreAllMocks();
  });

  it('源侧钩子：register 清录制+心跳；fanout 发布帧；record 追加；tick 续心跳；close 发布 end+清心跳+过期录制', async () => {
    const { mod, bus } = await freshLiveViewWithBus();
    const live = mod.registerLiveView('planrun:it');
    expect(bus.clearRecording).toHaveBeenCalledWith('planrun:it');
    expect(bus.heartbeatSet).toHaveBeenCalledWith('planrun:it');

    live.setPage({ screenshot: async () => JPEG } as never); // 无 context() → screencast 静默失败走轮询
    await vi.advanceTimersByTimeAsync(1); // 首 tick：心跳 + 截图 → fanout → publishFrame + appendRecording
    expect(bus.heartbeatSet).toHaveBeenCalledWith('planrun:it');
    expect(bus.publishFrame).toHaveBeenCalledWith('planrun:it', expect.any(Number), JPEG);
    expect(bus.appendRecording).toHaveBeenCalledWith('planrun:it', expect.any(Number), JPEG);
    expect(bus.publishEnd).not.toHaveBeenCalled();

    live.close();
    expect(bus.publishEnd).toHaveBeenCalledWith('planrun:it');
    expect(bus.heartbeatClear).toHaveBeenCalledWith('planrun:it');
    expect(bus.expireRecording).toHaveBeenCalledWith('planrun:it');
  });

  it('无 REDIS_URL（redisReady=false）：本地无源 → 同步 404，不触碰桥', async () => {
    const { mod, bus } = await freshLiveViewWithBus();
    bus.redisReady.mockReturnValue(false);
    const conn = fakeConn();
    void mod.handleLiveView(conn.req, conn.res, 'nope');
    expect(conn.res.status).toBe(404); // 同步路径（无 await 插入）
    expect(bus.remoteSourceAlive).not.toHaveBeenCalled();

    const meta = fakeConn();
    void mod.handleLiveReplayMeta(meta.res as never, 'nope');
    expect(JSON.parse(meta.body().toString())).toEqual({ available: false });

    const rp = fakeConn();
    void mod.handleLiveReplay(rp.req, rp.res, 'nope');
    expect(rp.res.status).toBe(404);
    expect(bus.readRemoteRecording).not.toHaveBeenCalled();
  });

  it('镜像 live：本地无源 + 桥上心跳活着 → subscribeMirror 转发帧/end；断开退订', async () => {
    const { mod, bus } = await freshLiveViewWithBus();
    bus.remoteSourceAlive.mockResolvedValue(true);
    const unsubscribe = vi.fn();
    let handlers: { onFrame: (ts: number, jpeg: Buffer) => void; onEnd: () => void } | null = null;
    bus.subscribeMirror.mockImplementation((_key: string, h: typeof handlers) => {
      handlers = h;
      return unsubscribe;
    });
    const conn = fakeConn();
    await mod.handleLiveView(conn.req, conn.res, 'planrun:9');
    expect(conn.res.status).toBe(200);
    expect(conn.res.headers?.['Content-Type']).toBe('multipart/x-mixed-replace; boundary=frame');
    expect(conn.res.headers?.['X-Accel-Buffering']).toBe('no');
    expect(bus.subscribeMirror).toHaveBeenCalledWith('planrun:9', expect.any(Object));

    handlers!.onFrame(1, JPEG);
    expect(conn.hasJpeg()).toBe(true);
    handlers!.onEnd();
    expect(conn.res.writableEnded).toBe(true);
    conn.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('镜像观看者回写：连接即 INCR；touch ≥5s 节流；onEnd+close 只 DECR 一次并落断流日志', async () => {
    const { mod, bus, logger } = await freshLiveViewWithBus();
    bus.remoteSourceAlive.mockResolvedValue(true);
    let handlers: { onFrame: (ts: number, jpeg: Buffer) => void; onEnd: () => void } | null = null;
    bus.subscribeMirror.mockImplementation((_key: string, h: typeof handlers) => {
      handlers = h;
      return () => {};
    });
    const conn = fakeConn();
    await mod.handleLiveView(conn.req, conn.res, 'planrun:tw');
    expect(bus.viewersIncr).toHaveBeenCalledWith('planrun:tw');

    handlers!.onFrame(1, JPEG); // 首帧即 touch（lastTouchAt=0 → 立即续期一次）
    handlers!.onFrame(2, JPEG); // 紧随次帧 → 节流窗内，不再 touch
    expect(bus.viewersTouch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    handlers!.onFrame(3, JPEG); // 过窗 → 第二次 touch（长静默流计数不先行过期）
    expect(bus.viewersTouch).toHaveBeenCalledTimes(2);

    handlers!.onEnd(); // 源收尾 → finish：退订 + DECR + 日志
    conn.close(); // 正常 end 后 Node 仍触发 close → done 守卫，不得重复 DECR
    expect(bus.viewersDecr).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { key: 'planrun:tw', path: 'mirror', durationMs: expect.any(Number), bytes: JPEG.length * 3 },
      'live stream ended',
    );
  });

  it('跨副本降档治理：viewersGet→1（本地零订阅）→ 轮询切 500ms 档 + 尝试起 screencast；→0 回落 2000ms', async () => {
    const { mod, bus } = await freshLiveViewWithBus();
    let viewers = 1;
    bus.viewersGet.mockImplementation(async () => viewers);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const pollDelays = (): number[] =>
      // 轮询档只有 500/2000 两档；截图软超时的 2500ms 定时器排除在外
      setTimeoutSpy.mock.calls.map((c) => c[1] as number).filter((d) => d === 500 || d === 2000);
    const screenshot = vi.fn(async () => JPEG);
    const newCDPSession = vi.fn(async () => { throw new Error('no cdp'); });
    const live = mod.registerLiveView('it-cross');
    live.setPage({ screenshot, context: () => ({ newCDPSession }) } as never);
    await vi.advanceTimersByTimeAsync(4000); // 首 tick（2000ms 旧档）+ 若干拍：remoteViewers 已刷成 1
    expect(pollDelays()).toContain(500); // 桥上有人看 → 观看档
    expect(newCDPSession).toHaveBeenCalled(); // → screencast 尝试启动（fake 失败静默走轮询兜底）

    viewers = 0;
    await vi.advanceTimersByTimeAsync(2500); // 等 remoteViewers 刷新为 0 并完成切档
    setTimeoutSpy.mockClear();
    await vi.advanceTimersByTimeAsync(4000);
    expect(pollDelays()).not.toContain(500); // 归零后回落无人档
    expect(pollDelays()).toContain(2000);
  });

  it('本地无源 + 桥上心跳已死（remoteSourceAlive=false）→ 404', async () => {
    const { mod, bus } = await freshLiveViewWithBus();
    bus.remoteSourceAlive.mockResolvedValue(false);
    const conn = fakeConn();
    await mod.handleLiveView(conn.req, conn.res, 'planrun:9');
    expect(conn.res.status).toBe(404);
    expect(bus.subscribeMirror).not.toHaveBeenCalled();
  });

  it('镜像回放 meta：本地无录制 → remoteRecordingInfo 汇总出 available JSON', async () => {
    const { mod, bus } = await freshLiveViewWithBus();
    bus.remoteRecordingInfo.mockResolvedValue({ frames: 2, firstTs: 1000, lastTs: 3000, ttlMs: 5000 });
    const conn = fakeConn();
    await mod.handleLiveReplayMeta(conn.res as never, 'k');
    expect(conn.res.status).toBe(200);
    const body = JSON.parse(conn.body().toString()) as Record<string, unknown>;
    expect(body).toEqual({ available: true, frames: 2, durationMs: 2000, expiresAt: expect.any(Number) });
  });

  it('镜像回放：本地无录制 → readRemoteRecording 取帧按本地同款节奏播出、末帧 end', async () => {
    const { mod, bus } = await freshLiveViewWithBus();
    bus.readRemoteRecording.mockResolvedValue([
      { ts: 0, data: JPEG },
      { ts: 2000, data: JPEG2 },
    ]);
    const conn = fakeConn();
    await mod.handleLiveReplay(conn.req, conn.res, 'k');
    expect(conn.res.status).toBe(200);
    expect(conn.res.headers?.['Content-Type']).toBe('multipart/x-mixed-replace; boundary=frame');
    expect(countBytes(conn.body(), FRAME_HEADER)).toBe(1); // 首帧即出
    expect(conn.hasJpeg()).toBe(true);
    await vi.advanceTimersByTimeAsync(2600); // 帧差 2000 → 次帧 + end
    const body = conn.body();
    expect(countBytes(body, FRAME_HEADER)).toBe(2);
    expect(body.includes(JPEG2)).toBe(true);
    expect(conn.res.writableEnded).toBe(true);
  });

  it('本地有录制时优先本地：不触碰 readRemoteRecording', async () => {
    const { mod, bus } = await freshLiveViewWithBus();
    const live = mod.registerLiveView('local-rec');
    live.setPage({ screenshot: async () => JPEG } as never);
    await vi.advanceTimersByTimeAsync(1); // 录入首帧
    live.close();
    const rp = fakeConn();
    await mod.handleLiveReplay(rp.req, rp.res, 'local-rec');
    expect(rp.res.status).toBe(200);
    expect(bus.readRemoteRecording).not.toHaveBeenCalled();
  });
});
