/**
 * "Result summary" of the session action trail (pi path).
 *
 * Background: the trail used to record only actions (type/target/ok), so the detail page's "Session Activity" was full of
 * "Observe page -", "In-page script -", "Screenshot -" — the action was there, the conclusion absent; users saw no value in the process.
 * Fix: the tool layer produces details.summary (result summary); the runner lands it in the trail's outcome field.
 *
 * Acceptance items:
 *  - Every tool's success/failure result carries a summary (summary = what this step saw / why it failed);
 *  - summary does not enter the model context (the details field does not go into content);
 *  - The trail draft covers inject_fault (the mode name must be visible);
 *  - Tool gave no summary but is judged failed → reason extracted from the error text as fallback.
 */
import { describe, it, expect } from 'vitest';
import { fallbackFailureReason, readToolSummary } from '../src/pi/exploration/trail.js';
import { trailStepOf } from '../src/pi/exploration/tools/index.js';
import { trailToSteps } from '../src/execute/explorationPrompt.js';

/** The summary of a tool result (details field). */
function summaryOf(result: unknown): string | undefined {
  return readToolSummary(result);
}

describe('留痕结果摘要（outcome）', () => {
  it('inject_fault 工具：成功/失败都带摘要，模式名可见', async () => {
    const { createInjectFaultTool } = await import('../src/pi/exploration/tools/fault.js');
    const tool = createInjectFaultTool({
      fault: {
        apply: async () => undefined,
        reset: async () => undefined,
        current: () => 'none',
      },
    });

    const ok = await tool.execute('f1', { mode: 'offline' });
    expect(summaryOf(ok)).toBe('已注入故障：offline');
    expect(ok.isError).toBeFalsy();

    const restored = await tool.execute('f2', { mode: 'none' });
    expect(summaryOf(restored)).toBe('已复原（无故障）');

    const bad = await tool.execute('f3', { mode: 'banana' });
    expect(bad.isError).toBe(true);
    expect(summaryOf(bad)).toContain('模式非法');
  }, 20000);

  it('navigate 工具：越界被拒的摘要写明原因（详情页要能看出「为什么没成」）', async () => {
    const { createNavigateTool } = await import('../src/pi/exploration/tools/browser.js');
    const tool = createNavigateTool({
      page: {} as never,
      vision: true,
      scopeOrigins: ['http://sut.example.com'],
    });

    const rejected = await tool.execute('n1', { url: 'https://example.com' });
    expect(rejected.isError).toBe(true);
    expect(summaryOf(rejected)).toContain('越界被拒');

    const notAbsolute = await tool.execute('n2', { url: '/relative' });
    expect(notAbsolute.isError).toBe(true);
    expect(summaryOf(notAbsolute)).toContain('导航地址非法');
  }, 20000);

  it('evaluate 工具：禁用操作/空表达式的失败摘要带原因', async () => {
    const { createEvaluateTool } = await import('../src/pi/exploration/tools/evaluate.js');
    const tool = createEvaluateTool({ page: {} as never });

    const denied = await tool.execute('e1', { expression: 'fetch("/x")' });
    expect(denied.isError).toBe(true);
    expect(summaryOf(denied)).toContain('禁用操作');

    const empty = await tool.execute('e2', { expression: '  ' });
    expect(empty.isError).toBe(true);
    expect(summaryOf(empty)).toContain('表达式为空');
  }, 20000);

  it('摘要不进模型上下文（details 与 content 分离）', async () => {
    const { createInjectFaultTool } = await import('../src/pi/exploration/tools/fault.js');
    const tool = createInjectFaultTool({
      fault: {
        apply: async () => undefined,
        reset: async () => undefined,
        current: () => 'none',
      },
    });
    const r = await tool.execute('f1', { mode: 'offline' });
    // content holds only the text shown to the model; the summary goes via details.
    const text = (r.content as Array<{ type: string; text?: string }>).map((b) => b.text).join('');
    expect(text).toContain('已注入故障');
    expect(text).not.toContain('details');
    expect((r as { details?: { summary?: string } }).details?.summary).toBe('已注入故障：offline');
  }, 20000);

  it('留痕初稿：inject_fault 记模式名（原来落进默认分支变成 "-"）', async () => {
    const step = trailStepOf('inject_fault', { mode: 'offline' });
    expect(step).toEqual({ type: 'inject_fault', target: 'offline', ok: true });
    // Promoted-case reproduction steps must also show this step.
    expect(trailToSteps([{ type: 'inject_fault', target: 'offline' }])).toEqual([{ action: '注入故障 offline' }]);
  }, 20000);

  it('摘要兜底：工具没给 summary 但判失败 → 从错误文本摘原因', () => {
    expect(readToolSummary({ details: { summary: '  已点击  ' } })).toBe('已点击');
    expect(readToolSummary({ details: undefined })).toBeUndefined();
    expect(readToolSummary(undefined)).toBeUndefined();

    const reason = fallbackFailureReason({
      content: [{ type: 'text', text: 'click #x: error 目标不可见。先 observe 核对当前页面。' }],
    });
    expect(reason).toContain('目标不可见');
    expect(fallbackFailureReason({ content: [] })).toBeUndefined();
  }, 20000);
});
