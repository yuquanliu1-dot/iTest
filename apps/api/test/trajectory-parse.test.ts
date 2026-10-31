import { describe, it, expect } from 'vitest';

/** 造一条 JSONL 行的辅助（形状见计划「已核实的关键代码事实」）。 */
function msgLine(role: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'message', id: Math.random().toString(36).slice(2), parentId: null, timestamp: new Date().toISOString(), message: { role, content, ...extra } });
}
const toolCallBlock = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'toolCall', id, name, arguments: args });

describe('trajectoryParse：JSONL → 会话轮次', () => {
  it('parseSessionJsonl：user/assistant/toolResult 三类各就位；非 message 行跳过；坏行跳过', async () => {
    const { parseSessionJsonl } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [
      JSON.stringify({ type: 'session', version: 3, id: 't1', timestamp: 'x', cwd: '/x' }),
      msgLine('system', ''),
      msgLine('user', [{ type: 'text', text: '帮我建登录失败用例' }]),
      msgLine('assistant', [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '我先暂存草稿' }, toolCallBlock('c1', 'stage_case', { caseId: 'loc-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '已暂存' }], { toolCallId: 'c1', toolName: 'stage_case', isError: false }),
      '{broken json',
      msgLine('assistant', [{ type: 'text', text: '跑一下验证' }, toolCallBlock('c2', 'verify_case', { caseId: 'loc-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '通过：终态达成' }], { toolCallId: 'c2', toolName: 'verify_case', isError: false }),
    ].join('\n');
    const turns = parseSessionJsonl(jsonl);
    expect(turns.filter((t) => t.role === 'user')).toHaveLength(1);
    const a1 = turns.find((t) => t.role === 'assistant' && t.toolCalls.some((c) => c.name === 'stage_case'))!;
    expect(a1.text).toContain('我先暂存草稿');
    expect(turns.filter((t) => t.role === 'toolResult')).toHaveLength(2);
  });

  it('findVerifiedLocalIds：verify_case 成功→收录；isError=true 不收；只有别的 case 的成功不收；多次调用末次成功即成功', async () => {
    const { parseSessionJsonl, findVerifiedLocalIds } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [
      msgLine('assistant', [toolCallBlock('a', 'verify_case', { caseId: 'ok-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '通过' }], { toolCallId: 'a', toolName: 'verify_case', isError: false }),
      msgLine('assistant', [toolCallBlock('b', 'verify_case', { caseId: 'fail-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '失败：找不到按钮' }], { toolCallId: 'b', toolName: 'verify_case', isError: true }),
      msgLine('assistant', [toolCallBlock('c', 'verify_case', { caseId: 'other' })]),
      msgLine('toolResult', [{ type: 'text', text: '通过' }], { toolCallId: 'c', toolName: 'verify_case', isError: false }),
      msgLine('assistant', [toolCallBlock('d', 'verify_case', { caseId: 'retry-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '失败' }], { toolCallId: 'd', toolName: 'verify_case', isError: true }),
      msgLine('assistant', [toolCallBlock('e', 'verify_case', { caseId: 'retry-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '通过' }], { toolCallId: 'e', toolName: 'verify_case', isError: false }),
    ].join('\n');
    const turns = parseSessionJsonl(jsonl);
    const verified = findVerifiedLocalIds(turns, ['ok-1', 'fail-1', 'retry-1']);
    expect(Array.from(verified).sort()).toEqual(['ok-1', 'retry-1']);
  });

  it('compressConversation：user 全文 / assistant 文本（无 thinking）/ toolCall 行 / toolResult 截断；总量限预算', async () => {
    const { parseSessionJsonl, compressConversation } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [
      msgLine('user', [{ type: 'text', text: '建登录用例' }]),
      msgLine('assistant', [{ type: 'thinking', thinking: '内部思考不该出现' }, { type: 'text', text: '好的' }, toolCallBlock('c1', 'stage_case', { caseId: 'x', title: '登录' })]),
      msgLine('toolResult', [{ type: 'text', text: '长'.repeat(2000) }], { toolCallId: 'c1', toolName: 'stage_case', isError: false }),
    ].join('\n');
    const out = compressConversation(parseSessionJsonl(jsonl), 3_000);
    expect(out).toContain('[用户] 建登录用例');
    expect(out).toContain('[助手] 好的');
    expect(out).toContain('stage_case');
    expect(out).not.toContain('内部思考不该出现');
    expect(out.length).toBeLessThanOrEqual(3_200); // 截断容差
  });
});
