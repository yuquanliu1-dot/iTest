/**
 * AI 产出文件的临时托管（thread 级）。
 *
 * 两类产物，同一套落盘/令牌/读取路径：
 *  - **短 TTL**（registerArtifact）：xmind 导出等一次性文件，30 分钟过期（内存态 + 磁盘登记记录）。
 *  - **永久**（registerPersistentArtifact）：skill 脚本生成的可下载文档，落 ai_thread_artifacts 表，
 *    不过期，跨会话/跨进程重启仍可下载。
 *
 * 流程：工具生成 buffer → register* 落盘 .data/exports/<token><真实扩展名> + 登记记录
 *   → SSE artifact 事件携 token/name/size → 前端下载卡 → GET /threads/:id/artifacts/:token 换文件。
 *
 * 登记记录随文件落盘：多副本共享 .data 卷，任一副本内存 Map miss 时可从磁盘回源，任意副本皆可服务下载。
 * 永久产物额外写 DB 行（token 唯一），读取时 DB 优先——发版顺序无关，旧数据仍可读。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { aiThreadArtifacts } from '../../db/schema.js';
import { DATA_DIR } from '../repo.js';

export const EXPORT_DIR = join(DATA_DIR, 'exports');
/** 登记记录目录：与产物文件分开，避免产物本身是 .json 时与记录文件抢同一个路径。 */
const RECORD_DIR = join(EXPORT_DIR, '.records');
const TTL_MS = 30 * 60_000;

/** 产物文件大小上限：脚本 stdout 有 100KB 上限，产物文件本身没有——加一道防撑爆磁盘。 */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

interface ArtifactRecord {
  path: string;
  name: string;
  mime: string;
  size: number;
  /** null = 永久有效。 */
  expiresAt: number | null;
  threadId: string;
}

const artifacts = new Map<string, ArtifactRecord>();

/**
 * 扩展名 → MIME。不引新依赖：mime-types 不在 api 依赖树里（传递依赖不可直接用）。
 * 覆盖 skill 常见产物格式；未命中给 application/octet-stream（浏览器按扩展名自行处理）。
 * 文本类补 charset=utf-8——中文报告用默认 latin-1 会乱码。
 */
const MIME_TABLE: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  xmind: 'application/vnd.xmind.workbook',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  sql: 'application/sql; charset=utf-8',
  har: 'application/json; charset=utf-8',
};

/** 按扩展名推断 Content-Type；未知扩展名退到 octet-stream。 */
export function mimeOfName(name: string): string {
  const ext = extOfName(name);
  return MIME_TABLE[ext] ?? 'application/octet-stream';
}

/**
 * 取文件名的扩展名（小写，纯 [a-z0-9]）。
 * 名字由脚本/用户自报 → 不可信输入，必须严格净化：无扩展名给 'bin'，
 * 带路径分隔符或非字母数字的一律剥掉（只留最后一段的点后部分），杜绝路径逃逸。
 */
export function extOfName(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return 'bin';
  const raw = base.slice(dot + 1).toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9]/g, '');
  if (!cleaned || cleaned.length > 10) return 'bin';
  return cleaned;
}

/** 产物落盘路径：<token>.<真实扩展名>。扩展名来自 name，故 .docx/.xlsx/.pdf 各得其所。 */
function pathOf(token: string, ext: string): string {
  return join(EXPORT_DIR, `${token}.${ext}`);
}

function recordPathOf(token: string): string {
  return join(RECORD_DIR, `${token}.json`);
}

/** 旧版登记记录路径（发版前写入的存量文件）：与新记录目录并存，读时兼容。 */
function legacyRecordPathOf(token: string): string {
  return join(EXPORT_DIR, `${token}.json`);
}

/** 磁盘回源登记记录（Map miss 时用，任意副本可读共享卷）。path 以 token 重建，不信落盘字符串；任何异常按不存在处理。 */
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseRecord(raw: string): ArtifactRecord | null {
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    if (typeof r.name !== 'string' || typeof r.size !== 'number' || typeof r.threadId !== 'string') return null;
    const expiresAt = r.expiresAt === null ? null : typeof r.expiresAt === 'number' ? r.expiresAt : null;
    const mime = typeof r.mime === 'string' ? r.mime : mimeOfName(r.name);
    return { path: '', name: r.name, mime, size: r.size, expiresAt, threadId: r.threadId };
  } catch {
    return null;
  }
}

async function readRecordFromDisk(token: string): Promise<ArtifactRecord | null> {
  // 先新记录目录，再兼容发版前的旧路径。
  for (const p of [recordPathOf(token), legacyRecordPathOf(token)]) {
    let raw: string;
    try {
      raw = await readFile(p, 'utf8');
    } catch {
      continue;
    }
    const rec = parseRecord(raw);
    if (!rec) continue;
    // path 不信落盘字符串，按 token + 扩展名重建。
    return { ...rec, path: pathOf(token, extOfName(rec.name)) };
  }
  return null;
}

/** DB 里的永久产物行 → ArtifactRecord（path 以 token 重建）。 */
async function readPersistentFromDb(token: string): Promise<ArtifactRecord | null> {
  const row = (await db
    .select({
      name: aiThreadArtifacts.name,
      mime: aiThreadArtifacts.mime,
      size: aiThreadArtifacts.size,
      threadId: aiThreadArtifacts.threadId,
      expiresAt: aiThreadArtifacts.expiresAt,
    })
    .from(aiThreadArtifacts)
    .where(eq(aiThreadArtifacts.token, token))
    .limit(1))[0];
  if (!row) return null;
  return {
    path: pathOf(token, extOfName(row.name)),
    name: row.name,
    mime: row.mime ?? mimeOfName(row.name),
    size: row.size,
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
    threadId: row.threadId,
  };
}

/**
 * 清扫过期产物。
 * 三类来源：新记录目录、旧的顶层 .json 记录、孤儿产物文件（进程崩溃留下的无主文件）。
 * DB 里的永久产物永不过期，一律跳过。
 */
async function sweep(): Promise<void> {
  await mkdir(RECORD_DIR, { recursive: true }).catch(() => {});
  let names: string[] = [];
  try {
    names = await readdir(EXPORT_DIR);
  } catch {
    return;
  }
  const now = Date.now();

  // DB 永久产物 token 集合：这些文件不受 TTL 影响，任何清理都要跳过。
  const permanent = new Set<string>();
  try {
    const rows = await db.select({ token: aiThreadArtifacts.token }).from(aiThreadArtifacts);
    for (const r of rows) permanent.add(r.token);
  } catch {
    /* DB 不可用时按无永久产物处理，最坏情况是多留文件（可接受） */
  }

  // 1) 新记录目录里的记录
  let newRecords: string[] = [];
  try {
    newRecords = await readdir(RECORD_DIR);
  } catch {
    /* 目录刚建还没内容 */
  }
  for (const n of newRecords) {
    if (!n.endsWith('.json')) continue;
    const token = n.slice(0, -'.json'.length);
    if (!TOKEN_RE.test(token)) continue;
    const rec = await readRecordFromDisk(token);
    if (!rec || rec.expiresAt === null) continue;
    if (now - rec.expiresAt <= 0) continue;
    await unlink(rec.path).catch(() => {});
    await unlink(recordPathOf(token)).catch(() => {});
  }

  // 2) 旧的顶层 .json 记录（发版前写入）
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const token = n.slice(0, -'.json'.length);
    if (!TOKEN_RE.test(token)) continue;
    if (permanent.has(token)) continue; // 该 token 现在是永久产物，.json 反而是它的产物文件本体
    const rec = await readRecordFromDisk(token);
    if (!rec || rec.expiresAt === null) continue;
    if (now - rec.expiresAt <= 0) continue;
    await unlink(rec.path).catch(() => {});
    await unlink(legacyRecordPathOf(token)).catch(() => {});
  }

  // 3) 孤儿产物文件：无任何记录指向，且 mtime 超过 TTL（进程崩溃残留）。
  for (const n of names) {
    if (n === '.records' || n.endsWith('.json')) continue;
    const token = n.replace(/\.[^.]+$/, '');
    if (!TOKEN_RE.test(token)) continue;
    if (permanent.has(token)) continue;
    const p = join(EXPORT_DIR, n);
    try {
      const st = await stat(p);
      if (now - st.mtimeMs <= TTL_MS) continue;
      await unlink(p);
    } catch {
      /* 已被并发清扫 */
    }
  }

  for (const [t, a] of artifacts) {
    if (a.expiresAt !== null && now > a.expiresAt) artifacts.delete(t);
  }
}

export interface ArtifactMeta {
  /** 原始文件名（含扩展名，可中文）。浏览器落盘名 = 此值。 */
  name: string;
  /** Content-Type；缺省按扩展名推断。 */
  mime?: string;
  /** 可选条目数（沿用 xmind 语义：文件内含多少条用例）。 */
  count?: number;
}

/**
 * 注册短 TTL 产物（xmind 导出等一次性文件）。
 * 30 分钟后过期 → 下载返回 410。登记记录落磁盘供多副本回源。
 */
export async function registerArtifact(buffer: Buffer, name: string, threadId: string): Promise<string> {
  const ext = extOfName(name);
  const token = randomUUID();
  const path = pathOf(token, ext);
  const record: ArtifactRecord = {
    path,
    name,
    mime: mimeOfName(name),
    size: buffer.length,
    expiresAt: Date.now() + TTL_MS,
    threadId,
  };
  await mkdir(RECORD_DIR, { recursive: true });
  await writeFile(path, buffer);
  await writeFile(recordPathOf(token), JSON.stringify(record));
  artifacts.set(token, record);
  void sweep();
  return token;
}

/**
 * 注册永久产物（skill 脚本生成的可下载文档）：落盘 + 落 ai_thread_artifacts 表。
 * 落库失败则删掉已落盘的文件——不留无主文件。
 */
export async function registerPersistentArtifact(
  buffer: Buffer,
  meta: ArtifactMeta,
  scope: { threadId: string; versionId: string; projectId: string; skillName?: string; createdByUserId?: string | null },
): Promise<string> {
  if (buffer.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`产物过大（${buffer.length} 字节，上限 ${MAX_ARTIFACT_BYTES}）`);
  }
  const ext = extOfName(meta.name);
  const token = randomUUID();
  const path = pathOf(token, ext);
  const mime = meta.mime ?? mimeOfName(meta.name);
  await mkdir(RECORD_DIR, { recursive: true });
  await writeFile(path, buffer);
  try {
    await db.insert(aiThreadArtifacts).values({
      id: randomUUID(),
      threadId: scope.threadId,
      versionId: scope.versionId,
      projectId: scope.projectId,
      token,
      name: meta.name,
      mime,
      size: buffer.length,
      count: meta.count ?? null,
      storedPath: path,
      skillName: scope.skillName ?? null,
      expiresAt: null,
      createdByUserId: scope.createdByUserId ?? null,
    });
  } catch (e) {
    await unlink(path).catch(() => {});
    throw e;
  }
  artifacts.set(token, {
    path,
    name: meta.name,
    mime,
    size: buffer.length,
    expiresAt: null,
    threadId: scope.threadId,
  });
  return token;
}

/** 某线程的永久产物列表（新→旧）。 */
export async function listThreadArtifacts(threadId: string): Promise<Array<{
  token: string;
  name: string;
  mime: string;
  size: number;
  count: number | null;
  createdAt: Date;
}>> {
  const rows = await db
    .select({
      token: aiThreadArtifacts.token,
      name: aiThreadArtifacts.name,
      mime: aiThreadArtifacts.mime,
      size: aiThreadArtifacts.size,
      count: aiThreadArtifacts.count,
      createdAt: aiThreadArtifacts.createdAt,
    })
    .from(aiThreadArtifacts)
    .where(eq(aiThreadArtifacts.threadId, threadId));
  return rows
    .map((r) => ({
      token: r.token,
      name: r.name,
      mime: r.mime ?? mimeOfName(r.name),
      size: r.size,
      count: r.count,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** 过期/不存在返回 null（路由层转 410）。Map miss 时先查 DB（永久产物）再从共享磁盘回源；过期时 best-effort 清掉两个文件。 */
export async function getArtifact(token: string): Promise<ArtifactRecord | null> {
  if (!TOKEN_RE.test(token)) return null;
  const a = artifacts.get(token) ?? (await readPersistentFromDb(token)) ?? (await readRecordFromDisk(token));
  if (!a) return null;
  if (a.expiresAt !== null && Date.now() > a.expiresAt) {
    artifacts.delete(token);
    void unlink(a.path).catch(() => {});
    void unlink(recordPathOf(token)).catch(() => {});
    void unlink(legacyRecordPathOf(token)).catch(() => {});
    return null;
  }
  artifacts.set(token, a);
  return a;
}

export async function readArtifactFile(a: ArtifactRecord): Promise<Buffer> {
  return readFile(a.path);
}

/** RFC 5987：ASCII 兜底 + filename* 中文。 */
export function contentDispositionUtf8(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
