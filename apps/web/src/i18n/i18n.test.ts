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
  // 用 glob 枚举而非逐个 import：新增 namespace 时测试自动覆盖，
  // 不必改测试本身（漏改才是这种漂移的根因）。
  const modules = import.meta.glob<Record<string, string>>('./locales/*/*.json', { eager: true });
  // i18next 的复数形态后缀是语言特性而非缺失：en 需要 _one/_other，zh 只需 _other。
  // 比对前剥掉后缀，两边折算成同一批「基础键」。
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


