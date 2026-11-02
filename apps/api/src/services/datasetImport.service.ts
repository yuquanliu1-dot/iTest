/**
 * 数据集 Excel 导入：模板生成 + 上传文件解析。
 * 只产出 {columns, rows} 草稿载荷，落库仍走 datasets.service 的 create/update（保存时统一校验/加密）。
 * 模板两个 sheet：「数据」= 首行表头 + 数据行（解析只认它）；「说明」= 填写规则。
 */
import ExcelJS from 'exceljs';
import { HttpError } from '../middleware/errorHandler.js';
import { validateVariableName } from '@itest/shared';

const DATA_SHEET = '数据';
const GUIDE_SHEET = '说明';
// 与 datasets.service 的保存上限同口径；解析层先拦，错误消息在导入现场给出。
const MAX_COLUMNS = 30;
const MAX_ROWS = 500;

const DEFAULT_COLUMNS = ['username', 'password'];

export interface DatasetImportPayload {
  columns: Array<{ name: string; sensitive: false }>;
  rows: Array<{ disabled: false; cells: Record<string, string> }>;
}

/** 生成导入模板：表头（调用方可带当前草稿列名，缺省 username/password）+ 1 行示例值 +「说明」页。 */
export async function buildTemplateWorkbook(columns?: string[]): Promise<Buffer> {
  const headers = columns && columns.length > 0 ? columns : DEFAULT_COLUMNS;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(DATA_SHEET);
  ws.addRow(headers).font = { bold: true };
  ws.addRow(headers.map((_, i) => `示例值${i + 1}`));
  const guide = wb.addWorksheet(GUIDE_SHEET);
  guide.getColumn(1).width = 90;
  // 注意 addRows 传裸字符串会静默丢行（exceljs 只认行数组），每行须包一层 []
  guide.addRows([
    ['1. 「数据」工作表首行为列名（即回放变量名 {{列名}}）：字母或下划线开头，仅含字母/数字/下划线。'],
    ['2. 第二行起每行一条数据；示例行请替换或删除后再上传。'],
    [`3. 上限：最多 ${MAX_COLUMNS} 列、${MAX_ROWS} 行。`],
    ['4. 敏感列（如密码）导入后在页面勾选「敏感」，将以加密存储。'],
  ]);
  // exceljs 的 ExcelJS.Buffer 类型与 @types/node 22 的 Buffer 互相看不顺眼，这里显式收窄成 ArrayBuffer
  const ab = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
  return Buffer.from(ab);
}

/** 解析上传的 xlsx：首行表头（列名，须过变量名校验），其余每行一条数据。
 *  值一律取 cell.text（数字/公式字符串化）；单元格不做 trim（口令前后空格是有效字符）；
 *  全空行跳过。列重复不在解析层拦（同 TSV 粘贴），保存时 normalizeDataset 兜底。 */
export async function parseImportWorkbook(buf: Buffer): Promise<DatasetImportPayload> {
  const wb = new ExcelJS.Workbook();
  try {
    // 运行时直通 JSZip（Node Buffer 没问题），exceljs 的 Buffer 类型与 @types/node 互不兼容，这里仅类型收窄
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new HttpError(400, 'bad_request', '无法解析文件，请上传 .xlsx 格式的 Excel 文件');
  }
  const ws = wb.worksheets.find((w) => w.name === DATA_SHEET) ?? wb.worksheets[0];
  if (!ws) throw new HttpError(400, 'bad_request', '文件中没有工作表');

  const headerRow = ws.getRow(1);
  const width = Math.max(headerRow.cellCount, ws.columnCount);
  const headers: Array<{ pos: number; name: string }> = [];
  for (let pos = 1; pos <= width; pos++) {
    const name = String(headerRow.getCell(pos).text ?? '').trim();
    if (name) headers.push({ pos, name });
  }
  if (headers.length === 0) throw new HttpError(400, 'bad_request', '首行表头为空');
  const bad = headers.filter((h) => !validateVariableName(h.name).ok).map((h) => h.name);
  if (bad.length > 0) {
    throw new HttpError(400, 'bad_request', `列名不是合法变量名（字母/下划线开头，仅字母数字下划线）：${bad.join('、')}`);
  }
  if (headers.length > MAX_COLUMNS) {
    throw new HttpError(400, 'bad_request', `列数超上限（最多 ${MAX_COLUMNS} 列）`);
  }

  const rows: DatasetImportPayload['rows'] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells: Record<string, string> = {};
    for (const { pos, name } of headers) {
      const text = String(row.getCell(pos).text ?? '');
      if (text !== '') cells[name] = text;
    }
    if (Object.keys(cells).length === 0) return;
    rows.push({ disabled: false, cells });
  });
  if (rows.length === 0) throw new HttpError(400, 'bad_request', '至少需要表头 + 1 行数据');
  if (rows.length > MAX_ROWS) {
    throw new HttpError(400, 'bad_request', `行数超上限（最多 ${MAX_ROWS} 行）`);
  }

  return {
    columns: headers.map((h) => ({ name: h.name, sensitive: false as const })),
    rows,
  };
}
