/**
 * Dataset domain service: project-level test dataset CRUD + replay data loading.
 * Sensitive-column cells are stored AES-256-GCM encrypted as {c,i,t} in the rows jsonb; outputs always use {__masked:true} placeholders.
 * Column names are variable names (injected as {{<column name>}} at replay) and must pass validateVariableName.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { datasets, planCases, planCaseGroups, testCases } from '../db/schema.js';
import type { DatasetColumn, DatasetRow, DatasetEncCell } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { encrypt, decrypt } from '../lib/secret-crypto.js';
import { attachCreators, attachCreator } from '../lib/creator.js';
import { validateVariableName } from '@itest/shared';

export const DATASET_MASKED_CELL = { __masked: true } as const;
export type DatasetMaskedCell = { __masked: true };
const MAX_COLUMNS = 30;
const MAX_ROWS = 500;

/** Replay dataset configuration error (no enabled rows / illegal column names etc.). The execution entry maps it to 400; inside a plan it maps the case to failed. */
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
  /** Column rename declarations (old name → new name): when __masked placeholders align by row, the old ciphertext is re-keyed to the new name; otherwise a rename would silently wipe the ciphertext. */
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

/** Pre-save validation + normalization. prev rows align by index: __masked placeholders keep the old ciphertext per row index
 *  (frontend semantics: untouched sensitive cells come back as-is; when row order changes, values must change with it — no cross-row tracking). */
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

  // Rename declaration validation: target columns must appear in this save's column set, and multiple old names can't collapse into one new name (column names are already deduped).
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
  // Re-key the old ciphertext to the new names before row alignment (builds a fresh object, so an a↔b swap still lines up).
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
          // Password-field semantics: an unmodified placeholder sent back → keep the old ciphertext (renames has re-keyed it to the new column name).
          // No matching old ciphertext (rename without declared renames / stale client) → explicit 400, never silently cleared:
          // the user can't see plaintext, so silently emptying it equals irreversible loss.
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
          // Just switched from sensitive to non-sensitive: decrypt the old ciphertext back to plaintext (the user asked to de-sensitize); broken ciphertext gets an explicit 400 rather than a 500
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

/** Enabled-row array (the single source of truth): the row order after removing disabled rows is the "row index space" (renumbered 0-based).
 *  Counting (countEnabledRows) and replay loading (loadDatasetForRun) must share this source, otherwise the executor judges the UI's indexes out of range. */
export function enabledRows<T extends { disabled?: boolean }>(rows: T[] | null | undefined): T[] {
  return (rows ?? []).filter((r) => !r.disabled);
}

/** Enabled-row count (the single source of truth): the number of non-disabled rows in datasets.rows. The row index space is renumbered over enabled rows (0-based).
 *  The TS side and the SQL side (plan-detail backfill) must share this rule, otherwise the executor judges the UI's indexes out of range. */
export function countEnabledRows(rows: { disabled?: boolean }[] | null | undefined): number {
  return enabledRows(rows).length;
}

/** List output: no rows detail, but row-count stats included. */
export async function listDatasets(projectId: string) {
  const rows = await db.select().from(datasets).where(eq(datasets.projectId, projectId)).orderBy(asc(datasets.createdAt));
  return attachCreators(rows.map((d) => ({
    id: d.id,
    projectId: d.projectId,
    name: d.name,
    description: d.description,
    columns: d.columns,
    rowCount: d.rows.length,
    enabledRowCount: countEnabledRows(d.rows),
    createdByUserId: d.createdByUserId,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  })));
}

/** Output normalization: sensitive-cell ciphertext → {__masked:true} placeholder. */
function maskDatasetRows(columns: DatasetColumn[], rows: DatasetRow[]) {
  const sensitive = new Set(columns.filter((c) => c.sensitive).map((c) => c.name));
  return rows.map((r) => ({
    disabled: r.disabled,
    cells: Object.fromEntries(
      Object.entries(r.cells).map(([k, v]) => [k, sensitive.has(k) && isEncCell(v) ? DATASET_MASKED_CELL : v]),
    ),
  }));
}

/** Detail output: sensitive-cell ciphertext → {__masked:true} placeholder, everything else plaintext. */
export async function getDataset(datasetId: string) {
  const d = (await db.select().from(datasets).where(eq(datasets.id, datasetId)).limit(1))[0];
  if (!d) return null;
  return attachCreator({ ...d, rows: maskDatasetRows(d.columns, d.rows) });
}

/** Ownership resolution (for the AI tools' gate): the dataset's owning project id, null when missing. */
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

/** Reference count before delete (cases bound to this dataset; the FK is nulled on delete, unbinding automatically). */
export async function datasetUsage(datasetId: string): Promise<{ caseCount: number }> {
  const rows = await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.datasetId, datasetId));
  return { caseCount: rows.length };
}

export async function deleteDataset(datasetId: string): Promise<void> {
  const existing = (await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.id, datasetId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'dataset not found');
  // The FK only nulls dataset_id; the row selection must be cleared too (invariant: no dataset bound ⟹ empty selection).
  // Must be cleared before the delete — once the delete triggers the FK, dataset_id is already null and the where matches nothing.
  await db.update(testCases).set({ datasetRowIndexes: [] }).where(eq(testCases.datasetId, datasetId));
  // Plan-level row overrides are cleared together (null = follow case level): the index space belongs to the deleted dataset; leftovers are garbage values.
  // Must run before db.delete(datasets): after the delete the FK nulls test_cases.dataset_id and the subquery would match 0 rows (silent no-op).
  await db.update(planCases).set({ datasetRowIndexes: null }).where(
    inArray(planCases.caseId, db.select({ id: testCases.id }).from(testCases).where(eq(testCases.datasetId, datasetId))),
  );
  // Login-case row overrides cleared by the same criteria (group configs referencing this dataset's login case): equally must run before the delete.
  await db.update(planCaseGroups).set({ loginDatasetRowIndexes: null }).where(
    inArray(planCaseGroups.loginCaseId, db.select({ id: testCases.id }).from(testCases).where(eq(testCases.datasetId, datasetId))),
  );
  await db.delete(datasets).where(eq(datasets.id, datasetId));
}

/** Enabled-row count (the index upper bound for case row selection). Returns 0 when the dataset is missing. */
export async function enabledRowCount(datasetId: string): Promise<number> {
  const d = (await db.select({ rows: datasets.rows }).from(datasets).where(eq(datasets.id, datasetId)).limit(1))[0];
  return d ? countEnabledRows(d.rows) : 0;
}

/** Shared row-selection validation (one criteria for case level in cases.service and plan level in plans.service):
 *  an empty array passes ([] = all rows); non-empty requires ≤500 non-negative integer indexes, a bound dataset, and values within the enabled-row range.
 *  null (clear the override) is let through by the caller itself and never reaches this function. */
export async function assertDatasetRowIndexes(datasetId: string | null | undefined, rowIndexes: number[]): Promise<void> {
  if (rowIndexes.length === 0) return;
  if (rowIndexes.length > MAX_ROWS) throw new HttpError(400, 'bad_request', `数据行选择最多 ${MAX_ROWS} 行`);
  if (rowIndexes.some((i) => !Number.isInteger(i) || i < 0)) {
    throw new HttpError(400, 'bad_request', '数据行下标必须是非负整数');
  }
  if (!datasetId) throw new HttpError(400, 'bad_request', '选择数据集行前须先绑定数据集');
  const enabledCount = await enabledRowCount(datasetId);
  const bad = rowIndexes.filter((i) => i >= enabledCount);
  if (bad.length > 0) {
    throw new HttpError(400, 'bad_request',
      `选中的数据行 ${bad.map((i) => i + 1).join('、')} 超出该数据集的启用行范围（共 ${enabledCount} 行）`);
  }
}

/** Single-row replay context: vars = decrypted initial variables (execution-time memory only); snapshot = the row snapshot written to the report (sensitive values fixed to ******). */
export interface DatasetRowExec {
  rowIndex: number;
  totalRows: number;
  vars: Record<string, string>;
  sensitiveVarKeys: string[];
  snapshot: { rowIndex: number; totalRows: number; values: Record<string, string> };
}

/** Replay loading: filters disabled rows, filters by the case's row selection, decrypts sensitive cells, and produces each row's initial vars + snapshot. Configuration errors throw DatasetConfigError.
 *
 *  rowIndexes: enabled-row index array (0-based, renumbered after removing disabled rows).
 *  Empty/unspecified = all enabled rows (legacy behavior); non-empty = run only these rows.
 *  rowIndex = the row's index in the enabled array (not its position in the selected array),
 *  so the report's dataset_row_index points at the same physical row across different selections, stable across batches. */
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
  const enabled = enabledRows(d.rows);
  if (enabled.length === 0) throw new DatasetConfigError('数据集没有启用行，无法回放');
  const wanted = opts?.rowIndexes ?? [];
  const outOfRange = wanted.filter((i) => i >= enabled.length);
  if (outOfRange.length > 0) {
    throw new DatasetConfigError(
      `用例选择的数据行 ${outOfRange.map((i) => i + 1).join('、')} 超出该数据集的启用行范围（共 ${enabled.length} 行）`,
    );
  }
  // Ascending: execution order = dataset row order. rowIndex = enabled-space index.
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
      // totalRows = the rows actually executed in this batch (the denominator), not the dataset's total enabled rows.
      totalRows: selectedIdx.length,
      vars,
      sensitiveVarKeys,
      snapshot: { rowIndex, totalRows: selectedIdx.length, values },
    };
  });
  return { datasetId: d.id, columns: d.columns, rows };
}
