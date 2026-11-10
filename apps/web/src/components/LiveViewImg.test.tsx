import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import LiveViewImg from './LiveViewImg';
import '../i18n';

/** 放大弹窗里的 <img>（与缩略图 <img> 区分：弹窗那份在 dialog 里）。 */
function zoomImage(): HTMLImageElement {
  const dialog = document.querySelector('[role="dialog"]');
  const imgs = Array.from(dialog?.querySelectorAll('img') ?? []) as HTMLImageElement[];
  return imgs[0]!;
}

/** 卡片里的缩略图 <img>（不在弹窗内的那张）。 */
function thumbImage(): HTMLImageElement {
  const all = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
  return all.find((el) => !el.closest('[role="dialog"]'))!;
}

describe('LiveViewImg 放大画面', () => {
  beforeEach(() => {
    // jsdom 无 canvas 实现：兜底快照走不通 → 只断言「提示不可用」那条路径。
    // （真实浏览器 canvas 可用，快照兜底另有 headless 实测。）
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('弹窗复用缩略图同一路资源（src 相同）——源结束后另开新请求必 404 裂图', () => {
    render(<LiveViewImg url="/api/explorations/s1/live" mode="frozen" />);
    const thumb = thumbImage();
    expect(thumb.getAttribute('src')).toBe('/api/explorations/s1/live');

    fireEvent.click(thumb);
    // 弹窗里的画面与缩略图同 URL → 浏览器复用同一路资源（内存缓存/在途响应）
    expect(zoomImage().getAttribute('src')).toBe(thumb.getAttribute('src'));
  });

  it('弹窗画面加载失败 → 提示不可用，不裂图', async () => {
    render(<LiveViewImg url="/api/explorations/s1/live" mode="frozen" />);
    fireEvent.click(thumbImage());
    fireEvent.error(zoomImage());
    await waitFor(() => expect(screen.getByText('画面不可用')).toBeTruthy());
    // 失败后不再渲染 <img>（不会有浏览器默认的裂图图标）
    expect(zoomImage()).toBeUndefined();
  });

  it('缩略图断流后重试（URL 加 ?r=）→ 弹窗跟缩略图同一后缀', async () => {
    vi.useFakeTimers();
    try {
      render(<LiveViewImg url="/api/explorations/s1/live" mode="live" retry />);
      const first = thumbImage();
      fireEvent.error(first); // 断流 → 隐藏
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000); // 2s 后重挂重连
      });
      const retried = thumbImage();
      expect(retried.getAttribute('src')).toBe('/api/explorations/s1/live?r=1');

      fireEvent.click(retried);
      expect(zoomImage().getAttribute('src')).toBe('/api/explorations/s1/live?r=1');
    } finally {
      vi.useRealTimers();
    }
  });
});
