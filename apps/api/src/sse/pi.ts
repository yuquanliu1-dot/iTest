import type { Response } from 'express';

/** SSE helpers shaped like planRunBus's — for use by the pi/space and pi routes. */
export function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // nginx buffers proxied responses by default (proxy_buffering on): SSE events are buffered wholesale and flushed in
  // chunks, so live frames arrive late and the long connection looks stuck mid-stream. This header turns buffering off
  // for this response, frame by frame — the same mechanism as execute/liveView.ts's MJPEG X-Accel-Buffering:no (SSE-only).
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

/** SSE frame write: one event per line, serialized as a JSON string on a single data: line. */
export function sseSend(res: Response, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * SSE keepalive heartbeat: keeps the byte stream unbroken during long tasks (verify_case's single-step AI phase can go
 * silent for 240s; plan runs span more cases and last longer), else nginx proxy_read_timeout (default 300s) cuts the
 * connection after a silent read-side window, while react-pi only reconnects when read hangs/throws — half-open =
 * the frontend frozen forever. Every intervalMs it writes one comment-frame line `: ping` — EventSource/SSEEventDecoder
 * drop comment lines and empty data frames outright, keepalive only, 100% compatible with existing streams.
 * Returns stop(): the caller must call it on req.on('close')/res.on('error')/write failure to prevent timer leaks.
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
