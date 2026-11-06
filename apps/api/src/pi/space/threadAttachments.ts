/**
 * 助手附件（版本级）：预上传端点与 read_thread_attachment 工具的共享服务。
 * 支持 .docx（mammoth 提取）与 .xlsx（exceljs 提取），类型由端点按 X-Filename
 * 扩展名白名单判定后以 ext 传入（本模块不做扩展名判断）。
 *
 * 设计不变量（勿破坏，见 docs/superpowers/specs/2026-11-03-xlsx-attachment-and-skill-design.md）：
 *  - 引用标签由前端 adapter 在 send() 拼进消息正文，后端不改写任何消息文本——
 *    react-pi 的乐观消息按纯文本 key（userContentKey）与 pi 回放消息对账去重，
 *    后端改写文本会让两侧 key 不一致 → 重复用户气泡。
 *  - 附件文件是 skill 脚本的输入：zip 魔数校验防伪造扩展名把任意内容送进 python。
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
/** 单文件上限：与既有 uploadMaxBytes()（10MB）对齐；web 侧 FileAttachmentAdapter 有同值校验。 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** read_thread_attachment 的返回上限：防长文刷爆上下文。 */
export const MAX_ATTACHMENT_READ_CHARS = 80_000;

/** 上传端点按 X-Filename 扩展名白名单判定的类型。 */
export type AttachmentExt = 'docx' | 'xlsx';

/** 版本上传目录。UPLOAD_DIR 与 case 附件同根（.data/uploads）。 */
export function versionUploadDir(versionId: string): string {
  return path.join(UPLOAD_DIR, 'assistant', versionId);
}

/** docx 与 xlsx 同为 zip 容器，头四字节必为 PK\x03\x04。不带魔数一律 400（防伪造扩展名）；
 *  .xls 是 OLE2 二进制（D0 CF 11 E0），改名混进来也在此被拒。 */
export function assertZipMagic(buf: Buffer): void {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new HttpError(400, 'bad_request', 'not a docx/xlsx (zip) file');
  }
}

async function realpathOrNull(p: string): Promise<string | null> {
  try { return await fs.realpath(p); } catch { return null; }
}

/**
 * 路径约束：p（realpath 后）必须严格位于 baseDir 之内（软链先解引用再判）。
 * 返回规范化绝对路径；越界/不存在返回 null。调用方再叠 DB 行校验形成双保险。
 */
export async function confinedPath(baseDir: string, p: string): Promise<string | null> {
  const real = await realpathOrNull(p);
  if (!real) return null;
  const base = await realpathOrNull(baseDir);
  if (!base) return null;
  if (real !== base && !real.startsWith(base + path.sep)) return null;
  return real;
}

// ── xlsx → 文本提取（sidecar 用，供 read_thread_attachment 一般问答）──
// 深解析（渐进读 sheet/大表/合并单元格）走 file-to-cases 技能的 parse_xlsx.py，
// 这里只做有界快照：每 sheet 行数与单 cell 字符双护栏。
const XLSX_MAX_ROWS_PER_SHEET = 2000;
const XLSX_MAX_CELL_CHARS = 200;

/** exceljs cell.value 联合类型 → 纯文本：公式取 result（空给占位，不写公式原文）、
 *  富文本 join、超链接取显示文本、错误给 [error:code]、日期 ISO 格式（不落 locale）。 */
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
  // 公式 cell：重读后无缓存值时没有 result 键，靠 formula/sharedFormula 键识别。
  if ('result' in o || 'formula' in o || 'sharedFormula' in o) return xlsxCellToText(o.result) || '[formula]';
  if (typeof o.text === 'string') return o.text;
  if (typeof o.hyperlink === 'string') return o.hyperlink;
  if (typeof o.error === 'string') return `[error:${o.error}]`;
  return String(value);
}

/** workbook → 文本：每 sheet 一段 `## Sheet: 名 (rows=N,cols=M[,hidden])` + 管道分隔行。
 *  每 sheet 2000 行截断标注；行内裁尾随空段、跳过全空行；隐藏 sheet 照常提取并标注
 *  （需求常藏在隐藏页）。文件损坏/加密时 load() 抛错，由调用方按「提取失败不阻断」处理。 */
export async function xlsxToText(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  // exceljs 的 d.ts 用 `declare interface Buffer extends ArrayBuffer {}` 全局改写了 Buffer，
  // 与 @types/node 的 Buffer 泛型定义互相打架——参数类型直接从 load 签名反推，绕开这滩浑水。
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
      // 稀疏行的空洞补空串对齐列；裁掉 maxCols 之外的尾随空段。
      while (cells.length > maxCols) cells.pop();
      if (cells.some((c) => c !== '')) rows.push(cells.join(' | '));
    }
    if (rows.length === 0) continue; // 全空 sheet 不出段落
    const total = sheet.actualRowCount;
    // 仅在行护栏真实触发时标注，避免 actualRowCount 与逐行扫描口径差造成假截断提示。
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

/** 预上传落盘：zip 魔数 → sha256 → 版本内去重 → 写原件 → 按扩展名提取（失败不阻断）→ 插行。
 *  去重键只有 (versionId, sha256)：同一份字节改扩展名重传会命中既有行返回原类型——
 *  内容级去重的既定语义，可接受。 */
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

  // 提取失败不阻断上传：sidecar 缺失 → 标签 chars="unknown"，skill 的 python 解析器仍可读原件。
  let extractedPath: string | null = null;
  let extractedChars: number | null = null;
  try {
    const text = ext === 'xlsx' ? await xlsxToText(buf) : await docxToText(buf);
    extractedPath = path.join(dir, `${sha256}.txt`);
    await fs.writeFile(extractedPath, text, 'utf8');
    extractedChars = text.length;
  } catch { /* 保持 null：文件损坏/加密等，原件 path 仍有效 */ }

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
  // 并发同文件：唯一约束兜底 → 回读既有行。
  const again = (await dupeSel())[0]!;
  return { row: again, deduped: true };
}

/** read_thread_attachment 的读路径：目录约束 + DB 行归属双校验 → sidecar 全文（截断标注）。 */
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
