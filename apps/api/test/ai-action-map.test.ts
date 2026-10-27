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

describe('mapAiActionsToCompiled :has-text 选择器', () => {
  it('尾缀 :has-text("Y")（伪类修饰目标元素本身）→ text 定位（prod228 查询按钮整步 aiTask 的映射缺口）', () => {
    const r = mapAiActionsToCompiled([{ type: 'click', selector: 'button:has-text("查询")' }]);
    expect(r).toEqual({ ok: true, skippedCount: 0, compiled: [{ kind: 'click', locator: [{ strategy: 'text', value: '查询' }] }] });
  });

  it('中段 :has-text（目标是伪类之后的元素）语义不保真 → 仍按专有语法拒绝', () => {
    const r = mapAiActionsToCompiled([{ type: 'fill', selector: 'div:has-text("x") input', value: 'v' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('Playwright 专有语法');
  });
});

describe('mapAiActionsToCompiled 坐标动作（未解析回 selector）', () => {
  it('click/fill 无 selector（坐标未解析回稳定选择器）→ 整步保守保持 aiTask', () => {
    const r = mapAiActionsToCompiled([
      { type: 'click', x: 500, y: 400 },
      { type: 'fill', x: 200, y: 100, value: 'v' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('未解析回稳定选择器');
  });

  it('坐标动作解析回 selector 后（onAction 已回填）照常固化', () => {
    const r = mapAiActionsToCompiled([
      { type: 'click', selector: '#hit' },
      { type: 'fill', selector: '#name', value: '分类A' },
    ]);
    expect(r.ok).toBe(true);
  });
});
