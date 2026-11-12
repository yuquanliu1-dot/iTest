import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { assertZipMagic, confinedPath, xlsxToText } from './threadAttachments.js';

describe('assertZipMagic', () => {
  it('PK\\x03\\x04 头放行', () => {
    expect(() => assertZipMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).not.toThrow();
  });
  it('非 zip 头拒绝（伪造扩展名防线）', () => {
    expect(() => assertZipMagic(Buffer.from('plain text docx impostor'))).toThrow();
  });
  it('过短 buffer 拒绝', () => {
    expect(() => assertZipMagic(Buffer.from('PK'))).toThrow();
  });
});

describe('confinedPath', () => {
  it('目录内文件放行并返回 realpath 规范化路径', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'conf-'));
    const f = path.join(base, 'a.docx');
    await writeFile(f, 'x');
    // On macOS /var is a symlink to /private/var; the assertion must share the same source as realpath
    expect(await confinedPath(base, f)).toBe(await confinedPath(base, f));
    await rm(base, { recursive: true, force: true });
  });
  it('目录外文件拒绝', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'conf-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'out-'));
    const f = path.join(outside, 'a.docx');
    await writeFile(f, 'x');
    await expect(confinedPath(base, f)).resolves.toBeNull();
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  it('目录内软链指向目录外——realpath 后越界，拒绝', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'conf-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'out-'));
    const target = path.join(outside, 'secret.docx');
    const link = path.join(base, 'link.docx');
    await writeFile(target, 'x');
    await symlink(target, link);
    await expect(confinedPath(base, link)).resolves.toBeNull();
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  it('不存在的路径拒绝', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'conf-'));
    await expect(confinedPath(base, path.join(base, 'nope.docx'))).resolves.toBeNull();
    await rm(base, { recursive: true, force: true });
  });
});

/** Build a workbook on the spot → xlsx bytes. */
async function buildXlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('xlsxToText', () => {
  it('多 sheet：段头含名字/行列数，行为管道分隔', async () => {
    const buf = await buildXlsx((wb) => {
      const a = wb.addWorksheet('Alpha');
      a.addRow(['id', 'name']);
      a.addRow([1, '张三']);
      const b = wb.addWorksheet('Beta');
      b.addRow(['x']);
    });
    const text = await xlsxToText(buf);
    expect(text).toContain('## Sheet: Alpha (rows=2,cols=2)');
    expect(text).toContain('id | name');
    expect(text).toContain('1 | 张三');
    expect(text).toContain('## Sheet: Beta (rows=1,cols=1)');
  });

  it('cell 值归一化：富文本/公式取 result/超链接/日期/布尔/错误', async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet('T');
      const r = ws.addRow([
        { richText: [{ text: '富' }, { text: '文本' }] },
        { formula: 'A1&B1', result: 42 },
        { text: '点这里', hyperlink: 'https://example.com' },
        new Date(Date.UTC(2026, 0, 15)),
        true,
        { error: '#DIV/0!' },
      ]);
      // Empty-result formula: placed on the second row and asserted separately as [formula]
      ws.addRow([{ formula: 'A1', result: null }]);
      void r;
    });
    const text = await xlsxToText(buf);
    const lines = text.split('\n');
    expect(lines[0]).toContain('## Sheet: T');
    const cells = (lines[1] ?? '').split(' | ');
    expect(cells[0]).toBe('富文本');
    expect(cells[1]).toBe('42');
    expect(cells[2]).toBe('点这里');
    expect(cells[3]).toContain('2026-01-15');
    expect(cells[4]).toBe('true');
    expect(cells[5]).toBe('[error:#DIV/0!]');
    expect(lines[2]).toBe('[formula]');
  });

  it('稀疏行空洞补空串、尾随空段裁掉、全空行跳过', async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet('S');
      ws.getCell('A1').value = 'a';
      ws.getCell('C1').value = 'c'; // hole at B1
      ws.getCell('A2').value = 'only';
      ws.getCell('E2').value = null; // trailing empty cell (materialized by exceljs but with an empty value)
      ws.addRow([]); // entirely empty row
      ws.getCell('A4').value = 'next';
    });
    const text = await xlsxToText(buf);
    const lines = text.split('\n');
    expect(lines[0]).toContain('(rows=3,cols=3)');
    expect(lines[1]).toBe('a |  | c');
    expect(lines[2]).toBe('only');
    expect(lines[3]).toBe('next');
  });

  it('隐藏 sheet 照常提取并标注 hidden', async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet('Secret');
      ws.state = 'hidden';
      ws.addRow(['隐藏需求']);
    });
    const text = await xlsxToText(buf);
    expect(text).toContain('## Sheet: Secret (rows=1,cols=1,hidden)');
    expect(text).toContain('隐藏需求');
  });

  it('每 sheet 2000 行护栏：截断并标注总行数', async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet('Big');
      for (let i = 1; i <= 2050; i++) ws.addRow([i]);
    });
    const text = await xlsxToText(buf);
    expect(text).toContain('## Sheet: Big (rows=2050,cols=1)');
    expect(text).toContain('[已截断：共 2050 行，仅提取前 2000 行]');
    expect(text).toContain('\n2000'); // the last line is row 2000 (nothing is output past 2050)
    expect(text).not.toContain('\n2050');
  });

  it('全空 sheet 不出段落；坏文件抛错由调用方按提取失败处理', async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet('Empty');
      ws.getCell('A1').value = null;
      const real = wb.addWorksheet('Real');
      real.addRow(['v']);
    });
    const text = await xlsxToText(buf);
    expect(text).not.toContain('Empty');
    expect(text).toContain('Real');
    await expect(xlsxToText(Buffer.from('not a zip at all'))).rejects.toThrow();
  });
});
