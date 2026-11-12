import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import LiveViewImg from './LiveViewImg';
import '../i18n';

/** The <img> in the zoom dialog (distinguished from the thumbnail <img>: that one lives inside the dialog). */
function zoomImage(): HTMLImageElement {
  const dialog = document.querySelector('[role="dialog"]');
  const imgs = Array.from(dialog?.querySelectorAll('img') ?? []) as HTMLImageElement[];
  return imgs[0]!;
}

/** The thumbnail <img> in the card (the one not inside the dialog). */
function thumbImage(): HTMLImageElement {
  const all = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
  return all.find((el) => !el.closest('[role="dialog"]'))!;
}

describe('LiveViewImg 放大画面', () => {
  beforeEach(() => {
    // jsdom has no canvas implementation: the snapshot fallback can't work → only assert the "unavailable hint" path.
    // (Real browsers have canvas; the snapshot fallback is separately verified in a headless run.)
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
    // The dialog's frame shares the thumbnail's URL → the browser reuses the same resource (memory cache / in-flight response)
    expect(zoomImage().getAttribute('src')).toBe(thumb.getAttribute('src'));
  });

  it('弹窗画面加载失败 → 提示不可用，不裂图', async () => {
    render(<LiveViewImg url="/api/explorations/s1/live" mode="frozen" />);
    fireEvent.click(thumbImage());
    fireEvent.error(zoomImage());
    await waitFor(() => expect(screen.getByText('画面不可用')).toBeTruthy());
    // After failure no <img> is rendered anymore (no browser default broken-image icon)
    expect(zoomImage()).toBeUndefined();
  });

  it('缩略图断流后重试（URL 加 ?r=）→ 弹窗跟缩略图同一后缀', async () => {
    vi.useFakeTimers();
    try {
      render(<LiveViewImg url="/api/explorations/s1/live" mode="live" retry />);
      const first = thumbImage();
      fireEvent.error(first); // stream broke → hidden
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000); // remount + reconnect after 2s
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
