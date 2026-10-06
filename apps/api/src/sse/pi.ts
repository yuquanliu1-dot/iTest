import type { Response } from 'express';

/** 与 planRunBus 同形的 SSE 帮助函数 — 提供给 pi/space 与 pi 路由使用。 */
export function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

/** SSE 帧写入：单条事件以 JSON 字符串写一行 data:。 */
export function sseSend(res: Response, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}