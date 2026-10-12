import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerLiveView, handleLiveView } from '../src/pi/space/liveView.js';

/** fake playwright Page：脚本化 screenshot 行为（成功返回 buffer / 抛错 / 挂起）。 */
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
  };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

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
});

describe('handleLiveView MJPEG 帧泵', () => {
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

  it('截图抛错跳帧续流：坏帧不写、好帧照常写', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    live.setPage(fakePage([new Error('nav'), () => Promise.resolve(JPEG)]) as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    await vi.advanceTimersByTimeAsync(600); // 第 1 帧：抛错 → 跳过
    expect(conn.chunks.length).toBe(0);
    await vi.advanceTimersByTimeAsync(500); // 第 2 帧：成功
    const body = Buffer.concat(conn.body());
    expect(body.includes(JPEG)).toBe(true);
    expect(conn.res.writableEnded).toBe(false);
    live.close();
  });

  it('截图挂起超过单帧超时 → 跳帧，流不中断', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    live.setPage(fakePage(['pending', () => Promise.resolve(JPEG)]) as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    await vi.advanceTimersByTimeAsync(2600); // 第 1 帧 pending，2500ms 软超时触发
    expect(conn.chunks.length).toBe(0);
    // 下一帧 interval 在 t=3500（超时释放在 t=3000 的同拍 interval 之后）——推进过该拍
    await vi.advanceTimersByTimeAsync(1000);
    expect(Buffer.concat(conn.body()).includes(JPEG)).toBe(true);
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

  it('客户端断开（req close）→ 停流', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    live.setPage(fakePage([() => Promise.resolve(JPEG)]) as never);
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    conn.close();
    await vi.advanceTimersByTimeAsync(1200);
    expect(conn.res.writableEnded).toBe(true);
    live.close();
  });

  it('无页面源（未 setPage）→ 直接结束流（200 空流）', async () => {
    vi.useFakeTimers();
    const live = registerLiveView();
    const conn = fakeConn();
    handleLiveView(conn.req, conn.res, live.key);
    await vi.advanceTimersByTimeAsync(600);
    expect(conn.res.status).toBe(200);
    expect(conn.res.writableEnded).toBe(true);
    live.close();
  });
});
