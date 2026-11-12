/**
 * Assistant attachments (version-scoped): shared service for the pre-upload endpoint and the read_thread_attachment tool.
 * Supports .docx (mammoth extraction) and .xlsx (exceljs extraction); the type is decided by the endpoint from the
 * X-Filename extension whitelist and passed in as ext (this module does no extension judgment).
 *
 * Design invariants (do not break; see docs/superpowers/specs/2026-11-03-xlsx-attachment-and-skill-design.md):
 *  - Reference tags are composed into the message body by the frontend adapter in send(); the backend never rewrites
 *    any message text — react-pi reconciles optimistic messages against pi replay messages by the plain-text key
 *    (userContentKey); backend rewrites would make the two sides' keys disagree → duplicated user bubbles.
 *  - Attachment files are inputs to skill scripts: the zip magic check prevents a forged extension from feeding
 *    arbitrary content into python.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { db } from '../../db/client.js';
import { aiAssistantAttachments } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { UPLOAD_DIR } from '../../lib/attachments.js';

export const WORDPROCESSINGML_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const SPREADSHEETML_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Single-file cap: aligned with the existing uploadMaxBytes() (10MB); the web-side FileAttachmentAdapter validates the same value. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Return cap for read_thread_attachment: keeps long text from blowing up the context. */
export const MAX_ATTACHMENT_READ_CHARS = 80_000;

/** Types decided by the upload endpoint from the X-Filename extension whitelist. */
export type AttachmentExt = 'docx' | 'xlsx';

/** Version upload directory. UPLOAD_DIR shares the same root as case attachments (.data/uploads). */
export function versionUploadDir(versionId: string): string {
  return path.join(UPLOAD_DIR, 'assistant', versionId);
}

/** docx and xlsx are both zip containers; the first four bytes must be PK\x03\x04. No magic → always 400 (anti forged extension);
 *  .xls is OLE2 binary (D0 CF 11 E0) and is rejected here too even when renamed in. */
export function assertZipMagic(buf: Buffer): void {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new HttpError(400, 'bad_request', 'not a docx/xlsx (zip) file');
  }
}

async function realpathOrNull(p: string): Promise<string | null> {
  try { return await fs.realpath(p); } catch { return null; }
}

/**
 * Path confinement: p (after realpath) must lie strictly within baseDir (symlinks are dereferenced before judging).
 * Returns the normalized absolute path; null on escape/nonexistence. The caller layers DB row validation on top as a double guard.
 */
export async function confinedPath(baseDir: string, p: string): Promise<string | null> {
  const real = await realpathOrNull(p);
  if (!real) return null;
  const base = await realpathOrNull(baseDir);
  if (!base) return null;
  if (real !== base && !real.startsWith(base + path.sep)) return null;
  return real;
}

// ── xlsx → text extraction (sidecar; used for read_thread_attachment general Q&A) ──
// Deep parsing (progressive sheet reading / large tables / merged cells) goes through the file-to-cases skill's parse_xlsx.py;
// this only does a bounded snapshot: dual guardrails of per-sheet row count and single-cell characters.
const XLSX_MAX_ROWS_PER_SHEET = 2000;
const XLSX_MAX_CELL_CHARS = 200;

/** exceljs cell.value union type → plain text: formulas take result (empty → placeholder, never the formula source text),
 *  rich text joins, hyperlinks take the display text, errors become [error:code], dates in ISO format (no locale). */
function xlsxCellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  const t = typeof value;
  if (t === 'string') return value as string;
  if (t === 'number' || t === 'boolean') return String(value);
  if (t !== 'object') return String(value);
  const o = value as Record<string, unknown>;
  if (Array.isArray(o.richText)) {
    return (o.richText as Array<{ text?: unknown }>).map((r) => (typeof r.text === 'string' ? r.text : '')).join('');
  }
  // Formula cell: when there is no cached value after re-read there is no result key; identify via the formula/sharedFormula keys.
  if ('result' in o || 'formula' in o || 'sharedFormula' in o) return xlsxCellToText(o.result) || '[formula]';
  if (typeof o.text === 'string') return o.text;
  if (typeof o.hyperlink === 'string') return o.hyperlink;
  if (typeof o.error === 'string') return `[error:${o.error}]`;
  return String(value);
}

/** workbook → text: one `## Sheet: 名 (rows=N,cols=M[,hidden])` section per sheet + pipe-separated rows.
 *  Per-sheet truncation note at 2000 rows; trailing empty segments trimmed within rows, entirely empty rows skipped;
 *  hidden sheets extracted as usual and marked (requirements often hide in hidden sheets). On corrupted/encrypted files
 *  load() throws; the caller treats it as "extraction failure must not block". */
export async function xlsxToText(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  // exceljs's d.ts globally rewrites Buffer with `declare interface Buffer extends ArrayBuffer {}`,
  // which fights @types/node's Buffer generic definition — infer the parameter type directly from the load signature to sidestep this mess.
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const parts: string[] = [];
  for (const sheet of wb.worksheets) {
    const hidden = !!sheet.state && sheet.state !== 'visible';
    const rows: string[] = [];
    let maxCols = 0;
    for (let r = 1; r <= sheet.rowCount && rows.length < XLSX_MAX_ROWS_PER_SHEET; r++) {
      const values = (sheet.getRow(r).values ?? []) as unknown[];
      const cells: string[] = [];
      for (let c = 1; c < values.length; c++) {
        const text = xlsxCellToText(values[c]).slice(0, XLSX_MAX_CELL_CHARS);
        cells.push(text);
        if (text !== '') maxCols = Math.max(maxCols, c);
      }
      // Pad holes in sparse rows with empty strings to align columns; trim trailing segments beyond maxCols.
      while (cells.length > maxCols) cells.pop();
      if (cells.some((c) => c !== '')) rows.push(cells.join(' | '));
    }
    if (rows.length === 0) continue; // an entirely empty sheet produces no section
    const total = sheet.actualRowCount;
    // Annotate only when the row guardrail truly fires, to avoid false truncation notes from the accounting gap between actualRowCount and row-by-row scanning.
    const truncatedNote = rows.length >= XLSX_MAX_ROWS_PER_SHEET && total > rows.length
      ? `\n[已截断：共 ${total} 行，仅提取前 ${rows.length} 行]`
      : '';
    parts.push(
      `## Sheet: ${sheet.name} (rows=${total},cols=${maxCols}${hidden ? ',hidden' : ''})\n${rows.join('\n')}${truncatedNote}`,
    );
  }
  return parts.join('\n\n');
}

async function docxToText(buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return value ?? '';
}

export interface SavedAttachment {
  row: typeof aiAssistantAttachments.$inferSelect;
  deduped: boolean;
}

/** Pre-upload persistence: zip magic → sha256 → in-version dedup → write the original → extract by extension (failure doesn't block) → insert the row.
 *  The dedup key is only (versionId, sha256): the same bytes re-uploaded with a different extension hit the existing row and return the original type —
 *  accepted semantics of content-level dedup. */
export async function saveAssistantAttachmentUpload(input: {
  versionId: string;
  name: string;
  buf: Buffer;
  ext: AttachmentExt;
  createdByUserId: string | null;
}): Promise<SavedAttachment> {
  const { versionId, buf, ext } = input;
  assertZipMagic(buf);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const dupeSel = () => db.select().from(aiAssistantAttachments)
    .where(and(
      eq(aiAssistantAttachments.versionId, versionId),
      eq(aiAssistantAttachments.sha256, sha256),
    ))
    .limit(1);
  const existing = (await dupeSel())[0];
  if (existing) return { row: existing, deduped: true };

  const dir = versionUploadDir(versionId);
  await fs.mkdir(dir, { recursive: true });
  const storagePath = path.join(dir, `${sha256}.${ext}`);
  await fs.writeFile(storagePath, buf);

  // Extraction failure doesn't block the upload: missing sidecar → tag chars="unknown"; the skill's python parser can still read the original.
  let extractedPath: string | null = null;
  let extractedChars: number | null = null;
  try {
    const text = ext === 'xlsx' ? await xlsxToText(buf) : await docxToText(buf);
    extractedPath = path.join(dir, `${sha256}.txt`);
    await fs.writeFile(extractedPath, text, 'utf8');
    extractedChars = text.length;
  } catch { /* stay null: corrupted/encrypted files etc.; the original path remains valid */ }

  const inserted = (await db.insert(aiAssistantAttachments).values({
    versionId,
    name: input.name.slice(0, 200),
    mime: ext === 'xlsx' ? SPREADSHEETML_MIME : WORDPROCESSINGML_MIME,
    sizeBytes: buf.length,
    sha256,
    storagePath,
    extractedPath,
    extractedChars,
    createdByUserId: input.createdByUserId,
  }).onConflictDoNothing().returning())[0];
  if (inserted) return { row: inserted, deduped: false };
  // Concurrent same-file upload: the unique constraint catches it → read back the existing row.
  const again = (await dupeSel())[0]!;
  return { row: again, deduped: true };
}

/** Read path of read_thread_attachment: directory confinement + DB row ownership, both checked → sidecar full text (truncation noted). */
export async function readAssistantAttachmentText(
  versionId: string,
  p: string,
): Promise<{ text: string; truncated: boolean; row: typeof aiAssistantAttachments.$inferSelect } | null> {
  const real = await confinedPath(versionUploadDir(versionId), p);
  if (!real) return null;
  const row = (await db.select().from(aiAssistantAttachments)
    .where(and(
      eq(aiAssistantAttachments.versionId, versionId),
      eq(aiAssistantAttachments.storagePath, real),
    ))
    .limit(1))[0];
  if (!row) return null;
  if (!row.extractedPath) return { text: '', truncated: false, row };
  let text = await fs.readFile(row.extractedPath, 'utf8');
  const truncated = text.length > MAX_ATTACHMENT_READ_CHARS;
  if (truncated) text = text.slice(0, MAX_ATTACHMENT_READ_CHARS);
  return { text, truncated, row };
}
