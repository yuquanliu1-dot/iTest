/**
 * 助手 playground 实时画面：verify_case / solidify_case 在无头浏览器执行期间，
 * 服务端轮询截图合成 MJPEG 流（multipart/x-mixed-replace），前端 <img src> 原生解码。
 * 借鉴 Midscene playground 的 polling 层（其 mjpeg-stream-handler 的第三级 fallback）：
 * 不用 CDP screencast——headless 支持不一致；AI 步骤由 LLM 延迟主导，~2fps 监控足够。
 * 无观看者时零开销（轮询循环只在有 HTTP 连接时启动）。
 */
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';

/** 帧间隔：500ms ≈ 2fps；1280x800 jpeg q55 约 60-120KB/帧，单观看者带宽可忽略。 */
const FRAME_INTERVAL_MS = 500;
/** 单帧截图软超时：超时/异常跳帧续流（导航中等场景截图可能挂起，不阻断流）。 */
const FRAME_TIMEOUT_MS = 2500;
const BOUNDARY = 'frame';

interface LiveEntry {
  page: Page | null;
  /** 工具 finally 置位：帧泵据此结束流（浏览器即将关闭，继续截图只会报错）。 */
  dead: boolean;
}

/** liveKey → 页面源（进程内存，同 loginStateCache 模式；api 单进程，无跨实例问题）。 */
const registry = new Map<string, LiveEntry>();

export interface LiveViewHandle {
  key: string;
  /** 画面源切换：verify 的 replay 阶段新开 page 后无缝切换，整段验证一路可见。 */
  setPage(p: Page): void;
  /** 工具收尾调用：置 dead（在途帧泵结束流）+ 删除注册表。 */
  close(): void;
}

export function registerLiveView(): LiveViewHandle {
  const key = randomUUID();
  registry.set(key, { page: null, dead: false });
  return {
    key,
    setPage: (p) => {
      const e = registry.get(key);
      if (e) e.page = p;
    },
    close: () => {
      const e = registry.get(key);
      if (e) e.dead = true;
      registry.delete(key);
    },
  };
}

/** GET /api/assistant/threads/:id/live/:key —— 鉴权在路由层完成，这里只管流。 */
export function handleLiveView(req: { on: (event: 'close', fn: () => void) => void }, res: {
  writeHead: (status: number, headers: Record<string, string>) => void;
  write: (chunk: string | Buffer) => boolean;
  end: () => void;
  writableEnded: boolean;
}, key: string): void {
  const entry = registry.get(key);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    // 生产 nginx 反代禁缓冲，否则帧被攒批、画面卡成幻灯片（SSE 同理）
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  let inFlight = false;
  const stop = () => {
    closed = true;
    clearInterval(timer);
    if (!res.writableEnded) res.end();
  };
  req.on('close', stop);

  const timer = setInterval(() => {
    if (closed) return;
    if (entry.dead || !entry.page) {
      stop();
      return;
    }
    if (inFlight) return; // 上一帧未完成（慢页/导航挂起）：跳过本轮，不叠加并发截图
    inFlight = true;
    void (async () => {
      try {
        const buf = await Promise.race([
          entry.page!.screenshot({ type: 'jpeg', quality: 55 }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('frame timeout')), FRAME_TIMEOUT_MS)),
        ]);
        if (closed || res.writableEnded) return;
        res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
        res.write(buf);
        res.write('\r\n');
      } catch {
        // 跳帧：导航/页面崩溃等瞬态错误直接丢弃，流保持打开
      } finally {
        inFlight = false;
      }
    })();
  }, FRAME_INTERVAL_MS);
}
