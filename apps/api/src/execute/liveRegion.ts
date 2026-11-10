/**
 * live-region 消息提取 + 可观测变化闸（借鉴 testomatio/explorbot html-diff.ts / ai/tools.ts）。
 * 动机：toast/提示全靠模型读截图辨认（11-08 实录 toast 确认盲区），且点击空转只烧预算没有
 * 反馈信号。动作执行前后各采样一次：新增消息（aria-live 区域一手文本）回喂模型；四路信号
 * （URL/视觉指纹/请求数/新消息）全无变化 = 点击无效，反馈模型换目标。
 */
import type { Page } from 'playwright-core';

/** explorbot 口径：五个 live region role + <output> 标签 + aria-live 显式两档（默认档不算——
 * 很多容器误挂 aria-live="off"，噪声大）。 */
const LIVE_REGION_SELECTOR =
  '[role="alert"],[role="alertdialog"],[role="status"],[role="log"],[role="tooltip"],output,[aria-live="polite"],[aria-live="assertive"]';

const MESSAGE_MAX_LENGTH = 200;
const MESSAGE_LIMIT = 8;

/** 采样当前页面所有 live-region 可见文本（toast/提示一手证据）。
 *  任何失败（导航瞬间 execution context destroyed 等）→ 空数组，调用方按「无消息」处理。 */
export async function captureLiveRegionMessages(page: Page): Promise<string[]> {
  return page
    .evaluate((sel) => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (t) out.push(t.slice(0, 200));
        if (out.length >= 8) break;
      }
      return out;
    }, LIVE_REGION_SELECTOR)
    .catch(() => [] as string[]);
}

/** 新增消息 = after 里有、before 里没有的（对称子串包含：完整重复与「旧文本的前缀截断」都算旧）。
 *  比 explorbot 单向包含严一档：role=log 这类累积区域每轮全文变长，单向包含会把「整段新日志」
 *  当新消息反复回喂，对称包含把它压成噪声——toast（一次性短文本）两种口径等价。 */
export function diffNewMessages(before: string[], after: string[]): string[] {
  return after.filter((m) => !before.some((b) => b.includes(m) || m.includes(b)));
}

/** 可观测变化快照：点击前后各采一次。 */
export interface ChangeSnapshot {
  url: string;
  /** pageFingerprint 视觉指纹（pageSettle.ts）。 */
  fingerprint: number;
  /** 页面网络请求累计计数（runAiTask 的 page.on('request') 计数器）。 */
  requests: number;
  /** 动作前 live-region 消息（新增消息由 diffNewMessages 单独算）。 */
  messages: string[];
}

/** 四路信号任一有变化即算「页面观测到了变化」（explorbot hasObservablePageChange 口径）。
 *  宽进严出：误放行（把有变化判无）只损失一次提示，误拦截（把无变化判有）会让模型对死目标空转。 */
export function hasObservableChange(before: ChangeSnapshot, after: ChangeSnapshot, newMessages: string[]): boolean {
  return (
    before.url !== after.url ||
    before.fingerprint !== after.fingerprint ||
    after.requests > before.requests ||
    newMessages.length > 0
  );
}
