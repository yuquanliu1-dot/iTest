/**
 * Dataset Excel import: template generation + uploaded-file parsing.
 * Only produces the {columns, rows} draft payload; persistence still goes through datasets.service create/update (validation/encryption unified at save time).
 * The template has two sheets: "数据" (data) = first-row header + data rows (the only one parsing accepts); "说明" (guide) = filling rules.
 */
import ExcelJS from 'exceljs';
import { HttpError } from '../middleware/errorHandler.js';
import { validateVariableName } from '@itest/shared';

const DATA_SHEET = '数据';
const GUIDE_SHEET = '说明';
// Same criteria as datasets.service's save limits; the parsing layer intercepts first, error messages surfaced at the import site.
const MAX_COLUMNS = 30;
const MAX_ROWS = 500;

const DEFAULT_COLUMNS = ['username', 'password'];

export interface DatasetImportPayload {
  columns: Array<{ name: string; sensitive: false }>;
  rows: Array<{ disabled: false; cells: Record<string, string> }>;
}

/** Generates the import template: header (the caller may pass current draft column names; defaults username/password) + 1 example row + the "说明" (guide) sheet. */
export async function buildTemplateWorkbook(columns?: string[]): Promise<Buffer> {
  const headers = columns && columns.length > 0 ? columns : DEFAULT_COLUMNS;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(DATA_SHEET);
  ws.addRow(headers).font = { bold: true };
  ws.addRow(headers.map((_, i) => `示例值${i + 1}`));
  const guide = wb.addWorksheet(GUIDE_SHEET);
  guide.getColumn(1).width = 90;
  // Note: addRows with bare strings silently drops rows (exceljs only accepts arrays of rows); every row must be wrapped in []
  guide.addRows([
    ['1. 「数据」工作表首行为列名（即回放变量名 {{列名}}）：字母或下划线开头，仅含字母/数字/下划线。'],
    ['2. 第二行起每行一条数据；示例行请替换或删除后再上传。'],
    [`3. 上限：最多 ${MAX_COLUMNS} 列、${MAX_ROWS} 行。`],
    ['4. 敏感列（如密码）导入后在页面勾选「敏感」，将以加密存储。'],
  ]);
  // exceljs's ExcelJS.Buffer and @types/node 22's Buffer don't see eye to eye; explicitly narrowed to ArrayBuffer here
  const ab = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
  return Buffer.from(ab);
}

/** Parses an uploaded xlsx: first-row header (column names, must pass variable-name validation), then one data row per row.
 *  Values always come from cell.text (numbers/formulas stringified); cells are not trimmed (leading/trailing spaces in passwords are valid characters);
 *  all-empty rows are skipped. Duplicate columns aren't caught at the parsing layer (same as TSV paste); normalizeDataset is the fallback at save time. */
export async function parseImportWorkbook(buf: Buffer): Promise<DatasetImportPayload> {
  const wb = new ExcelJS.Workbook();
  try {
    // At runtime this flows straight into JSZip (Node Buffer is fine); exceljs's Buffer type and @types/node are mutually incompatible, this is only a type narrowing
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
