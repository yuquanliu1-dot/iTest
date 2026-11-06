import type { ConsoleMessage, Page } from 'playwright-core';
import type { ConsoleLogEntry } from '@itest/shared';

/** 单步最多保留的条目数（防失控刷屏步骤撑爆 step_results JSONB）。 */
const MAX_ENTRIES_PER_STEP = 10;
/** 单条文本截断长度。 */
const MAX_TEXT_LENGTH = 500;

/** 事件缓冲（createConsoleCapture 内部维护，drain 时取走并清空）。 */
export type ConsoleBuffer = ConsoleLogEntry[];

/**
 * 把一条 console/pageerror 事件规整进缓冲（纯逻辑，便于单测）：
 * 只留 error 级 console 输出与未捕获异常（业务系统的 console.log/info/warn 是噪音），
 * 文本截断，超出单步上限后丢弃后来的（首 10 条最有信息量）。
 */
export function recordConsoleEvent(buffer: ConsoleBuffer, type: string, text: string, ts: number): void {
  if (type !== 'error') return;
  if (buffer.length >= MAX_ENTRIES_PER_STEP) return;
  const trimmed = text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
  buffer.push({ type: 'console-error', text: trimmed, ts });
}

export function recordPageError(buffer: ConsoleBuffer, err: unknown, ts: number): void {
  if (buffer.length >= MAX_ENTRIES_PER_STEP) return;
  const text = err instanceof Error ? err.message : String(err);
  const trimmed = text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
  buffer.push({ type: 'pageerror', text: trimmed, ts });
}

export interface ConsoleCapture {
  /** 取走当前缓冲并清空（按步骤起止切片归属：谁在结果构造点调 drain，条目归谁）。 */
  drain(): ConsoleLogEntry[];
}

const captures = new WeakMap<Page, ConsoleCapture>();

/** 在页面创建点挂订阅（cdp.ts runStepsInContext 的 context.newPage() 之后调用一次）。 */
export function createConsoleCapture(page: Page): ConsoleCapture {
  const existing = captures.get(page);
  if (existing) return existing;
  const buffer: ConsoleBuffer = [];
  const onConsole = (msg: ConsoleMessage): void => {
    recordConsoleEvent(buffer, msg.type(), msg.text(), Date.now());
  };
  const onPageError = (err: unknown): void => {
    recordPageError(buffer, err, Date.now());
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  const capture: ConsoleCapture = {
    drain: () => {
      const out = buffer.slice();
      buffer.length = 0;
      return out;
    },
  };
  captures.set(page, capture);
  return capture;
}

/**
 * 作用域外取数（visionAssert 等拿不到 capture 引用的地方）：没有采集器的页返回空数组。
 * 返回的是该页自上次 drain 以来的累计条目，并清空。
 */
export function drainConsoleForPage(page: Page): ConsoleLogEntry[] {
  return captures.get(page)?.drain() ?? [];
}
