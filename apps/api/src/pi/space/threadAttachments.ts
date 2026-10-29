/**
 * 助手 docx 附件（版本级）：预上传端点与 read_thread_attachment 工具的共享服务。
 *
 * 设计不变量（勿破坏，见 docs/superpowers/specs/2026-10-29-*）：
 *  - 引用标签由前端 adapter 在 send() 拼进消息正文，后端不改写任何消息文本——
 *    react-pi 的乐观消息按纯文本 key（userContentKey）与 pi 回放消息对账去重，
 *    后端改写文本会让两侧 key 不一致 → 重复用户气泡。
 *  - 附件文件是 skill 脚本的输入：PK 魔数校验防伪造扩展名把任意内容送进 python。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import mammoth from 'mammoth';
import { db } from '../../db/client.js';
import { aiAssistantAttachments } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { UPLOAD_DIR } from '../../lib/attachments.js';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** 单文件上限：与既有 uploadMaxBytes()（10MB）对齐；web 侧 DocxAttachmentAdapter 有同值校验。 */
export const MAX_DOCX_BYTES = 10 * 1024 * 1024;
/** read_thread_attachment 的返回上限：防长文刷爆上下文。 */
export const MAX_ATTACHMENT_READ_CHARS = 80_000;

/** 版本上传目录。UPLOAD_DIR 与 case 附件同根（.data/uploads）。 */
export function versionUploadDir(versionId: string): string {
  return path.join(UPLOAD_DIR, 'assistant', versionId);
}

/** docx = zip 容器，头四字节必为 PK\x03\x04。不带魔数一律 400（防伪造扩展名）。 */
export function assertDocxMagic(buf: Buffer): void {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new HttpError(400, 'bad_request', 'not a docx (zip) file');
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

export interface SavedDocx {
  row: typeof aiAssistantAttachments.$inferSelect;
  deduped: boolean;
}

/** 预上传落盘：魔数 → sha256 → 版本内去重 → 写原件 → mammoth 提取（失败不阻断）→ 插行。 */
export async function saveDocxUpload(input: {
  versionId: string;
  name: string;
  buf: Buffer;
  createdByUserId: string | null;
}): Promise<SavedDocx> {
  const { versionId, buf } = input;
  assertDocxMagic(buf);
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
  const storagePath = path.join(dir, `${sha256}.docx`);
  await fs.writeFile(storagePath, buf);

  // 提取失败不阻断上传：sidecar 缺失 → 标签 chars="unknown"，skill 的 python 解析器仍可读原件。
  let extractedPath: string | null = null;
  let extractedChars: number | null = null;
  try {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    const text = value ?? '';
    extractedPath = path.join(dir, `${sha256}.txt`);
    await fs.writeFile(extractedPath, text, 'utf8');
    extractedChars = text.length;
  } catch { /* 保持 null：文件损坏等，原件 path 仍有效 */ }

  const inserted = (await db.insert(aiAssistantAttachments).values({
    versionId,
    name: input.name.slice(0, 200),
    mime: DOCX_MIME,
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
