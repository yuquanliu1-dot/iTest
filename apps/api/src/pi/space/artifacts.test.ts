import { describe, it, expect } from 'vitest';
import { contentDispositionUtf8 } from './artifacts.js';

describe('contentDispositionUtf8', () => {
  it('中文文件名走 filename*，ASCII 兜底不含非 ASCII', () => {
    const v = contentDispositionUtf8('V2.3-用例-20261026.xmind');
    expect(v.startsWith('attachment; filename="')).toBe(true);
    expect(v).toContain("filename*=UTF-8''");
    expect(v).toContain(encodeURIComponent('V2.3-用例-20261026.xmind'));
    const ascii = v.split(';')[1]!.trim();
    expect(/^filename="[ -~]+"$/.test(ascii)).toBe(true);
  });
});
