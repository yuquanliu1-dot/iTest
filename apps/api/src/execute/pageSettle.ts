import type { Page } from 'playwright-core';

/**
 * 等整页渲染「稳定」后再截图交给 LLM 判定（vision 终态 / 验证码识别）。
 *
 * 动机：此前判定前只用固定 `waitForLoadState('networkidle') + 固定 sleep`——
 * SPA 懒加载 chunk / 骨架屏 / 接口回填晚于 networkidle 完成时，固定 sleep 不足以让渲染落地，
 * 截图仍停在「加载中」帧，LLM 据此把「没加载完」误判为「不符合预期」，用例假失败。
 * 实测 report 4c6d0798 的 final 帧与末步帧逐字节相同（已稳定），但用户多次反馈「页面没加载完
 * 就分析截图」——固定时间不可靠，这里改成**视觉稳定**判定：连拍两帧像素指纹，两帧相同即认为
 * 渲染已静默。指纹用画布采样 hash 而非 PNG 字节（字节会因重编码波动、且整帧比较在动画下永不收敛）；
 * 连拍 N 次相同即收敛。全程 best-effort，超时就按当前帧继续（绝不比旧行为更差）。
 *
 * 只在「截图要交给 LLM 分析」的两处调用（runCaseVisionAssert / solveCaptchaOnce 兜底整页图）；
 * 普通 step 截图只是记录用途，不套这个以免拖慢每步。
 */
export interface PageSettleOptions {
  /** 总预算（毫秒）。到点仍未稳定也返回，按当前帧继续。默认 12000。 */
  timeoutMs?: number;
  /** 每两次连拍之间的间隔（毫秒）。默认 400。 */
  settleMs?: number;
}

/** 页内采样像素指纹：把 viewport 缩到 160x100 画布，逐行 hash 像素，返回稳定整数值。
 *  与 DPR 无关（固定采样格数），对纯文字/静态布局变化敏感，对持续动画永不收敛。 */
async function pageFingerprint(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const W = 160;
    const H = 100;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return -1;
    // documentElement 是 HTMLElement，canvas.drawImage 要求 CanvasImageSource；TS 库不认，此处显式断言。
    ctx.drawImage(document.documentElement as unknown as HTMLImageElement, 0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H).data;
    let h = 2166136261;
    for (let i = 0; i < img.length; i += 16) {
      h ^= (img[i] ?? 0);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }).catch(() => -1);
}

export async function waitForPageSettled(page: Page, opts: PageSettleOptions = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 12000);
  const settleMs = opts.settleMs ?? 400;
  // 先尽力等一次 networkidle（长连接页面等不到就交给视觉稳定兜底，不阻塞）。
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
  let prev = -2;
  let stable = 0;
  // 迭代上限：真实场景下 settleMs≥1 让墙钟随循环推进，Date.now()>=deadline 自然终止；
  // 单测 mock waitForTimeout 同步 resolve 时墙钟不推进，这个上限兜底防死循环（也防 evaluate 异常时死循环）。
  const maxIters = Math.max(2, Math.ceil((opts.timeoutMs ?? 12000) / Math.max(1, settleMs)) + 5);
  for (let iter = 0; iter < maxIters && Date.now() < deadline; iter++) {
    const cur = await pageFingerprint(page);
    if (cur >= 0 && cur === prev) {
      stable++;
      if (stable >= 2) return; // 连续三次采样指纹一致 → 渲染已静默
    } else {
      stable = 0;
    }
    prev = cur;
    await page.waitForTimeout(settleMs);
  }
}
