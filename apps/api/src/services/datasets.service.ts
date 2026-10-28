/**
 * 数据集领域服务：项目级测试数据集 CRUD + 回放数据装载。
 * 敏感列单元格以 AES-256-GCM {c,i,t} 加密存 rows jsonb；出参一律 {__masked:true} 占位。
 * 列名即变量名（回放时注入 {{列名}}），须过 validateVariableName。
 */
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { datasets, testCases } from '../db/schema.js';
import type { DatasetColumn, DatasetRow, DatasetEncCell } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { encrypt, decrypt } from '../lib/secret-crypto.js';
import { attachCreators, attachCreator } from '../lib/creator.js';
import { validateVariableName } from '@itest/shared';

export const DATASET_MASKED_CELL = { __masked: true } as const;
export type DatasetMaskedCell = { __masked: true };
const MAX_COLUMNS = 30;
const MAX_ROWS = 500;

/** 回放数据集配置错误（无启用行/列名非法等）。执行入口映射 400；计划内映射该用例 failed。 */
export class DatasetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetConfigError';
  }
}

export interface DatasetSaveBody {
  name: string;
  description?: string | null;
  columns: Array<{ name: string; sensitive?: boolean }>;
  rows: Array<{ disabled?: boolean; cells: Record<string, unknown> }>;
  /** 列改名声明（旧列名 → 新列名）：__masked 占位按行对齐时把旧密文 re-key 到新列名，否则改名会静默清空密文。 */
  renames?: Record<string, string>;
}

function isEncCell(v: unknown): v is DatasetEncCell {
  return typeof v === 'object' && v !== null
    && typeof (v as DatasetEncCell).c === 'string'
    && typeof (v as DatasetEncCell).i === 'string'
    && typeof (v as DatasetEncCell).t === 'string';
}

function isMaskedCell(v: unknown): v is DatasetMaskedCell {
  return typeof v === 'object' && v !== null && (v as { __masked?: boolean }).__masked === true;
}

function encryptCell(plain: string): DatasetEncCell {
  const e = encrypt(plain);
  return { c: e.ciphertext.toString('base64'), i: e.iv.toString('base64'), t: e.tag.toString('base64') };
}

function decryptCell(cell: DatasetEncCell): string {
  return decrypt({
    ciphertext: Buffer.from(cell.c, 'base64'),
    iv: Buffer.from(cell.i, 'base64'),
    tag: Buffer.from(cell.t, 'base64'),
  });
}

/** 保存前校验 + 归一。prev 行按索引对齐：__masked 占位按行下标沿用旧密文
 *  （前端语义：没改过的敏感格原样回传；改行顺序时应同步改值，不做跨行追踪）。 */
function normalizeDataset(
  input: DatasetSaveBody,
  prev?: { columns: DatasetColumn[]; rows: DatasetRow[] },
): { name: string; description: string | null; columns: DatasetColumn[]; rows: DatasetRow[] } {
  const name = input.name.trim();
  if (!name) throw new HttpError(400, 'bad_request', 'dataset name is required');
  const seen = new Set<string>();
  const columns: DatasetColumn[] = [];
  for (const c of input.columns ?? []) {
    const colName = (c.name ?? '').trim();
    if (!validateVariableName(colName).ok) {
      throw new HttpError(400, 'bad_request', `列名 ${colName} 不是合法变量名（字母/下划线开头，仅字母数字下划线）`);
    }
    if (seen.has(colName)) throw new HttpError(400, 'bad_request', `列名重复：${colName}`);
    seen.add(colName);
    columns.push({ name: colName, sensitive: !!c.sensitive });
  }
  if (columns.length === 0) throw new HttpError(400, 'bad_request', '至少需要一列');
  if (columns.length > MAX_COLUMNS) throw new HttpError(400, 'bad_request', `列数超上限（最多 ${MAX_COLUMNS} 列）`);
  if ((input.rows ?? []).length > MAX_ROWS) throw new HttpError(400, 'bad_request', `行数超上限（最多 ${MAX_ROWS} 行）`);

  // 改名声明校验：目标列必须出现在本次列集里，且多个旧名不能挤向同一个新名（列名本身已去重）。
  const renames = input.renames ?? {};
  const renameEntries = Object.entries(renames);
  if (renameEntries.length > 0) {
    const targets = new Set<string>();
    for (const [, newName] of renameEntries) {
      if (!seen.has(newName)) throw new HttpError(400, 'bad_request', `renames 目标列 ${newName} 不在本次保存的列集中`);
      if (targets.has(newName)) throw new HttpError(400, 'bad_request', `renames 目标列重复：${newName}`);
      targets.add(newName);
    }
  }
  // 旧密文按行对齐前先 re-key 到新列名（构建全新对象，a↔b 互换也能对上）。
  const prevRows = (prev?.rows ?? []).map((row) => {
    if (renameEntries.length === 0) return row;
    const cells: DatasetRow['cells'] = {};
    for (const [k, v] of Object.entries(row.cells)) cells[renames[k] ?? k] = v;
    return { ...row, cells };
  });
  const rows: DatasetRow[] = (input.rows ?? []).map((row, i) => {
    const cells: DatasetRow['cells'] = {};
    for (const [k, v] of Object.entries(row.cells ?? {})) {
      if (!seen.has(k)) throw new HttpError(400, 'bad_request', `第 ${i + 1} 行存在未知列：${k}`);
      const col = columns.find((c) => c.name === k)!;
      const prevCell = prevRows[i]?.cells[k];
      if (col.sensitive) {
        if (typeof v === 'string') {
          cells[k] = v.length > 0 ? encryptCell(v) : '';
        } else if (isMaskedCell(v)) {
          // 密码框语义：未改动占位符回传 → 沿用旧密文（renames 已把旧密文 re-key 到新列名）。
          // 找不到对应旧密文（改名未声明 renames / 陈旧客户端）→ 显式 400，绝不静默清空：
          // 用户看不到明文，静默置空等于不可逆丢失。
          if (!isEncCell(prevCell)) {
            throw new HttpError(400, 'bad_request', `第 ${i + 1} 行列 ${k} 回传了敏感占位符但没有对应旧密文（列可能被重命名但未声明 renames），请刷新后重试`);
          }
          cells[k] = prevCell;
        } else {
          throw new HttpError(400, 'bad_request', `第 ${i + 1} 行列 ${k} 的值类型不合法`);
        }
      } else {
        if (typeof v === 'string') {
          cells[k] = v;
        } else if (isMaskedCell(v)) {
          // 刚从敏感切成非敏感：把旧密文解回明文（用户要求去敏）；密文损坏显式 400 而非 500
          if (isEncCell(prevCell)) {
            try {
              cells[k] = decryptCell(prevCell);
            } catch {
              throw new HttpError(400, 'bad_request', `列 ${k} 旧密文解密失败（密钥变更或数据损坏），请重新填写该列值`);
            }
          } else {
            cells[k] = typeof prevCell === 'string' ? prevCell : '';
          }
        } else {
          throw new HttpError(400, 'bad_request', `第 ${i + 1} 行列 ${k} 的值类型不合法`);
        }
      }
    }
    return { disabled: !!row.disabled, cells };
  });
  return { name, description: input.description?.trim() ? input.description.trim() : null, columns, rows };
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/** 列表出参：不带 rows 明细，带行数统计。 */
export async function listDatasets(projectId: string) {
  const rows = await db.select().from(datasets).where(eq(datasets.projectId, projectId)).orderBy(asc(datasets.createdAt));
  return attachCreators(rows.map((d) => ({
    id: d.id,
    projectId: d.projectId,
    name: d.name,
    description: d.description,
    columns: d.columns,
    rowCount: d.rows.length,
    enabledRowCount: d.rows.filter((r) => !r.disabled).length,
    createdByUserId: d.createdByUserId,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  })));
}

/** 出参归一：敏感格密文 → {__masked:true} 占位。 */
function maskDatasetRows(columns: DatasetColumn[], rows: DatasetRow[]) {
  const sensitive = new Set(columns.filter((c) => c.sensitive).map((c) => c.name));
  return rows.map((r) => ({
    disabled: r.disabled,
    cells: Object.fromEntries(
      Object.entries(r.cells).map(([k, v]) => [k, sensitive.has(k) && isEncCell(v) ? DATASET_MASKED_CELL : v]),
    ),
  }));
}

/** 详情出参：敏感格密文 → {__masked:true} 占位，其余明文。 */
export async function getDataset(datasetId: string) {
  const d = (await db.select().from(datasets).where(eq(datasets.id, datasetId)).limit(1))[0];
  if (!d) return null;
  return attachCreator({ ...d, rows: maskDatasetRows(d.columns, d.rows) });
}

/** 归属解析(AI 工具闸门用):数据集所属项目 id,不存在为 null。 */
export async function datasetProjectId(datasetId: string): Promise<string | null> {
  const row = (await db.select({ projectId: datasets.projectId }).from(datasets).where(eq(datasets.id, datasetId)).limit(1))[0];
  return row?.projectId ?? null;
}

export async function createDataset(projectId: string, input: DatasetSaveBody, createdByUserId?: string | null) {
  const normalized = normalizeDataset(input);
  try {
    const row = (await db.insert(datasets).values({ projectId, ...normalized, ...(createdByUserId ? { createdByUserId } : {}) }).returning())[0]!;
    return { ...row, rows: maskDatasetRows(normalized.columns, normalized.rows) };
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'name_conflict', 'dataset name already exists in this project');
    throw e;
  }
}

export async function updateDataset(datasetId: string, input: DatasetSaveBody) {
  const prev = (await db.select().from(datasets).where(eq(datasets.id, datasetId)).limit(1))[0];
  if (!prev) throw new HttpError(404, 'not_found', 'dataset not found');
  const normalized = normalizeDataset(input, { columns: prev.columns, rows: prev.rows });
  try {
    const row = (await db
      .update(datasets)
      .set({ ...normalized, updatedAt: new Date() })
      .where(eq(datasets.id, datasetId))
      .returning())[0]!;
    return { ...row, rows: maskDatasetRows(normalized.columns, normalized.rows) };
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'name_conflict', 'dataset name already exists in this project');
    throw e;
  }
}

/** 删除前引用计数（绑定该数据集的用例数；删除后 FK 置空自动解绑）。 */
export async function datasetUsage(datasetId: string): Promise<{ caseCount: number }> {
  const rows = await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.datasetId, datasetId));
  return { caseCount: rows.length };
}

export async function deleteDataset(datasetId: string): Promise<void> {
  const existing = (await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.id, datasetId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'dataset not found');
  // FK 只把 dataset_id 置 null；行选择也得清（不变量：未绑定数据集 ⟹ 选择为空）。
  // 必须在 delete 之前清 —— delete 触发 FK 后 dataset_id 已是 null，where 就匹配不到了。
  await db.update(testCases).set({ datasetRowIndexes: [] }).where(eq(testCases.datasetId, datasetId));
  await db.delete(datasets).where(eq(datasets.id, datasetId));
}

/** 启用行数（用例行选择的下标上界）。数据集不存在返回 0。 */
export async function enabledRowCount(datasetId: string): Promise<number> {
  const d = (await db.select({ rows: datasets.rows }).from(datasets).where(eq(datasets.id, datasetId)).limit(1))[0];
  return d ? d.rows.filter((r) => !r.disabled).length : 0;
}

/** 单行回放上下文：vars=解密后初始变量（仅执行期内存）；snapshot=落报告的行快照（敏感值固定 ******）。 */
export interface DatasetRowExec {
  rowIndex: number;
  totalRows: number;
  vars: Record<string, string>;
  sensitiveVarKeys: string[];
  snapshot: { rowIndex: number; totalRows: number; values: Record<string, string> };
}

/** 回放装载：过滤 disabled 行、按用例的行选择过滤、解密敏感格、产出每行初始 vars 与快照。配置错误抛 DatasetConfigError。
 *
 *  rowIndexes：启用行下标数组（0 基，剔除 disabled 行后重新编号）。
 *  空/未指定 = 全部启用行（旧行为）；非空 = 只跑这些行。
 *  rowIndex 取值 = 该行在 enabled 数组里的下标（不是 selected 数组内的位置），
 *  这样报告里的 dataset_row_index 在不同选择下指向同一物理行，跨批次稳定。 */
export async function loadDatasetForRun(datasetId: string, opts?: { rowIndexes?: number[] | null }): Promise<{
  datasetId: string;
  columns: DatasetColumn[];
  rows: DatasetRowExec[];
}> {
  const d = (await db.select().from(datasets).where(eq(datasets.id, datasetId)).limit(1))[0];
  if (!d) throw new DatasetConfigError('dataset not found');
  for (const c of d.columns) {
    if (!validateVariableName(c.name).ok) {
      throw new DatasetConfigError(`数据集列名 ${c.name} 不是合法变量名，无法注入回放变量`);
    }
  }
  const enabled = d.rows.filter((r) => !r.disabled);
  if (enabled.length === 0) throw new DatasetConfigError('数据集没有启用行，无法回放');
  const wanted = opts?.rowIndexes ?? [];
  const outOfRange = wanted.filter((i) => i >= enabled.length);
  if (outOfRange.length > 0) {
    throw new DatasetConfigError(
      `用例选择的数据行 ${outOfRange.map((i) => i + 1).join('、')} 超出该数据集的启用行范围（共 ${enabled.length} 行）`,
    );
  }
  // 升序：执行顺序 = 数据集行序。rowIndex = 启用空间下标。
  const selectedIdx = wanted.length === 0
    ? enabled.map((_, i) => i)
    : [...wanted].sort((a, b) => a - b);
  const sensitiveVarKeys = d.columns.filter((c) => c.sensitive).map((c) => c.name);
  const rows: DatasetRowExec[] = selectedIdx.map((rowIndex) => {
    const row = enabled[rowIndex]!;
    const vars: Record<string, string> = {};
    const values: Record<string, string> = {};
    for (const col of d.columns) {
      const cell = row.cells[col.name];
      if (col.sensitive && isEncCell(cell)) {
        try {
          vars[col.name] = decryptCell(cell);
        } catch {
          throw new DatasetConfigError(`数据集敏感格解密失败（列 ${col.name}，密钥变更或数据损坏）`);
        }
        values[col.name] = '******';
      } else {
        vars[col.name] = typeof cell === 'string' ? cell : '';
        values[col.name] = typeof cell === 'string' ? cell : '';
      }
    }
    return {
      rowIndex,
      // totalRows = 本批次实际执行行数（分母口径），不是数据集启用行总数。
      totalRows: selectedIdx.length,
      vars,
      sensitiveVarKeys,
      snapshot: { rowIndex, totalRows: selectedIdx.length, values },
    };
  });
  return { datasetId: d.id, columns: d.columns, rows };
}
