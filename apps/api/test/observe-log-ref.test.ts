/**
 * observeLog.syslogRef 的【取哪个连接】决策测试。
 * 不连真 SSH —— 只验 ref → label → 连接的解析链，以及「显式 ref 落空即硬错误」。
 */
import { describe, it, expect, vi } from 'vitest';
import type { EnvCtx } from '../src/execute/envContext.js';

vi.mock('playwright-core', () => ({ chromium: { launch: vi.fn() } }));

/** 最小 EnvCtx 桩：只提供 resolveSyslog 用到的东西。 */
function makeCtx(syslogs: Array<{ label: string; ctx: { host: string; port: number; user: string; filePath: string; authType: 'key' | 'password' }; isDefault: boolean }>): EnvCtx {
  return {
    envName: '测试环境',
    resolveSyslog: (ref?: string | null) => {
      if (ref) return syslogs.find((s) => s.label === ref)?.ctx ?? null;
      return (syslogs.find((s) => s.isDefault) ?? syslogs[0])?.ctx ?? null;
    },
  } as unknown as EnvCtx;
}

const base = { host: 'h1', port: 22, user: 'u1', filePath: '/var/log/a.log', authType: 'key' as const };
const alt = { host: 'h2', port: 2222, user: 'u2', filePath: '/var/log/b.log', authType: 'key' as const };

describe('observeLog syslogRef 解析', () => {
  it('显式 syslogRef → 取对应 label 的连接', () => {
    const syslogs = [
      { label: '主日志机', ctx: base, isDefault: true },
      { label: '审计机', ctx: alt, isDefault: false },
    ];
    expect(makeCtx(syslogs).resolveSyslog('审计机')).toBe(alt);
  });

  it('缺省 → isDefault；显式 ref 不存在 → null（绝不静默回落默认）', () => {
    const syslogs = [
      { label: '主日志机', ctx: base, isDefault: true },
      { label: '审计机', ctx: alt, isDefault: false },
    ];
    expect(makeCtx(syslogs).resolveSyslog()?.host).toBe('h1');
    expect(makeCtx(syslogs).resolveSyslog('nope')).toBeNull();
  });

  it('无 isDefault 标记时取最早一条', () => {
    const syslogs = [
      { label: '甲', ctx: base, isDefault: false },
      { label: '乙', ctx: alt, isDefault: false },
    ];
    expect(makeCtx(syslogs).resolveSyslog()?.host).toBe('h1');
  });

  it('一条都没有 → null（调用方据此抛 EnvSyslogMissing）', () => {
    expect(makeCtx([]).resolveSyslog()).toBeNull();
    expect(makeCtx([]).resolveSyslog('x')).toBeNull();
  });
});