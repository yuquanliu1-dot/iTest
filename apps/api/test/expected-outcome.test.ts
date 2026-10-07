import { describe, it, expect } from 'vitest';
import { materializeExpectedOutcome, maskSensitiveValues } from '../src/execute/cdp.js';

describe('materializeExpectedOutcome（行级预期物化）', () => {
  it('替换数据集列变量', () => {
    // 数据集列名受 validateVariableName 约束（ASCII 标识符），此处用合法列名
    expect(materializeExpectedOutcome('提交后页面应：{{expected_result}}', { expected_result: '登录框出现红色提示' }))
      .toBe('提交后页面应：登录框出现红色提示');
  });
  it('替换 extract 变量（未绑数据集同样受益）', () => {
    expect(materializeExpectedOutcome('订单号 {{orderNo}} 已显示', { orderNo: 'A123' })).toBe('订单号 A123 已显示');
  });
  it('未定义变量保留字面量（诚实失败）', () => {
    expect(materializeExpectedOutcome('应显示 {{ghost}}', {})).toBe('应显示 {{ghost}}');
  });
  it('报告侧脱敏：物化后文本落库前对敏感列值打码（LLM 提示按 §8.3 走明文）', () => {
    const vars = { password: 'pw-1', expected_result: '登录框出现红色提示' };
    const materialized = materializeExpectedOutcome('输入 {{password}} 后：{{expected_result}}', vars);
    expect(materialized).toBe('输入 pw-1 后：登录框出现红色提示');
    expect(maskSensitiveValues(materialized, vars, ['password'])).toBe('输入 ****** 后：登录框出现红色提示');
  });
});
