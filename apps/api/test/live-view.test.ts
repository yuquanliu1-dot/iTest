import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  registerLiveView,
  handleLiveView,
  annotateAction,
  clearAnnotation,
} from '../src/execute/liveView.js';

/** fake playwright Page：脚本化 screenshot 行为（成功返回 buffer / 抛错 / 挂起）。
 *  screenshot 之外的 liveView 依赖（context().newCDPSession 用于 screencast）统一 mock 为不可用 → 落轮询兜底。 */
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

/** fake req/res：捕获 writeHead/write/end，req.on('close') 记回调。 */
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
    end() {
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

/** multipart 分帧头（每帧各出现一次；用于统计录制/回放帧数）。 */
const FRAME_HEADER = Buffer.from('--frame\r\nContent-Type: image/jpeg');

/** 统计 buf 中非重叠的 pat 出现次数。 */
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
    expect(conn.res.status).toBe(200); // 新源接管
    a.close();
    expect(conn.res.writableEnded).toBe(false); // a.close 不影响 b 的源
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
    expect(conn.res.writableEnded).toBe(false); // 流保持打开
    live.close();
  });

  it('多订阅 hub：同一帧扇出给所有连接；后连接回放最近一帧', async () => {
    // 走 CDP 快路径（不经 KEEPALIVE 节流）；MIN_FRAME_GAP 用真实 Date.now，帧间需睡 210ms 真实时间
    const { page, emit } = screencastPage();
    const live = registerLiveView();
    live.setPage(page as never);
    const a = fakeConn();
    handleLiveView(a.req, a.res, live.key);
    await new Promise((r) => setTimeout(r, 10)); // flush tryStartScreencast 启动链（含事件监听注册）
    emit(Buffer.from(JPEG).toString('base64')); // 帧 1
    expect(a.hasJpeg()).toBe(true);
    // 第二个连接：立即回放最近一帧（<img> 不空白）
    const b = fakeConn();
    handleLiveView(b.req, b.res, live.key);
    expect(b.hasJpeg()).toBe(true);
    b.close();
    await new Promise((r) => setTimeout(r, 210));
    const frames = a.body().length;
    emit(Buffer.from(JPEG).toString('base64')); // 帧 2：只剩 a，仍应收到
    expect(a.body().length).toBeGreaterThan(frames); // …且帧在推进
    live.close();
  });

  it('截图抛错跳帧续流：坏帧不写、好帧照常写', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    // setPage 立即 tick 耗掉第 1 个坏帧（KEEPALIVE 恒定满足）；t=500 再耗 1 个；t=1000 出好帧
    live.setPage(fakePage([new Error('nav'), new Error('nav'), () => Promise.resolve(JPEG)]) as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    await vi.advanceTimersByTimeAsync(600); // t=500 抛错 → 跳过
    expect(conn.chunks.length).toBe(0);
    await vi.advanceTimersByTimeAsync(500); // t=1000 成功
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
    await vi.advanceTimersByTimeAsync(2400); // 首帧 pending：inFlight 置位，期间各 tick 均跳帧不叠截图
    expect(conn.chunks.length).toBe(0);
    // 2500ms 软超时与 tick 同刻到点（超时定时器先注册 → 先释放 inFlight）→ 该 tick 补一帧
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
    expect(conn.body().length).toBe(frames); // interval 已清，不再产出帧
  });

  it('客户端断开（req close）→ 停泵（订阅移除）；torn 连接不再被 end', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    conn.close();
    await vi.advanceTimersByTimeAsync(1200);
    // v2 语义：断开只移除订阅并停泵，不主动 end 响应（socket 已断，无意义）
    expect(conn.res.writableEnded).toBe(false);
    // 订阅已移除，teardown 也没有该连接可 end（writableEnded 维持 false 属预期）
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
    expect(a.body().length).toBe(still); // 无观看者，零额外帧（泵停转）
    const c = fakeConn();
    handleLiveView(c.req, c.res, live.key);
    await vi.advanceTimersByTimeAsync(600); // 新观看者 → 泵重启
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
    expect(conn.res.writableEnded).toBe(false); // 页面源未就绪前不结束（等待 setPage 竞态窗口）
    expect(conn.chunks.length).toBe(0);
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    await vi.advanceTimersByTimeAsync(600);
    expect(conn.hasJpeg()).toBe(true);
    live.close();
  });
});

/** fake Page 支持 CDP screencast：context().newCDPSession 返回可发帧的假 session。 */
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
    // 启动 screencast
    await vi.advanceTimersByTimeAsync(0);
    expect(sends()).toContain('Page.startScreencast');
    // CDP 推一帧
    emit(Buffer.from(JPEG).toString('base64'));
    expect(conn.hasJpeg()).toBe(true);
    // 新鲜帧窗口内轮询兜底不抢跑（screencast 活着时不截图）
    await vi.advanceTimersByTimeAsync(600);
    expect(conn.chunks.filter((c) => typeof c === 'object')).toHaveLength(1);
    live.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(sends()).toContain('Page.stopScreencast');
  });

  it('screencast 停滞后轮询兜底补帧（自愈）', async () => {
    vi.useFakeTimers();
    // session 不推帧（startScreencast 成功但无 screencastFrame 事件）
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
    await vi.advanceTimersByTimeAsync(1500); // 超过 KEEPALIVE_MS(1200)，轮询兜底出帧
    expect(conn.hasJpeg()).toBe(true);
    live.close();
  });

  it('screencast 启动失败（newCDPSession 抛错）→ 纯轮询兜底，不中断', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never); // 无 context() → newCDPSession 抛错
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    await vi.advanceTimersByTimeAsync(600);
    expect(conn.hasJpeg()).toBe(true);
    expect(conn.res.writableEnded).toBe(false);
    live.close();
  });
});

/** fake Page 记录 evaluate 调用（供高亮 DOM 注入断言）。 */
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
    handleLiveView(conn.req, conn.res, live.key); // 1 个观看者
    const box = { x: 1, y: 2, width: 10, height: 20 };
    let boxEvaluated = false;
    await annotateAction(page as never, () => { boxEvaluated = true; return Promise.resolve(box); });
    expect(boxEvaluated).toBe(true);
    expect(calls()).toHaveLength(1);
    expect((calls()[0] as [string, unknown])[1]).toEqual(box);
    // clearAnnotation 同样注入（remove 调用）
    await clearAnnotation(page as never);
    expect(calls()).toHaveLength(2);
    // 观看者全部断开 → 高亮零开销：annotate 的懒 box 不再求值（不 evaluate）
    conn.close();
    const before = calls().length;
    boxEvaluated = false;
    await annotateAction(page as never, () => { boxEvaluated = true; return Promise.resolve(box); });
    expect(boxEvaluated).toBe(false);
    expect(calls().length).toBe(before);
    // clearAnnotation 是清理安全网：不再注入（无人看），但已注册过的页仍会执行 remove
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
  /** 注册表是模块级单例且跨用例共享：录制类用例用 vi.resetModules() + 动态 import 拿全新实例，
   *  避免 TTL/LRU 计数被更早的残留污染（否则「仍在保留窗口内」断言会随用例顺序偶发失败）。 */
  async function freshLiveView() {
    vi.resetModules();
    return (await import('../src/execute/liveView.js')) as typeof import('../src/execute/liveView.js');
  }

  it('录制→回放：按序出帧、末帧后 end、end 后不再写（无人观看也录）', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveReplay: replay } = await freshLiveView();
    const live = reg();
    // 无任何观看者：setPage 立即录首帧，t=2000 录次帧（无人慢节流 -> 回放帧差 2000）
    live.setPage(fakePage([() => Promise.resolve(JPEG), () => Promise.resolve(JPEG2)]) as never);
    await vi.advanceTimersByTimeAsync(2200);
    live.close(); // 置 dead，录制保留供回放
    const conn = fakeConn();
    replay(conn.req, conn.res, live.key);
    expect(conn.res.status).toBe(200);
    expect(conn.res.headers?.['Content-Type']).toBe('multipart/x-mixed-replace; boundary=frame');
    const body1 = Buffer.concat(conn.body());
    expect(countBytes(body1, FRAME_HEADER)).toBe(1); // 首帧即出
    expect(body1.includes(JPEG)).toBe(true);
    expect(conn.res.writableEnded).toBe(false); // 中段不 end
    await vi.advanceTimersByTimeAsync(2600); // 帧差 2000 → 次帧 + end
    const body = Buffer.concat(conn.body());
    expect(countBytes(body, FRAME_HEADER)).toBe(2);
    expect(body.includes(JPEG2)).toBe(true);
    expect(body.indexOf(JPEG)).toBeLessThan(body.indexOf(JPEG2)); // 顺序保持
    expect(conn.res.writableEnded).toBe(true); // 末帧后 end
    const len = conn.body().length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(conn.body().length).toBe(len); // end 后不再写
  });

  it('录制节流：观看 500ms / 无人 2000ms 一帧（洪泛采样 / 慢轮询）', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveView: view, handleLiveReplay: replay } = await freshLiveView();
    // 观看者存在：screencast 洪泛推帧，录制按 500ms 窗口采样
    const { page, emit } = screencastPage();
    const live = reg();
    live.setPage(page as never);
    const conn = fakeConn();
    view(conn.req, conn.res, live.key);
    await vi.advanceTimersByTimeAsync(0); // flush startScreencast
    await vi.advanceTimersByTimeAsync(250); // 越过 MIN_FRAME_GAP，首批 CDP 帧可用
    emit(Buffer.from(JPEG).toString('base64')); // 250ms：<500ms 录制门未开 → 只扇出不录
    await vi.advanceTimersByTimeAsync(250); // t=500 观看轮询 tick（KEEPALIVE 未满足不抢帧）
    emit(Buffer.from(JPEG).toString('base64')); // 500ms：录制门开 → 录
    await vi.advanceTimersByTimeAsync(100);
    live.close();
    const rp = fakeConn();
    replay(rp.req, rp.res, live.key);
    expect(rp.res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(3000);
    const bod = Buffer.concat(rp.body());
    expect(countBytes(bod, FRAME_HEADER)).toBe(2); // 首帧(setPage) + 500ms 那帧
    expect(rp.res.writableEnded).toBe(true);

    // 无人观看：轮询按 2000ms 慢节流录制
    const live2 = reg('unviewed-cad');
    live2.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    await vi.advanceTimersByTimeAsync(2200); // t=0 首帧 + t=2000 第 2 帧
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
    // 仍在 live（未 close）→ 404
    const live = reg();
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    await vi.advanceTimersByTimeAsync(0);
    const conn = fakeConn();
    replay(conn.req, conn.res, live.key);
    expect(conn.res.status).toBe(404);
    live.close();
    // 从未出帧（无录制）→ 404
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
    await vi.advanceTimersByTimeAsync(0); // 首帧入录
    a.close();
    let rp = fakeConn();
    replay(rp.req, rp.res, 'dup-replay');
    expect(rp.res.status).toBe(200); // run1 回放可用
    const b = reg('dup-replay'); // 第二次执行：旧源（含旧录制）被终结
    b.setPage(fakePage([() => Promise.resolve(JPEG2)]) as never);
    await vi.advanceTimersByTimeAsync(0);
    b.close();
    rp = fakeConn();
    replay(rp.req, rp.res, 'dup-replay');
    expect(rp.res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(3000);
    const bod = Buffer.concat(rp.body());
    expect(bod.includes(JPEG)).toBe(false); // 旧帧不在
    expect(bod.includes(JPEG2)).toBe(true); // 只有新录制
    expect(rp.res.writableEnded).toBe(true);
  });

  it('并发双回放：各自完整序列，一路断开不影响另一路', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveReplay: replay } = await freshLiveView();
    const live = reg();
    live.setPage(fakePage([() => Promise.resolve(JPEG), () => Promise.resolve(JPEG2)]) as never);
    await vi.advanceTimersByTimeAsync(2200); // 2 帧入录
    live.close();
    const p1 = fakeConn();
    replay(p1.req, p1.res, live.key);
    const p2 = fakeConn();
    replay(p2.req, p2.res, live.key);
    expect(p1.res.status).toBe(200);
    expect(p2.res.status).toBe(200);
    p1.close(); // 断开一路（清其回放定时器）
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
      await vi.advanceTimersByTimeAsync(0); // 冲掉 setPage 首 tick 截图入录
      live.close(); // 逐份终结 → 7 份录制撑破 MAX_RETAINED_RECORDINGS
      keys.push(key);
    }
    const dropped = fakeConn();
    replay(dropped.req, dropped.res, keys[0]!);
    expect(dropped.res.status).toBe(404); // 最早过期者被淘汰
    for (const key of keys.slice(1)) {
      const conn = fakeConn();
      replay(conn.req, conn.res, key);
      expect(conn.res.status).toBe(200); // 界内者仍可回放
    }
  });

  it('TTL 懒过期：30min 内可回放，过期后 404 并清出注册表', async () => {
    vi.useFakeTimers();
    const { registerLiveView: reg, handleLiveReplay: replay } = await freshLiveView();
    const live = reg('ttl-rec');
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    await vi.advanceTimersByTimeAsync(500); // 录首帧（close 前）
    live.close(); // dead，expiresAt = close + 30min
    const within = fakeConn();
    replay(within.req, within.res, 'ttl-rec');
    expect(within.res.status).toBe(200); // TTL 内可回放
    await vi.advanceTimersByTimeAsync(31 * 60_000); // 越过 30min
    const expired = fakeConn();
    replay(expired.req, expired.res, 'ttl-rec');
    expect(expired.res.status).toBe(404); // 懒检查删除
    const again = fakeConn();
    replay(again.req, again.res, 'ttl-rec');
    expect(again.res.status).toBe(404); // 注册表已清（再次确认）
  });
});