/** R3.6 session metrics + suspicion score pure functions (no DB; fixture turns constructed directly). */
import { describe, it, expect } from 'vitest';
import type { ParsedTurn } from '../src/scheduler/trajectoryParse.js';
import { DEFAULT_SESSIONS_ROOT, computeSessionMetrics, sessionSuspicionScore } from '../src/pi/space/sessionSignals.js';

const turn = (p: Partial<ParsedTurn>): ParsedTurn => ({ role: 'user', text: '', toolCalls: [], ...p });
const asstCall = (id: string, name: string, args: Record<string, unknown>) =>
  turn({ role: 'assistant', toolCalls: [{ id, name, arguments: args }] });
const trErr = (err: boolean) => turn({ role: 'toolResult', isError: err });

describe('sessionSignals 纯函数', () => {
  it('DEFAULT_SESSIONS_ROOT 与 session.ts 同源（DATA_DIR/pi-sessions）', () => {
    expect(DEFAULT_SESSIONS_ROOT.endsWith('pi-sessions')).toBe(true);
  });
});

describe('computeSessionMetrics', () => {
  it('turns/toolCallsByName/verifyCalls/toolResultErrors 基础计数', () => {
    const turns = [
      turn({ role: 'user', text: 'u' }),
      asstCall('c1', 'verify_case', { caseId: 'a' }),
      trErr(false),
      asstCall('c2', 'query_db', {}),
      trErr(true),
      asstCall('c3', 'verify_case', { caseId: 'a' }),
      trErr(true),
    ];
    const m = computeSessionMetrics(turns);
    expect(m.turns).toBe(7);
    expect(m.toolCallsByName).toEqual({ verify_case: 2, query_db: 1 });
    expect(m.verifyCalls).toBe(2);
    expect(m.toolResultErrors).toBe(2);
  });

  it('durationMs=max-min timestamp；<2 个 timestamp → null', () => {
    expect(computeSessionMetrics([
      turn({ timestamp: 1_000 }),
      turn({ role: 'assistant' }),
      turn({ timestamp: 61_000 }),
    ]).durationMs).toBe(60_000);
    expect(computeSessionMetrics([turn({ timestamp: 1_000 })]).durationMs).toBeNull();
    expect(computeSessionMetrics([turn(), turn({ role: 'assistant' })]).durationMs).toBeNull();
  });

  it('repeatedIdenticalToolCalls：同 name+arguments 重复出现计数（超出首现的次数）', () => {
    const turns = [
      asstCall('a', 'verify_case', { caseId: 'x' }),
      asstCall('b', 'verify_case', { caseId: 'x' }), // same-args repeat, 1
      asstCall('c', 'verify_case', { caseId: 'x' }), // repeat again → total 2
      asstCall('d', 'verify_case', { caseId: 'y' }), // different args don't count
    ];
    expect(computeSessionMetrics(turns).repeatedIdenticalToolCalls).toBe(2);
    expect(computeSessionMetrics([asstCall('a', 't', {})]).repeatedIdenticalToolCalls).toBe(0);
  });
});

describe('sessionSuspicionScore', () => {
  const base = { durationMs: null, turns: 0, toolCallsByName: {}, toolResultErrors: 0, verifyCalls: 0, repeatedIdenticalToolCalls: 0 };
  const noCtx = { negativeFeedback: false, nlAiFailCount: 0 };

  it('时长：≥30min +3；≥10min +2；<10min 0；null 0', () => {
    expect(sessionSuspicionScore({ ...base, durationMs: 31 * 60_000 }, noCtx)).toBe(3);
    expect(sessionSuspicionScore({ ...base, durationMs: 11 * 60_000 }, noCtx)).toBe(2);
    expect(sessionSuspicionScore({ ...base, durationMs: 9 * 60_000 }, noCtx)).toBe(0);
  });

  it('verify：≥6 +4；≥3 +2；<3 0（分档不叠加）', () => {
    expect(sessionSuspicionScore({ ...base, verifyCalls: 6 }, noCtx)).toBe(4);
    expect(sessionSuspicionScore({ ...base, verifyCalls: 3 }, noCtx)).toBe(2);
    expect(sessionSuspicionScore({ ...base, verifyCalls: 2 }, noCtx)).toBe(0);
  });

  it('工具错误 ×2 封顶 4；重复调用 ≥2 +2；轮数 ≥20 +1', () => {
    expect(sessionSuspicionScore({ ...base, toolResultErrors: 1 }, noCtx)).toBe(2);
    expect(sessionSuspicionScore({ ...base, toolResultErrors: 3 }, noCtx)).toBe(4);
    expect(sessionSuspicionScore({ ...base, repeatedIdenticalToolCalls: 2 }, noCtx)).toBe(2);
    expect(sessionSuspicionScore({ ...base, repeatedIdenticalToolCalls: 1 }, noCtx)).toBe(0);
    expect(sessionSuspicionScore({ ...base, turns: 20 }, noCtx)).toBe(1);
  });

  it('负反馈 +3；nlAiFailCount 首条 +2 每多 +1 封顶 4', () => {
    expect(sessionSuspicionScore(base, { negativeFeedback: true, nlAiFailCount: 0 })).toBe(3);
    expect(sessionSuspicionScore(base, { negativeFeedback: false, nlAiFailCount: 1 })).toBe(2);
    expect(sessionSuspicionScore(base, { negativeFeedback: false, nlAiFailCount: 2 })).toBe(3);
    expect(sessionSuspicionScore(base, { negativeFeedback: false, nlAiFailCount: 4 })).toBe(4);
    expect(sessionSuspicionScore(base, { negativeFeedback: false, nlAiFailCount: 10 })).toBe(4);
  });

  it('组合样本：长会话+verify 死循环+错误+重复+轮数+负反馈 逐项相加', () => {
    const m = { durationMs: 35 * 60_000, turns: 25, toolCallsByName: {}, toolResultErrors: 2, verifyCalls: 7, repeatedIdenticalToolCalls: 3 };
    // 3(duration) + 4(verify) + 4(error cap) + 2(repeats) + 1(turns) + 3(negative feedback) = 17
    expect(sessionSuspicionScore(m, { negativeFeedback: true, nlAiFailCount: 0 })).toBe(17);
  });
});
