import { describe, it, expect } from 'vitest';
import { composeExplorationInstruction, coerceFindings, EXPLORATION_MAX_FINDINGS } from './explorationPrompt.js';
import { EXPLORATION_SYSTEM_PROMPT_BASE } from './explorationPrompt.js';
import { EXPLORATION_PERSONA_KEYS } from '@itest/shared';

describe('EXPLORATION_SYSTEM_PROMPT_BASE - 协议与安全规则', () => {
  it('动作协议与 runAiTask 解析器一致（坐标主通道 + 允许的五种动作类型）', () => {
    for (const t of ['"click"', '"fill"', '"press"', '"wait"', '"navigate"', '"screenshot"']) {
      expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain(t);
    }
  });

  it('findings 契约齐全（当轮报告 + severity 判级 + 不重报）', () => {
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('"findings"');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('reproSteps');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('同一缺陷只报一次');
  });

  it('安全底线在提示词层（不可逆操作禁止 + 二次确认弹窗一律取消）', () => {
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('一律不执行');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('二次确认弹窗一律取消');
  });

  it('范围约束（不离开被测站点）与探索导向（主动找茬）并存', () => {
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('不得离开被测站点');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('主动找茬');
  });
});

describe('composeExplorationInstruction', () => {
  const base = { startUrl: 'https://sut.example.com/app', charter: '探索用户管理页面，报告所有异常行为。', personaKey: 'qa' };

  it('含章程/视角指令/起点', () => {
    const s = composeExplorationInstruction(base);
    expect(s).toContain('探索用户管理页面');
    expect(s).toContain('https://sut.example.com/app');
    expect(s).toContain('通用测试员视角');
  });

  it('needsLoginPreamble=false → 无登录段；true → 含占位符', () => {
    const no = composeExplorationInstruction(base);
    expect(no).not.toContain('登录准备');
    const yes = composeExplorationInstruction({
      ...base,
      needsLoginPreamble: true,
      loginPlaceholders: { user: '__ITEST_USERNAME@web__', password: '__ITEST_PASSWORD@web__' },
    });
    expect(yes).toContain('登录准备');
    expect(yes).toContain('__ITEST_USERNAME@web__');
    expect(yes).toContain('__ITEST_PASSWORD@web__');
  });

  it('manifest 非空时携带', () => {
    const s = composeExplorationInstruction({ ...base, manifest: '- web（默认） https://x 已配置凭据' });
    expect(s).toContain('可选 web 服务');
    expect(s).toContain('已配置凭据');
  });

  it('未知 persona key 回落 qa 不抛错', () => {
    const s = composeExplorationInstruction({ ...base, personaKey: 'nope' });
    expect(s).toContain('通用测试员视角');
    expect(EXPLORATION_PERSONA_KEYS).toContain('qa');
  });
});

describe('coerceFindings', () => {
  const ok = { title: '删除按钮无二次确认', description: '点击删除直接生效', severity: 'P1', reproSteps: [{ action: '点击删除' }] };

  it('合法条目通过；severity 缺失/脏值 → P2 兜底', () => {
    const r = coerceFindings([ok, { title: 'B', description: 'b', severity: '高' }, { title: 'C', description: 'c' }]);
    expect(r.accepted.map((f) => f.severity)).toEqual(['P1', 'P2', 'P2']);
    expect(r.dropped).toBe(0);
  });

  it('空标题/空描述判非法丢弃；字段超长截断不丢条', () => {
    const r = coerceFindings([{ title: '', description: 'x' }, { title: '  ', description: 'x' }, { title: 'T', description: 'd'.repeat(5000) }]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.description).toHaveLength(4000);
    expect(r.dropped).toBe(2);
  });

  it('超配额截断：保留前 max 条，余者计 dropped', () => {
    const many = Array.from({ length: EXPLORATION_MAX_FINDINGS + 3 }, (_, i) => ({ title: `T${i}`, description: 'd' }));
    const r = coerceFindings(many);
    expect(r.accepted).toHaveLength(EXPLORATION_MAX_FINDINGS);
    expect(r.dropped).toBe(3);
  });

  it('max 覆盖 + 批内去重 + 跨轮去重（existingTitles 归一化后比对）', () => {
    const r1 = coerceFindings([ok, { ...ok }], { max: 5 });
    expect(r1.accepted).toHaveLength(1);
    // 尾随空格 + 大小写差异在 normalizeTitle 后视为同一条
    const r2 = coerceFindings([ok], { existingTitles: ['删除按钮无二次确认 '] });
    expect(r2.accepted).toHaveLength(0);
    expect(r2.dropped).toBe(1);
  });

  it('reproSteps 超 10 条截断；非法非对象条目丢弃', () => {
    const steps = Array.from({ length: 15 }, (_, i) => ({ action: `步骤${i}` }));
    const r = coerceFindings([{ title: 'T', description: 'd', reproSteps: steps }, 'not-an-object', null]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.reproSteps).toHaveLength(10);
    expect(r.dropped).toBe(2);
  });
});
