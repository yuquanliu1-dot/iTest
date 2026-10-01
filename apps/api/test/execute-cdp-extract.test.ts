import { describe, it, expect } from 'vitest';

type ExtractArgs = {
  varName: string;
  mode?: 'completeValue' | 'regex';
  pattern?: string;
  group?: number;
};

const SAMPLE = '订单已提交：ORD-2048';

/** 从 cdp.ts dispatch 抓取 extract 处理逻辑：inline 最小分派，验证 vars 写入与失败语义。 */
async function runExtract(
  action: ExtractArgs,
  initialVars: Record<string, string> = {},
): Promise<{ vars: Record<string, string>; error?: string }> {
  const vars: Record<string, string> = { ...initialVars };
  try {
    // cdp.ts extract 分派：先 inputValue 失败再 innerText；这里模拟 innerText 返回固定样本。
    const raw = SAMPLE.trim();
    let resolved = raw;
    if (action.mode === 'regex') {
      if (!action.pattern) throw new Error(`extract-missing: var=${action.varName} 未配置 pattern`);
      const re = new RegExp(action.pattern, 'g');
      const matches = [...raw.matchAll(re)];
      if (matches.length === 0) {
        throw new Error(`extract-missing: var=${action.varName} pattern=${action.pattern} 无匹配 (raw="${raw.slice(0, 100)}")`);
      }
      const group = action.group ?? 0;
      const m = matches[0]!;
      resolved = group === 0 ? (m[0] ?? '') : (m[group] ?? '');
    }
    vars[action.varName] = resolved;
  } catch (e) {
    return { vars, error: (e as Error).message };
  }
  return { vars };
}

describe('extract dispatch', () => {
  it('completeValue writes trimmed raw text', async () => {
    const r = await runExtract({ varName: 'orderNo', mode: 'completeValue' });
    expect(r.error).toBeUndefined();
    expect(r.vars.orderNo).toBe('订单已提交：ORD-2048');
  });

  it('regex mode extracts captured group', async () => {
    const r = await runExtract({
      varName: 'orderNo',
      mode: 'regex',
      pattern: '订单已提交：([A-Z]+-\\d+)',
      group: 1,
    });
    expect(r.error).toBeUndefined();
    expect(r.vars.orderNo).toBe('ORD-2048');
  });

  it('regex mode without group returns whole match', async () => {
    const r = await runExtract({
      varName: 'orderNo',
      mode: 'regex',
      pattern: 'ORD-\\d+',
      group: 0,
    });
    expect(r.error).toBeUndefined();
    expect(r.vars.orderNo).toBe('ORD-2048');
  });

  it('regex mode no match throws with extract-missing', async () => {
    const r = await runExtract({
      varName: 'orderNo',
      mode: 'regex',
      pattern: 'NOMATCH',
    });
    expect(r.error).toMatch(/extract-missing/);
    expect(r.vars.orderNo).toBeUndefined();
  });

  it('regex mode without pattern throws', async () => {
    const r = await runExtract({ varName: 'orderNo', mode: 'regex' });
    expect(r.error).toMatch(/未配置 pattern/);
  });
});
