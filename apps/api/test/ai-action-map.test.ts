import { describe, it, expect } from 'vitest';
import { mapAiActionsToCompiled } from '../src/execute/aiActionMap.js';

describe('mapAiActionsToCompiled 凭据占位符', () => {
  it('带 @ref 的 fill 同样不固化（固化会把字面量冻进 compiled）', () => {
    const r = mapAiActionsToCompiled([
      { type: 'click', selector: '#submit' },
      { type: 'fill', selector: '#u', value: '__ITEST_USERNAME@backend__' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/凭据占位符/);
    // 文案要点名 @归属 形态——模型/用户看到原因才知道是「这个服务的凭据」也被拒了
    expect(r.ok === false && r.reason).toContain('@');
  });

  it('普通 fill 照常固化；watch 截图跳过不阻断', () => {
    const r = mapAiActionsToCompiled([
      { type: 'screenshot', selector: '#captcha' },
      { type: 'fill', selector: '#name', value: '张三' },
      { type: 'wait', ms: 1500 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.compiled).toEqual([
      { kind: 'fill', locator: [{ strategy: 'css', value: '#name' }], value: '张三' },
      { kind: 'waitFor', locator: [], timeoutMs: 1500 },
    ]);
    expect(r.ok && r.skippedCount).toBe(1);
  });
});
