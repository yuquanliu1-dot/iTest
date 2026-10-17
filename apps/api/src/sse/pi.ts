import type { Response } from 'express';

/** 与 planRunBus 同形的 SSE 帮助函数 — 提供给 pi/space 与 pi 路由使用。 */
export function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // nginx 对反代响应默认 proxy_buffering on:SSE 事件被整段缓冲后按块 flush,实时帧延迟到达、
  // 长连接半途像卡死。该响应头让 nginx 对本响应关闭缓冲、逐帧透传——与 execute/liveView.ts
  // MJPEG 流的 X-Accel-Buffering:no 同款机制,是 proxy_buffering off 的精确版(只作用于 SSE)。
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

/** SSE 帧写入：单条事件以 JSON 字符串写一行 data:。 */
export function sseSend(res: Response, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * SSE 守护心跳:长任务(verify_case 单步 AI 相可静默 240s;plan run 跨多用例更久)期间保证
 * 字节流不中断,否则 nginx proxy_read_timeout(默认 300s)在读侧静默时段掐掉连接,而
 * react-pi 只在 read 挂起/抛错时重连,半开连接 = 前端永久冻结。每 intervalMs 写一行注释帧
 * `: ping`——EventSource/SSEEventDecoder 对注释行与空 data 帧一概丢弃,只保活不出事件,
 * 与既有流 100% 兼容。
 * 返回 stop():调用方须在 req.on('close')/res.on('error')/写失败时调用,防止定时器泄漏。
 */
export function startSseHeartbeat(res: Response, intervalMs = 20_000): () => void {
  let timer: NodeJS.Timeout | null = null;
  const stop = (): void => {
    if (timer) { clearInterval(timer); timer = null; }
  };
  const beat = (): void => {
    if (!res.writable || res.writableEnded) { stop(); return; }
    try {
      res.write(': ping\n\n');
    } catch {
      stop();
    }
  };
  timer = setInterval(beat, intervalMs);
  return stop;
}
