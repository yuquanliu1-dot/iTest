import { describe, expect, it } from 'vitest';
import { localizeApiError } from './index';

describe('localizeApiError', () => {
  it('命中错误码目录返回本地化文案（默认 zh-CN）', () => {
    expect(localizeApiError({ code: 'forbidden' })).toBe('需要管理员或更高权限');
  });

  it('未知 code 回落原始 message', () => {
    expect(localizeApiError({ code: 'zzz', message: 'M' })).toBe('M');
  });

  it('空输入返回空串', () => {
    expect(localizeApiError(null)).toBe('');
    expect(localizeApiError({ message: 'raw' })).toBe('raw');
  });
});

describe('locale 键集对齐', () => {
  // Enumerate with glob instead of importing one by one: adding a namespace is automatically covered by the test,
  // no test change needed (a missed change is the root cause of this kind of drift).
  const modules = import.meta.glob<Record<string, string>>('./locales/*/*.json', { eager: true });
  // i18next's plural suffixes are a language feature, not a missing key: en needs _one/_other, zh only needs _other.
  // Strip the suffixes before comparing, folding both sides into the same set of "base keys".
  const PLURAL = /_(zero|one|two|few|many|other)$/;
  const baseKeys = (mod: Record<string, string>): string[] =>
    [...new Set(Object.keys(mod).map((k) => k.replace(PLURAL, '')))].sort();

  const byLocale = (locale: string): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const [path, mod] of Object.entries(modules)) {
      const ns = path.match(/locales\/[^/]+\/([^/]+)\.json$/)?.[1];
      if (!ns || !path.includes(`/${locale}/`)) continue;
      out[ns] = baseKeys(mod);
    }
    return out;
  };

  it('en-US 与 zh-CN 的 namespace 集合一致', () => {
    expect(Object.keys(byLocale('en-US')).sort()).toEqual(Object.keys(byLocale('zh-CN')).sort());
  });

  it('每个 namespace 的基础键集一致（漏翻一个键就是 UI 上的裸 key）', () => {
    const zh = byLocale('zh-CN');
    const en = byLocale('en-US');
    for (const ns of Object.keys(zh)) {
      expect(en[ns], `namespace「${ns}」的键集与 zh-CN 不一致`).toEqual(zh[ns]);
    }
  });
});


