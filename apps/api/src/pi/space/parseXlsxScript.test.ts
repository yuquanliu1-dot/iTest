import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import archiver from 'archiver';
import ExcelJS from 'exceljs';

const exec = promisify(execFile);
const SCRIPT = path.resolve(process.cwd(), 'scripts/xlsx-to-cases-content/scripts/parse_xlsx.py');

/** archiver 手拼 zip（边角用例要精确控制内部 XML，exceljs 不给这种自由度）。 */
async function buildZip(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'xlsx-'));
  const out = path.join(dir, 'fixture.xlsx');
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const sink = new Writable({
      write(c, _e, cb) { chunks.push(c as Buffer); cb(); },
    });
    archive.pipe(sink);
    for (const [name, body] of Object.entries(files)) archive.append(body, { name });
    void archive.finalize().then(async () => {
      await writeFile(out, Buffer.concat(chunks));
      resolve();
    }, reject);
  });
  return out;
}

/** exceljs 现造常规结构 xlsx。 */
async function buildXlsx(build: (wb: ExcelJS.Workbook) => void): Promise<string> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  const dir = await mkdtemp(path.join(tmpdir(), 'xlsx-'));
  const out = path.join(dir, 'fixture.xlsx');
  await writeFile(out, Buffer.from(await wb.xlsx.writeBuffer()));
  return out;
}

const NS = 'xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function lastJson(stdout: string): any {
  return JSON.parse(stdout.trim().split('\n').pop()!);
}

describe('parse_xlsx.py', () => {
  it('outline：sheet 清单/行列数/隐藏标注/合并单元格数（exceljs 真件）', async () => {
    const p = await buildXlsx((wb) => {
      const a = wb.addWorksheet('需求清单');
      a.addRow(['编号', '描述']);
      a.addRow(['REQ-001', '登录成功']);
      // mergeCells 会清空被合并的 slave cell(exceljs 行为):不能合并表头行,否则 B1 变空
      a.mergeCells('A2:B2');
      const h = wb.addWorksheet('隐藏配置');
      h.state = 'hidden';
      h.getCell('B2').value = 'x';
    });
    const out = lastJson((await exec('python3', [SCRIPT, p])).stdout);
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('outline');
    expect(out.stats.sheets).toBe(2);
    expect(out.sheets[0]).toMatchObject({ i: 0, name: '需求清单', rows: 2, cols: 2, hidden: false, merged: 1 });
    expect(out.sheets[0].header).toEqual(['编号', '描述']);
    expect(out.sheets[1]).toMatchObject({ name: '隐藏配置', hidden: true, rows: 1, cols: 2 });
  });

  it('--sheet：数据行带 Excel 行号、稀疏空洞补位、跳过全空行', async () => {
    const p = await buildXlsx((wb) => {
      const ws = wb.addWorksheet('S');
      ws.getCell('A1').value = 'a';
      ws.getCell('C1').value = 'c';
      ws.getCell('A3').value = 'next';
    });
    const out = lastJson((await exec('python3', [SCRIPT, p, '--sheet', '0'])).stdout);
    expect(out).toMatchObject({ ok: true, mode: 'sheet', name: 'S', totalRows: 2, truncated: false });
    expect(out.rows[0]).toEqual({ r: 1, c: ['a', '', 'c'] });
    expect(out.rows[1]).toEqual({ r: 3, c: ['next'] });
  });

  it('--sheet --rows：按 Excel 行号窗口取行', async () => {
    const p = await buildXlsx((wb) => {
      const ws = wb.addWorksheet('S');
      for (let i = 1; i <= 6; i++) ws.addRow([String(i)]);
    });
    const out = lastJson((await exec('python3', [SCRIPT, p, '--sheet', '0', '--rows', '3:4'])).stdout);
    expect(out.totalRows).toBe(2);
    expect(out.rows.map((r: any) => r.c[0])).toEqual(['3', '4']);
  });

  it('乱序 rId：sheet 顺序由 workbook.xml 声明序决定，与 sheetN.xml 文件名无关', async () => {
    // workbook 声明序 = [Beta(rId7→sheet2.xml), Alpha(rId1→sheet1.xml)]——文件名与顺序完全错开
    const p = await buildZip({
      'xl/workbook.xml': `<?xml version="1.0"?><s:workbook ${NS}><s:sheets>`
        + '<s:sheet name="Beta" sheetId="2" r:id="r7"/>'
        + '<s:sheet name="Alpha" sheetId="1" r:id="r1"/>'
        + '</s:sheets></s:workbook>',
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + '<Relationship Id="r7" Target="worksheets/sheet2.xml"/>'
        + '<Relationship Id="r1" Target="worksheets/sheet1.xml"/>'
        + '</Relationships>',
      // XML 语义:无前缀子元素不继承带前缀父元素的命名空间——row/c/is/t 必须同样带前缀,
      // 否则解析器的 iter('{main}row') 找不到任何行(真实 xlsx 用默认 xmlns,这里用前缀等价)。
      'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><s:worksheet ${NS}><s:sheetData>`
        + '<s:row r="1"><s:c r="A1" t="inlineStr"><s:is><s:t>alpha-data</s:t></s:is></s:c></s:row>'
        + '</s:sheetData></s:worksheet>',
      'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><s:worksheet ${NS}><s:sheetData>`
        + '<s:row r="1"><s:c r="A1" t="inlineStr"><s:is><s:t>beta-data</s:t></s:is></s:c></s:row>'
        + '</s:sheetData></s:worksheet>',
    });
    const out = lastJson((await exec('python3', [SCRIPT, p])).stdout);
    expect(out.sheets.map((s: any) => s.name)).toEqual(['Beta', 'Alpha']);
    const s1 = lastJson((await exec('python3', [SCRIPT, p, '--sheet', '1'])).stdout);
    expect(s1.rows[0].c[0]).toBe('alpha-data');
  });

  it('sharedStrings（含富文本 run）/布尔/无缓存公式/错误 cell（手拼 XML）', async () => {
    const p = await buildZip({
      'xl/workbook.xml': `<?xml version="1.0"?><s:workbook ${NS}><s:sheets><s:sheet name="T" sheetId="1" r:id="r1"/></s:sheets></s:workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>`,
      // 全元素带 s: 前缀(同上:无前缀子元素不在 main 命名空间,解析器找不到)
      'xl/sharedStrings.xml': `<?xml version="1.0"?><s:sst xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
        + '<s:si><s:t>表头甲</s:t></s:si><s:si><s:r><s:t>富</s:t></s:r><s:r><s:t>文本</s:t></s:r></s:si></s:sst>',
      'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><s:worksheet ${NS}><s:sheetData>`
        + '<s:row r="1"><s:c r="A1" t="s"><s:v>0</s:v></s:c><s:c r="B1" t="s"><s:v>1</s:v></s:c></s:row>'
        + '<s:row r="2"><s:c r="A2" t="b"><s:v>1</s:v></s:c><s:c r="B2"><s:f>A1</s:f></s:c><s:c r="C2" t="e"><s:v>#N/A</s:v></s:c><s:c r="D2"><s:v>3.14</s:v></s:c></s:row>'
        + '</s:sheetData></s:worksheet>',
    });
    const out = lastJson((await exec('python3', [SCRIPT, p, '--sheet', '0'])).stdout);
    expect(out.rows[0].c).toEqual(['表头甲', '富文本']);
    expect(out.rows[1].c).toEqual(['TRUE', '[formula]', '#N/A', '3.14']);
  });

  it('relss 缺条目报错；坏 XML 报 ok=false；zip 条目数护栏可环境变量收紧', async () => {
    // fail() 打印 ok=false JSON 后 sys.exit(1) → execFile reject；错误对象带 stdout，从中取 JSON
    const run = async (args: string[], env?: NodeJS.ProcessEnv) =>
      (await exec('python3', [SCRIPT, ...args], { env: env ? { ...process.env, ...env } : undefined }).catch((e) => e)) as {
        stdout: string;
      };
    const badRels = await buildZip({
      'xl/workbook.xml': `<?xml version="1.0"?><s:workbook ${NS}><s:sheets><s:sheet name="T" sheetId="1" r:id="r404"/></s:sheets></s:workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
    });
    const out1 = lastJson((await run([badRels])).stdout);
    expect(out1.ok).toBe(false);
    expect(out1.error).toContain('not found in rels');

    const badXml = await buildZip({
      'xl/workbook.xml': 'this is not xml <',
    });
    const out2 = lastJson((await run([badXml])).stdout);
    expect(out2.ok).toBe(false);

    const p = await buildXlsx((wb) => wb.addWorksheet('S').addRow(['v']));
    const out3 = lastJson((await run([p], { XLSX_MAX_ENTRIES: '1' })).stdout);
    expect(out3.ok).toBe(false); // 退出码 1：一个普通 xlsx 也有多个 zip 条目，护栏直接触发
  });

  it('参数校验：--rows 无 --sheet、非法范围、--sheet 越界', async () => {
    const p = await buildXlsx((wb) => wb.addWorksheet('S').addRow(['v']));
    // 同上：参数校验失败走 fail() → 非零退出 → execFile reject，从 err.stdout 取 JSON
    const run = async (args: string[]) => (await exec('python3', [SCRIPT, ...args]).catch((e) => e)) as { stdout: string };
    const e1 = lastJson((await run([p, '--rows', '1:2'])).stdout);
    expect(e1.ok).toBe(false);
    const e2 = lastJson((await run([p, '--sheet', '0', '--rows', '5:2'])).stdout);
    expect(e2.ok).toBe(false);
    const e3 = lastJson((await run([p, '--sheet', '9'])).stdout);
    expect(e3.ok).toBe(false);
    expect(e3.error).toContain('out of range');
  });
});
