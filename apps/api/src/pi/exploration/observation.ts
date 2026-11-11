/**
 * 错误信号采集（pi 链路 D3）：console error / pageerror / HTTP 4xx-5xx 的页面侧监听。
 *
 * 与「模型主动报 finding」互补：模型没报但页面在报错（控制台异常、静默 500）是探索
 * 最容易漏的一类。采集是平台侧机械行为，不依赖模型自觉——增量随 observe 回灌给模型
 * （drain），全量封顶留档（all → error_signals 列），「模型没报但页面在报」可据此审计。
 */
import type { Page } from 'playwright-core';

/** 错误信号（留档形状 = schema error_signals 列）。 */
export interface ErrorSignal {
  at: string;
  kind: 'console' | 'pageerror' | 'http';
  /** 单条文本封顶（console 参数拼接 / error message / status 行）。 */
  text: string;
  /** http 类的资源 URL。 */
  url?: string;
}

/** 全量留档封顶：超过后丢弃新条目（留档是审计辅助，不是无限日志）。 */
export const ERROR_SIGNALS_MAX = 200;

/** 单条文本封顶：console 参数可能是超长堆栈。 */
const SIGNAL_TEXT_MAX = 300;

export interface ErrorSignalCollector {
  /** 取走自上次 drain 起的新信号（observe 增量回灌用；已渲染文本）。 */
  drainRendered(): string;
  /** 全量（封顶内）留档快照。 */
  all(): ErrorSignal[];
  close(): void;
}

export function createErrorSignalCollector(page: Page): ErrorSignalCollector {
  const items: ErrorSignal[] = [];
  let drained = 0;
  const textOf = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, SIGNAL_TEXT_MAX);

  const onConsole = (msg: { type(): string; text(): string }): void => {
    if (msg.type() !== 'error') return;
    if (items.length >= ERROR_SIGNALS_MAX) return;
    items.push({ at: new Date().toISOString(), kind: 'console', text: textOf(msg.text()) });
  };
  const onPageError = (err: Error): void => {
    if (items.length >= ERROR_SIGNALS_MAX) return;
    items.push({ at: new Date().toISOString(), kind: 'pageerror', text: textOf(err.message) });
  };
  const onResponse = (res: { status(): number; url(): string }): void => {
    if (res.status() < 400) return;
    if (items.length >= ERROR_SIGNALS_MAX) return;
    items.push({
      at: new Date().toISOString(),
      kind: 'http',
      text: textOf(`HTTP ${res.status()}`),
      url: res.url().slice(0, 300),
    });
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  return {
    drainRendered(): string {
      const fresh = items.slice(drained);
      drained = items.length;
      if (fresh.length === 0) return '';
      const lines = fresh.slice(-5).map((s) => {
        const u = s.url ? ` ${s.url}` : '';
        return `- [${s.kind}] ${s.text}${u}`;
      });
      const note = fresh.length > 5 ? `（本轮新增 ${fresh.length} 条，仅显示最后 5 条）` : '';
      return `页面错误信号（自上次观察起）：\n${lines.join('\n')}${note}`;
    },
    all(): ErrorSignal[] {
      return [...items];
    },
    close(): void {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('response', onResponse);
    },
  };
}
