/**
 * GitHub-style label color utilities.
 * 根据背景色亮度选黑/白文字，匹配 issue 标签的常见渲染方式。
 */

function parseHex(hex: string): [number, number, number] {
  const cleaned = hex.replace('#', '');
  const r = parseInt(cleaned.substring(0, 2), 16);
  const g = parseInt(cleaned.substring(2, 4), 16);
  const b = parseInt(cleaned.substring(4, 6), 16);
  return [r, g, b];
}

function luminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** 背景 hex → 前景文本色（黑/白），提供足够对比度。 */
export function labelTextColor(bgHex: string): string {
  const [r, g, b] = parseHex(bgHex);
  return luminance(r, g, b) < 0.35 ? '#ffffff' : '#1f2328';
}

/** 略淡化的 hex（未选中态背景，≈ 白底上 14% 透明度）。 */
export function labelBgLight(hex: string): string {
  const [r, g, b] = parseHex(hex);
  const mix = (c: number) => Math.round(c * 0.14 + 255 * 0.86);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}
