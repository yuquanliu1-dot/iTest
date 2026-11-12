import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  registerLiveView,
  handleLiveView,
  annotateAction,
  clearAnnotation,
} from '../src/execute/liveView.js';

/** Fake playwright Page: scripted screenshot behavior (returns buffer on success / throws / hangs).
 *  liveView dependencies other than screenshot (context().newCDPSession for screencast) are uniformly mocked as unavailable → falls to the polling fallback. */
function fakePage(script: Array<(() => Promise<Buffer>) | Error | 'pending'>) {
  let i = 0;
  return {
    screenshot: async () => {
      const step = script[Math.min(i++, script.length - 1)];
      if (step === 'pending') return new Promise<Buffer>(() => {});
      if (step instanceof Error) throw step;
      return step();
    },
  };
}

/** Fake req/res: captures writeHead/write/end; req.on('close') records the callback. */
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
    chunks,
    close: () => onClose?.(),
    body: () => chunks.map((c) => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c)),
    hasJpeg: () => Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c))).includes(JPEG),
  };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const JPEG2 = Buffer.from([0xff, 0xd8, 0xff, 0xda]);
const JPEG3 = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);

/** multipart frame header (appears once per frame; used to count recording/replay frames). */
const FRAME_HEADER = Buffer.from('--frame\r\nContent-Type: image/jpeg');

/** Counts non-overlapping occurrences of pat in buf. */
function countBytes(buf: Buffer, pat: Buffer): number {
  let n = 0;
  let i = 0;
  while ((i = buf.indexOf(pat, i)) !== -1) {
    n++;
    i += pat.length;
  }
  return n;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('registerLiveView 生命周期', () => {
  it('close 后同 key 请求 404（注册表删除）', () => {
    const live = registerLiveView();
    live.close();
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    expect(conn.res.status).toBe(404);
    expect(conn.res.writableEnded).toBe(true);
  });

  it('未知 key 404', () => {
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, 'no-such-key');
    expect(conn.res.status).toBe(404);
  });

  it('重复注册同 key：旧源终结、新源接管', () => {
    const a = registerLiveView('dup');
    const b = registerLiveView('dup');
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, 'dup');
    expect(conn.res.status).toBe(200); // new source takes over
    a.close();
    expect(conn.res.writableEnded).toBe(false); // a.close does not affect b's source
    b.close();
  });
});

describe('handleLiveView MJPEG 帧泵（轮询兜底）', () => {
  it('写出 multipart 头 + 分帧（boundary/Content-Length/字节），结束带 \\r\\n', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    expect(conn.res.status).toBe(200);
    expect(conn.res.headers?.['Content-Type']).toBe('multipart/x-mixed-replace; boundary=frame');
    expect(conn.res.headers?.['X-Accel-Buffering']).toBe('no');
    await vi.advanceTimersByTimeAsync(600);
    const body = Buffer.concat(conn.body());
    const expected = Buffer.concat([
      Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\n\r\n`),
      JPEG,
      Buffer.from('\r\n'),
    ]);
    expect(body.equals(expected)).toBe(true);
    expect(conn.res.writableEnded).toBe(false); // stream stays open
    live.close();
  });

  it('多订阅 hub：同一帧扇出给所有连接；后连接回放最近一帧', async () => {
    // Takes the CDP fast path (bypasses KEEPALIVE throttling); MIN_FRAME_GAP uses real Date.now, so 210ms of real time is needed between frames
    const { page, emit } = screencastPage();
    const live = registerLiveView();
    live.setPage(page as never);
    const a = fakeConn();
    handleLiveView(a.req, a.res, live.key);
    await new Promise((r) => setTimeout(r, 10)); // flush the tryStartScreencast startup chain (including event listener registration)
    emit(Buffer.from(JPEG).toString('base64')); // frame 1
    expect(a.hasJpeg()).toBe(true);
    // Second connection: immediately replays the most recent frame (<img> not blank)
    const b = fakeConn();
    handleLiveView(b.req, b.res, live.key);
    expect(b.hasJpeg()).toBe(true);
    b.close();
    await new Promise((r) => setTimeout(r, 210));
    const frames = a.body().length;
    emit(Buffer.from(JPEG).toString('base64')); // frame 2: only a remains, still should receive it
    expect(a.body().length).toBeGreaterThan(frames); // …and frames keep advancing
    live.close();
  });

  it('截图抛错跳帧续流：坏帧不写、好帧照常写', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    // setPage ticks immediately, consuming the 1st bad frame (KEEPALIVE is constantly satisfied); t=500 consumes another; t=1000 yields a good frame
    live.setPage(fakePage([new Error('nav'), new Error('nav'), () => Promise.resolve(JPEG)]) as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    await vi.advanceTimersByTimeAsync(600); // t=500 throws → skipped
    expect(conn.chunks.length).toBe(0);
    await vi.advanceTimersByTimeAsync(500); // t=1000 succeeds
    expect(conn.hasJpeg()).toBe(true);
    expect(conn.res.writableEnded).toBe(false);
    live.close();
  });

  it('截图挂起超过单帧超时 → 跳帧，流不中断（inFlight 防并发叠截图）', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    live.setPage(fakePage(['pending', () => Promise.resolve(JPEG)]) as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    await vi.advanceTimersByTimeAsync(2400); // first frame pending: inFlight set; every tick during this period skips the frame without stacking screenshots
    expect(conn.chunks.length).toBe(0);
    // The 2500ms soft timeout lands on the same beat as the tick (timeout timer registered first → releases inFlight first) → that tick writes a frame
    await vi.advanceTimersByTimeAsync(1200);
    expect(conn.hasJpeg()).toBe(true);
    expect(conn.res.writableEnded).toBe(false);
    live.close();
  });

  it('工具 close（dead）→ 帧泵停并 res.end', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    await vi.advanceTimersByTimeAsync(600);
    live.close();
    await vi.advanceTimersByTimeAsync(1200);
    expect(conn.res.writableEnded).toBe(true);
    const frames = conn.body().length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(conn.body().length).toBe(frames); // interval cleared, no more frames produced
  });

  it('客户端断开（req close）→ 停泵（订阅移除）；torn 连接不再被 end', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    conn.close();
    await vi.advanceTimersByTimeAsync(1200);
    // v2 semantics: disconnect only removes the subscription and stops the pump; the response is not actively ended (socket already broken — pointless)
    expect(conn.res.writableEnded).toBe(false);
    // Subscription removed, so teardown has no connection left to end (writableEnded staying false is expected)
    live.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(conn.res.writableEnded).toBe(false);
  });

  it('全部观看者断开 → 泵停；再有观看者 → 泵重启', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    const a = fakeConn();
    handleLiveView(a.req, a.res, live.key);
    await vi.advanceTimersByTimeAsync(600);
    const b = fakeConn();
    handleLiveView(b.req, b.res, live.key);
    a.close();
    b.close();
    const still = a.body().length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(a.body().length).toBe(still); // no viewers, zero extra frames (pump stopped)
    const c = fakeConn();
    handleLiveView(c.req, c.res, live.key);
    await vi.advanceTimersByTimeAsync(600); // new viewer → pump restarts
    expect(c.hasJpeg()).toBe(true);
    live.close();
  });

  it('未 setPage → 流保持打开等待画面源；setPage 后开始出帧', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    expect(conn.res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(1500);
    expect(conn.res.writableEnded).toBe(false); // does not end before the page source is ready (waiting out the setPage race window)
    expect(conn.chunks.length).toBe(0);
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    await vi.advanceTimersByTimeAsync(600);
    expect(conn.hasJpeg()).toBe(true);
    live.close();
  });
});

/** Fake Page supporting CDP screencast: context().newCDPSession returns a fake session that can emit frames. */
function screencastPage() {
  const listeners: Record<string, (ev: { data?: string; sessionId?: number }) => void> = {};
  const sends: string[] = [];
  const session = {
    on(evt: string, cb: (ev: { data?: string; sessionId?: number }) => void) { listeners[evt] = cb; },
    send: async (cmd: string) => { sends.push(cmd); return {}; },
    detach: async () => {},
  };
  const page = {
    screenshot: async () => JPEG,
    context: () => ({ newCDPSession: async () => session }),
  };
  return {
    page,
    session,
    sends: () => sends,
    emit: (data: string, sessionId = 1) => listeners['Page.screencastFrame']?.({ data, sessionId }),
  };
}

describe('CDP screencast 提帧', () => {
  it('screencast 可用时帧经 CDP 推送；close 后停止', async () => {
    vi.useFakeTimers();
    const { page, session, sends, emit } = screencastPage();
    const live = registerLiveView();
    live.setPage(page as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    // Start screencast
    await vi.advanceTimersByTimeAsync(0);
    expect(sends()).toContain('Page.startScreencast');
    // CDP pushes one frame
    emit(Buffer.from(JPEG).toString('base64'));
    expect(conn.hasJpeg()).toBe(true);
    // Within the fresh-frame window the polling fallback doesn't jump ahead (no screenshots while screencast is alive)
    await vi.advanceTimersByTimeAsync(600);
    expect(conn.chunks.filter((c) => typeof c === 'object')).toHaveLength(1);
    live.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(sends()).toContain('Page.stopScreencast');
  });

  it('screencast 停滞后轮询兜底补帧（自愈）', async () => {
    vi.useFakeTimers();
    // session pushes no frames (startScreencast succeeds but no screencastFrame event)
    const session = {
      on: () => {},
      send: async () => {},
      detach: async () => {},
    };
    const page = {
      screenshot: async () => JPEG,
      context: () => ({ newCDPSession: async () => session }),
    };
    const live = registerLiveView();
    live.setPage(page as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    await vi.advanceTimersByTimeAsync(1500); // past KEEPALIVE_MS(1200), the polling fallback produces a frame
    expect(conn.hasJpeg()).toBe(true);
    live.close();
  });

  it('screencast 启动失败（newCDPSession 抛错）→ 纯轮询兜底，不中断', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never); // no context() → newCDPSession throws
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    await vi.advanceTimersByTimeAsync(600);
    expect(conn.hasJpeg()).toBe(true);
    expect(conn.res.writableEnded).toBe(false);
    live.close();
  });
});

/** Fake Page that records evaluate calls (for highlight DOM injection assertions). */
function evalPage() {
  const calls: unknown[] = [];
  const page = {
    screenshot: async () => JPEG,
    evaluate: async (_fn: unknown, arg?: unknown) => { calls.push(arg); return undefined; },
  };
  return { page, calls: () => calls };
}

describe('动作高亮（blackboard 层）', () => {
  it('有观看者时按懒求值 box 注入 DOM；无人观看零 evaluate', async () => {
    const { page, calls } = evalPage();
    const live = registerLiveView();
    live.setPage(page as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key); // 1 viewer
    const box = { x: 1, y: 2, width: 10, height: 20 };
    let boxEvaluated = false;
    await annotateAction(page as never, () => { boxEvaluated = true; return Promise.resolve(box); });
    expect(boxEvaluated).toBe(true);
    expect(calls()).toHaveLength(1);
    expect((calls()[0] as [string, unknown])[1]).toEqual(box);
    // clearAnnotation also injects (remove call)
    await clearAnnotation(page as never);
    expect(calls()).toHaveLength(2);
    // All viewers disconnected → zero highlight overhead: annotate's lazy box is no longer evaluated (no evaluate)
    conn.close();
    const before = calls().length;
    boxEvaluated = false;
    await annotateAction(page as never, () => { boxEvaluated = true; return Promise.resolve(box); });
    expect(boxEvaluated).toBe(false);
    expect(calls().length).toBe(before);
    // clearAnnotation is a cleanup safety net: no longer injects (no one watching), but pages that were registered still run remove
    await clearAnnotation(page as never);
    expect(calls().length).toBe(before + 1);
    live.close();
  });

  it('box 为 null 或懒求值为 null → 直接跳过（无 evaluate）', async () => {
    const { page, calls } = evalPage();
    const live = registerLiveView();
    live.setPage(page as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    await annotateAction(page as never, null);
    expect(calls()).toHaveLength(0);
    await annotateAction(page as never, () => Promise.resolve(null));
    expect(calls()).toHaveLength(0);
    live.close();
  });
});

describe('录制与回放', () => {
  /** The registry is a module-level singleton shared across cases: recording-type cases use vi.resetModules() + dynamic import to get a fresh instance,
   *  avoiding TTL/LRU counters polluted by earlier leftovers (otherwise the "still within the retention window" assertion would fail sporadically depending on case order). */
  async function freshLiveView() {
    vi.resetModules();
    return (await import('../src/execute/liveView.js')) as typeof import('../src/execute/liveView.js');
  }

  it('录制→回放：按序出帧、末帧后 end、end 后不再写（无人观看也录）', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveReplay: replay } = await freshLiveView();
    const live = reg();
    // No viewers at all: setPage records the first frame immediately, t=2000 records the second (unviewed slow throttle -> replay frame gap 2000)
    live.setPage(fakePage([() => Promise.resolve(JPEG), () => Promise.resolve(JPEG2)]) as never);
    await vi.advanceTimersByTimeAsync(2200);
    live.close(); // set dead; recording kept for replay
    const conn = fakeConn();
    replay(conn.req, conn.res, live.key);
    expect(conn.res.status).toBe(200);
    expect(conn.res.headers?.['Content-Type']).toBe('multipart/x-mixed-replace; boundary=frame');
    const body1 = Buffer.concat(conn.body());
    expect(countBytes(body1, FRAME_HEADER)).toBe(1); // first frame out immediately
    expect(body1.includes(JPEG)).toBe(true);
    expect(conn.res.writableEnded).toBe(false); // no end mid-stream
    await vi.advanceTimersByTimeAsync(2600); // frame gap 2000 → next frame + end
    const body = Buffer.concat(conn.body());
    expect(countBytes(body, FRAME_HEADER)).toBe(2);
    expect(body.includes(JPEG2)).toBe(true);
    expect(body.indexOf(JPEG)).toBeLessThan(body.indexOf(JPEG2)); // order preserved
    expect(conn.res.writableEnded).toBe(true); // end after the last frame
    const len = conn.body().length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(conn.body().length).toBe(len); // nothing written after end
  });

  it('录制节流：观看 500ms / 无人 2000ms 一帧（洪泛采样 / 慢轮询）', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveView: view, handleLiveReplay: replay } = await freshLiveView();
    // Viewers present: screencast floods frames; recording samples on a 500ms window
    const { page, emit } = screencastPage();
    const live = reg();
    live.setPage(page as never);
    const conn = fakeConn();
    view(conn.req, conn.res, live.key);
    await vi.advanceTimersByTimeAsync(0); // flush startScreencast
    await vi.advanceTimersByTimeAsync(250); // past MIN_FRAME_GAP, first batch of CDP frames available
    emit(Buffer.from(JPEG).toString('base64')); // 250ms: <500ms recording gate not open → fanout only, no recording
    await vi.advanceTimersByTimeAsync(250); // t=500 viewer polling tick (KEEPALIVE unsatisfied, doesn't grab frames)
    emit(Buffer.from(JPEG).toString('base64')); // 500ms: recording gate open → recorded
    await vi.advanceTimersByTimeAsync(100);
    live.close();
    const rp = fakeConn();
    replay(rp.req, rp.res, live.key);
    expect(rp.res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(3000);
    const bod = Buffer.concat(rp.body());
    expect(countBytes(bod, FRAME_HEADER)).toBe(2); // first frame (setPage) + the 500ms frame
    expect(rp.res.writableEnded).toBe(true);

    // No viewers: polling records on the 2000ms slow throttle
    const live2 = reg('unviewed-cad');
    live2.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    await vi.advanceTimersByTimeAsync(2200); // t=0 first frame + t=2000 second frame
    live2.close();
    const rp2 = fakeConn();
    replay(rp2.req, rp2.res, 'unviewed-cad');
    expect(rp2.res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(3000);
    expect(countBytes(Buffer.concat(rp2.body()), FRAME_HEADER)).toBe(2);
    expect(rp2.res.writableEnded).toBe(true);
  });

  it('回放前提：live 未结束 404、录制为空 404', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveReplay: replay } = await freshLiveView();
    // Still live (not closed) → 404
    const live = reg();
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    await vi.advanceTimersByTimeAsync(0);
    const conn = fakeConn();
    replay(conn.req, conn.res, live.key);
    expect(conn.res.status).toBe(404);
    live.close();
    // Never produced a frame (no recording) → 404
    const empty = reg();
    empty.close();
    const conn2 = fakeConn();
    replay(conn2.req, conn2.res, empty.key);
    expect(conn2.res.status).toBe(404);
  });

  it('同 key 重注册：旧录制被新执行覆盖（回放只含新帧）', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveReplay: replay } = await freshLiveView();
    const a = reg('dup-replay');
    a.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    await vi.advanceTimersByTimeAsync(0); // first frame recorded
    a.close();
    let rp = fakeConn();
    replay(rp.req, rp.res, 'dup-replay');
    expect(rp.res.status).toBe(200); // run1 replay available
    const b = reg('dup-replay'); // second run: the old source (with its old recording) is terminated
    b.setPage(fakePage([() => Promise.resolve(JPEG2)]) as never);
    await vi.advanceTimersByTimeAsync(0);
    b.close();
    rp = fakeConn();
    replay(rp.req, rp.res, 'dup-replay');
    expect(rp.res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(3000);
    const bod = Buffer.concat(rp.body());
    expect(bod.includes(JPEG)).toBe(false); // old frame absent
    expect(bod.includes(JPEG2)).toBe(true); // only the new recording
    expect(rp.res.writableEnded).toBe(true);
  });

  it('并发双回放：各自完整序列，一路断开不影响另一路', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveReplay: replay } = await freshLiveView();
    const live = reg();
    live.setPage(fakePage([() => Promise.resolve(JPEG), () => Promise.resolve(JPEG2)]) as never);
    await vi.advanceTimersByTimeAsync(2200); // 2 frames recorded
    live.close();
    const p1 = fakeConn();
    replay(p1.req, p1.res, live.key);
    const p2 = fakeConn();
    replay(p2.req, p2.res, live.key);
    expect(p1.res.status).toBe(200);
    expect(p2.res.status).toBe(200);
    p1.close(); // disconnect one (clears its replay timers)
    await vi.advanceTimersByTimeAsync(3000);
    expect(p2.res.writableEnded).toBe(true);
    const b1 = Buffer.concat(p2.body());
    expect(countBytes(b1, FRAME_HEADER)).toBe(2);
    expect(b1.indexOf(JPEG)).toBeLessThan(b1.indexOf(JPEG2));
  });

  it('录制保留 LRU：超出保留上限后，最早过期的一份被淘汰', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveReplay: replay } = await freshLiveView();
    const keys: string[] = [];
    for (let k = 0; k <= 6; k++) {
      const key = `lru-${k}`;
      const live = reg(key);
      live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
      await vi.advanceTimersByTimeAsync(0); // flush the setPage first-tick screenshot into the recording
      live.close(); // terminate one by one → 7 recordings overflow MAX_RETAINED_RECORDINGS
      keys.push(key);
    }
    const dropped = fakeConn();
    replay(dropped.req, dropped.res, keys[0]!);
    expect(dropped.res.status).toBe(404); // the earliest-expiring one was evicted
    for (const key of keys.slice(1)) {
      const conn = fakeConn();
      replay(conn.req, conn.res, key);
      expect(conn.res.status).toBe(200); // in-bound ones still replayable
    }
  });

  it('TTL 懒过期：30min 内可回放，过期后 404 并清出注册表', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveReplay: replay } = await freshLiveView();
    const live = reg('ttl-rec');
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    await vi.advanceTimersByTimeAsync(500); // record the first frame (before close)
    live.close(); // dead, expiresAt = close + 30min
    const within = fakeConn();
    replay(within.req, within.res, 'ttl-rec');
    expect(within.res.status).toBe(200); // replayable within TTL
    await vi.advanceTimersByTimeAsync(31 * 60_000); // past 30min
    const expired = fakeConn();
    replay(expired.req, expired.res, 'ttl-rec');
    expect(expired.res.status).toBe(404); // removed by lazy check
    const again = fakeConn();
    replay(again.req, again.res, 'ttl-rec');
    expect(again.res.status).toBe(404); // registry cleared (reconfirmed)
  });

  it('回放倍速：speed=N 压缩帧间隔（约 1/N），非法/缺失 → 1x', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveReplay: replay, replaySpeedOf } = await freshLiveView();
    // Two-frame recording, original frame gap 2000ms (unviewed slow throttle)
    const record = (key: string) => {
      const live = reg(key);
      live.setPage(fakePage([() => Promise.resolve(JPEG), () => Promise.resolve(JPEG2)]) as never);
      return live;
    };
    // 1x: frame gap 2000ms
    const one = record('sp-1');
    await vi.advanceTimersByTimeAsync(2200);
    one.close();
    const c1 = fakeConn();
    replay(c1.req, c1.res, 'sp-1', { speed: 1 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(countBytes(Buffer.concat(c1.body()), FRAME_HEADER)).toBe(1); // next frame not yet due
    await vi.advanceTimersByTimeAsync(1);
    expect(countBytes(Buffer.concat(c1.body()), FRAME_HEADER)).toBe(2);

    // 4x: 2000/4 = 500ms, second frame then end
    const four = record('sp-4');
    await vi.advanceTimersByTimeAsync(2200);
    four.close();
    const c4 = fakeConn();
    replay(c4.req, c4.res, 'sp-4', { speed: 4 });
    expect(countBytes(Buffer.concat(c4.body()), FRAME_HEADER)).toBe(1); // first frame out immediately
    await vi.advanceTimersByTimeAsync(499);
    expect(countBytes(Buffer.concat(c4.body()), FRAME_HEADER)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(countBytes(Buffer.concat(c4.body()), FRAME_HEADER)).toBe(2);
    expect(c4.res.writableEnded).toBe(true);

    // 8x: 2000/8 = 250ms (the compressed value before hitting REPLAY_MIN_GAP, not yet at the floor)
    const eight = record('sp-8');
    await vi.advanceTimersByTimeAsync(2200);
    eight.close();
    const c8 = fakeConn();
    replay(c8.req, c8.res, 'sp-8', { speed: 8 });
    await vi.advanceTimersByTimeAsync(250);
    expect(countBytes(Buffer.concat(c8.body()), FRAME_HEADER)).toBe(2);
    expect(c8.res.writableEnded).toBe(true);

    // Param parsing: missing / 0 / negative / NaN → 1; above the cap → 8; decimals pass through
    expect(replaySpeedOf({})).toBe(1);
    expect(replaySpeedOf({ speed: '0' })).toBe(1);
    expect(replaySpeedOf({ speed: '-4' })).toBe(1);
    expect(replaySpeedOf({ speed: 'abc' })).toBe(1);
    expect(replaySpeedOf({ speed: '100' })).toBe(8);
    expect(replaySpeedOf({ speed: '2' })).toBe(2);
  });

  it('回放可用性探测 meta：有录制 → available，live 中/无录制/过期 → false', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveReplayMeta: meta } = await freshLiveView();
    const jsonOf = (c: ReturnType<typeof fakeConn>) => JSON.parse(Buffer.concat(c.body()).toString());
    const probe = (key: string) => {
      const c = fakeConn();
      meta(c.res as never, key);
      return { status: c.res.status, body: jsonOf(c) };
    };
    // Running (not dead) → nothing replayable
    const live = reg('meta-live');
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    await vi.advanceTimersByTimeAsync(0); // flush the setPage first-tick screenshot into the recording
    expect(probe('meta-live')).toEqual({ status: 200, body: { available: false } });
    // Run ended with a recording → available + metadata
    live.close();
    expect(probe('meta-live')).toEqual({
      status: 200,
      body: { available: true, frames: 1, durationMs: 0, expiresAt: expect.any(Number) },
    });
    // Never produced a frame → nothing replayable
    const empty = reg('meta-empty');
    empty.close();
    expect(probe('meta-empty').body).toEqual({ available: false });
    // Unregistered key → nothing replayable
    expect(probe('meta-nope').body).toEqual({ available: false });
    // TTL expired (the lazy check first deletes the entry from the registry) → nothing replayable
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(probe('meta-live').body).toEqual({ available: false });
  });
});