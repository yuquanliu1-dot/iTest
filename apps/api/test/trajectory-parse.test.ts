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

  /** 生产形态 verify rdata 正文（session 包装层 ok:true → isError:false，text 是 JSON 串）。 */
  const passedBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ result: 'passed', basedOn: 'staged', steps: [], ...extra });
  const failedBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ result: 'failed', basedOn: 'staged', failure: { stepOrder: 1, error: '找不到按钮' }, ...extra });
  const verifyLine = (callId: string, caseId: string, text: string, isError = false) => ([
    msgLine('assistant', [toolCallBlock(callId, 'verify_case', { caseId })]),
    msgLine('toolResult', [{ type: 'text', text }], { toolCallId: callId, toolName: 'verify_case', isError }),
  ]);

  it('findVerifiedLocalIds：passed+staged→收录；isError=true（infra）不收；只有别的 case 的成功不收', async () => {
    const { parseSessionJsonl, findVerifiedLocalIds } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [
      ...verifyLine('a', 'ok-1', passedBody()),
      ...verifyLine('b', 'infra-1', '验证失败: browser crashed', true),
      ...verifyLine('c', 'other', passedBody()),
    ].join('\n');
    const verified = findVerifiedLocalIds(parseSessionJsonl(jsonl), ['ok-1', 'infra-1']);
    expect(Array.from(verified)).toEqual(['ok-1']);
  });

  it('C1 负向：ok:true + result:"failed"（常规验证失败的生产形态）→ 不算证实', async () => {
    const { parseSessionJsonl, findVerifiedLocalIds } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [...verifyLine('a', 'loc-9', failedBody())].join('\n');
    expect(findVerifiedLocalIds(parseSessionJsonl(jsonl), ['loc-9']).size).toBe(0);
  });

  it('C1 负向：result:"passed" 但 basedOn:"db"（验的是撞名真用例非暂存草稿）→ 不算证实', async () => {
    const { parseSessionJsonl, findVerifiedLocalIds } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [...verifyLine('a', 'loc-9', JSON.stringify({ result: 'passed', basedOn: 'db' }))].join('\n');
    expect(findVerifiedLocalIds(parseSessionJsonl(jsonl), ['loc-9']).size).toBe(0);
  });

  it('I1 时序：passed 后同 localId 又 stage_case（改稿未复验）→ 不算；stage_case 是别的 localId → 不影响', async () => {
    const { parseSessionJsonl, findVerifiedLocalIds } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [
      ...verifyLine('a1', 'loc-a', passedBody()),
      msgLine('assistant', [toolCallBlock('a2', 'stage_case', { localId: 'loc-a', title: '改过的草稿' })]),
      ...verifyLine('b1', 'loc-b', passedBody()),
      msgLine('assistant', [toolCallBlock('b2', 'stage_case', { localId: 'loc-other', title: '别的草稿' })]),
    ].join('\n');
    const verified = findVerifiedLocalIds(parseSessionJsonl(jsonl), ['loc-a', 'loc-b']);
    expect(Array.from(verified)).toEqual(['loc-b']);
  });

  it('I1 末次胜：failed(JSON,isError:false)→修正 stage_case→再 verify passed → 算', async () => {
    const { parseSessionJsonl, findVerifiedLocalIds } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [
      ...verifyLine('d1', 'loc-1', failedBody()),
      msgLine('assistant', [toolCallBlock('d2', 'stage_case', { localId: 'loc-1', title: '修正后的草稿' })]),
      ...verifyLine('d3', 'loc-1', passedBody()),
    ].join('\n');
    expect(findVerifiedLocalIds(parseSessionJsonl(jsonl), ['loc-1']).size).toBe(1);
  });

  it('fail-closed：isError:false 但正文非 JSON（纯文本「通过」）→ 不算', async () => {
    const { parseSessionJsonl, findVerifiedLocalIds } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [...verifyLine('a', 'plain-1', '通过：终态达成')].join('\n');
    expect(findVerifiedLocalIds(parseSessionJsonl(jsonl), ['plain-1']).size).toBe(0);
  });

  it('stage_case 缺 localId 字段 → 不影响既有 passed 判定（不误杀）', async () => {
    const { parseSessionJsonl, findVerifiedLocalIds } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [
      ...verifyLine('a', 'loc-1', passedBody()),
      msgLine('assistant', [toolCallBlock('s', 'stage_case', { title: '缺 localId 的调用' })]),
    ].join('\n');
    expect(findVerifiedLocalIds(parseSessionJsonl(jsonl), ['loc-1']).size).toBe(1);
  });

  it('findVerifiedLocalIds：toolResult 缺 isError 字段——不算成功（fail-closed）', async () => {
    const { parseSessionJsonl, findVerifiedLocalIds } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [
      msgLine('assistant', [toolCallBlock('x', 'verify_case', { caseId: 'no-flag-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '结果未带错误标志' }], { toolCallId: 'x', toolName: 'verify_case' }), // 无 isError
    ].join('\n');
    const verified = findVerifiedLocalIds(parseSessionJsonl(jsonl), ['no-flag-1']);
    expect(verified.size).toBe(0);
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

  it('compressConversation：尾部截断保首条用户消息在头部（22min 长会话检索锚不丢）；总量仍 ≤ 预算', async () => {
    const { parseSessionJsonl, compressConversation } = await import('../src/scheduler/trajectoryParse.js');
    const lines = [msgLine('user', [{ type: 'text', text: '首条需求：为 SOC 事件管理建导出用例' }])];
    for (let i = 0; i < 12; i++) {
      lines.push(...[
        msgLine('assistant', [toolCallBlock(`c${i}`, 'verify_case', { caseId: `loc-${i}` })]),
        msgLine('toolResult', [{ type: 'text', text: `R${i}-` + 'x'.repeat(400) }], { toolCallId: `c${i}`, toolName: 'verify_case', isError: false }),
      ]);
    }
    const out = compressConversation(parseSessionJsonl(lines.join('\n')), 2_000);
    expect(out.startsWith('[用户] 首条需求')).toBe(true);
    expect(out).toContain('R11-'); // 最新上下文仍在（尾部截断语义保留）
    expect(out.length).toBeLessThanOrEqual(2_000);
  });

  it('compressConversation：首条用户消息本身超长 → 截到 2000 仍在头部', async () => {
    const { parseSessionJsonl, compressConversation } = await import('../src/scheduler/trajectoryParse.js');
    const lines = [
      msgLine('user', [{ type: 'text', text: '需'.repeat(5_000) }]),
      msgLine('assistant', [{ type: 'text', text: '收到' }]),
    ];
    const out = compressConversation(parseSessionJsonl(lines.join('\n')), 24_000);
    const firstLine = out.split('\n')[0]!;
    expect(firstLine.length).toBe(2_000); // 整行（含「[用户] 」标记）截到 2000
    expect(firstLine.startsWith(`[用户] ${'需'.repeat(1_000)}`)).toBe(true);
    expect(out).toContain('[助手] 收到');
  });
});
