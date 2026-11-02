import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildTemplateWorkbook, parseImportWorkbook } from './datasetImport.service.js';
import { HttpError } from '../middleware/errorHandler.js';

/** 按行构造「数据」sheet 的 xlsx（模拟用户上传的文件）。 */
async function buildSheet(rows: Array<Array<string | number>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('数据');
  for (const r of rows) ws.addRow(r);
  // exceljs Buffer 与 @types/node Buffer 类型互斥，运行时直通 JSZip，仅类型收窄
  return Buffer.from((await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer);
}

async function httpErrorOf(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('expected promise to reject');
}

describe('buildTemplateWorkbook → parseImportWorkbook roundtrip', () => {
  it('缺省表头 username/password + 1 行示例值，解析还原', async () => {
    const buf = await buildTemplateWorkbook();
    const out = await parseImportWorkbook(buf);
    expect(out.columns.map((c) => c.name)).toEqual(['username', 'password']);
    expect(out.columns.every((c) => c.sensitive === false)).toBe(true);
    expect(out.rows).toHaveLength(1);
    expect(Object.keys(out.rows[0]!.cells)).toEqual(['username', 'password']);
  });

  it('自定义列名写进模板表头（编辑已有数据集场景）', async () => {
    const buf = await buildTemplateWorkbook(['host', 'port']);
    const out = await parseImportWorkbook(buf);
    expect(out.columns.map((c) => c.name)).toEqual(['host', 'port']);
  });

  it('模板含「说明」sheet 且说明行落盘（addRows 裸字符串会静默丢行），解析仍取「数据」sheet', async () => {
    const buf = await buildTemplateWorkbook();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toContain('说明');
    const guide = wb.getWorksheet('说明')!;
    expect(guide.actualRowCount).toBeGreaterThanOrEqual(4);
    expect(String(guide.getRow(2).getCell(1).text)).toContain('示例行');
  });
});

describe('parseImportWorkbook', () => {
  it('多行数据 + 数字单元格字符串化 + 全空行跳过', async () => {
    const buf = await buildSheet([
      ['username', 'age'],
      ['alice', 30],
      ['', ''],
      ['bob', 25],
    ]);
    const out = await parseImportWorkbook(buf);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]!.cells).toEqual({ username: 'alice', age: '30' });
    expect(out.rows[1]!.cells).toEqual({ username: 'bob', age: '25' });
  });

  it('单元格值不做 trim（口令前后空格是有效字符）', async () => {
    const buf = await buildSheet([['password'], [' p@ss ']]);
    const out = await parseImportWorkbook(buf);
    expect(out.rows[0]!.cells.password).toBe(' p@ss ');
  });

  it('没有「数据」sheet 时取第一个 sheet（用户自建文件兜底）', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['username']);
    ws.addRow(['carol']);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer);
    const out = await parseImportWorkbook(buf);
    expect(out.rows[0]!.cells.username).toBe('carol');
  });

  it('中文表头 → 400 且消息列出坏列名', async () => {
    const buf = await buildSheet([['username', '用户名'], ['alice', 'x']]);
    const e = await httpErrorOf(parseImportWorkbook(buf));
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(400);
    expect(e.message).toContain('用户名');
  });

  it('只有表头没有数据行 → 400', async () => {
    const buf = await buildSheet([['username']]);
    const e = await httpErrorOf(parseImportWorkbook(buf));
    expect(e.status).toBe(400);
    expect(e.message).toContain('至少需要表头 + 1 行');
  });

  it('超 500 行 → 400', async () => {
    const rows: Array<Array<string | number>> = [['username']];
    for (let i = 0; i < 501; i++) rows.push([`u${i}`]);
    const buf = await buildSheet(rows);
    const e = await httpErrorOf(parseImportWorkbook(buf));
    expect(e.status).toBe(400);
    expect(e.message).toContain('行数超上限');
  });

  it('超 30 列 → 400', async () => {
    const headers = Array.from({ length: 31 }, (_, i) => `col_${i}`);
    const buf = await buildSheet([headers, headers.map(() => 'v')]);
    const e = await httpErrorOf(parseImportWorkbook(buf));
    expect(e.status).toBe(400);
    expect(e.message).toContain('列数超上限');
  });

  it('表头为空 → 400；非 xlsx 文件 → 400 提示格式', async () => {
    const emptyHeader = await buildSheet([['', ''], ['a', 'b']]);
    const e1 = await httpErrorOf(parseImportWorkbook(emptyHeader));
    expect(e1.status).toBe(400);
    expect(e1.message).toContain('表头为空');

    const e2 = await httpErrorOf(parseImportWorkbook(Buffer.from('这不是 excel')));
    expect(e2.status).toBe(400);
    expect(e2.message).toContain('.xlsx');
  });
});
