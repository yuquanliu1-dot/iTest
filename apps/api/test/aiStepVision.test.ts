import { describe, it, expect } from 'vitest';
import { planVision } from '../src/agent/aiStepVision.js';

describe('planVision', () => {
  it('returns useVision=false when no placeholder present', () => {
    const out = planVision('在搜索框输入"测试项目"');
    expect(out).toEqual({
      useVision: false,
      sourceSelector: undefined,
      outputSelector: undefined,
      cleanedInstruction: '在搜索框输入"测试项目"',
    });
  });

  it('extracts single #cssSelector as source', () => {
    const out = planVision('识别图片 #captchaImg 并输入');
    expect(out.useVision).toBe(true);
    expect(out.sourceSelector).toBe('#captchaImg');
    expect(out.outputSelector).toBeUndefined();
    expect(out.cleanedInstruction).toBe('识别图片  并输入');
  });

  it('extracts source + output placeholders in order', () => {
    const out = planVision('识别图片 #captchaImg 并输入到 #captchaInput');
    expect(out.sourceSelector).toBe('#captchaImg');
    expect(out.outputSelector).toBe('#captchaInput');
  });

  it('ignores # which is not start of placeholder (e.g. inside a quoted value)', () => {
    const out = planVision('点击"菜单 #1"按钮');
    expect(out.useVision).toBe(false);
    expect(out.cleanedInstruction).toBe('点击"菜单 #1"按钮');
  });

  it('throws on illegal characters in placeholder', () => {
    expect(() => planVision('识别图片 #captcha<img> 并输入')).toThrow(/InvalidVisionSelector/);
  });

  it('throws when more than two placeholders provided', () => {
    expect(() => planVision('识别 #a 填到 #b 比对 #c')).toThrow(/too many/);
  });
});
