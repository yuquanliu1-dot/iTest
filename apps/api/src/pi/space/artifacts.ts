/**
 * Temporary hosting of AI-produced files (thread-scoped).
 *
 * Two artifact classes, one set of persist/token/read paths:
 *  - **Short TTL** (registerArtifact): one-shot files like xmind exports, expire after 30 minutes
 *    (in-memory state + a disk record file).
 *  - **Permanent** (registerPersistentArtifact): downloadable documents produced by skill scripts,
 *    stored in the ai_thread_artifacts table; never expire, downloadable across sessions/process restarts.
 *
 * Flow: the tool produces a buffer → register* writes .data/exports/<token><real extension> plus a
 *   record file → SSE artifact event carries token/name/size → frontend download card →
 *   GET /threads/:id/artifacts/:token exchanges for the file.
 *
 * The record file is persisted alongside the file: replicas share the .data volume, so any replica
 * whose in-memory Map misses can re-source from disk, and any replica can serve the download.
 * Permanent artifacts additionally write a DB row (token unique); reads prefer DB — release-order
 * agnostic, old data stays readable.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { aiThreadArtifacts } from '../../db/schema.js';
import { DATA_DIR } from '../repo.js';

export const EXPORT_DIR = join(DATA_DIR, 'exports');
/** Record-file directory: kept apart from artifact files, so an artifact that is itself .json never collides with a record file on the same path. */
const RECORD_DIR = join(EXPORT_DIR, '.records');
const TTL_MS = 30 * 60_000;

/** Artifact size cap: script stdout has a 100KB limit but artifact files do not — this guards against filling the disk. */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

interface ArtifactRecord {
  path: string;
  name: string;
  mime: string;
  size: number;
  /** null = valid forever. */
  expiresAt: number | null;
  threadId: string;
}

const artifacts = new Map<string, ArtifactRecord>();

/**
 * Extension → MIME. No new dependency: mime-types is not in the api dependency tree (transitive
 * dependencies cannot be used directly).
 * Covers the skill layer's common artifact formats; misses get application/octet-stream (the
 * browser handles it by extension itself).
 * Text types get charset=utf-8 appended — Chinese reports garble under the default latin-1.
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

/** Infers Content-Type from extension; unknown extensions fall back to octet-stream. */
export function mimeOfName(name: string): string {
  const ext = extOfName(name);
  return MIME_TABLE[ext] ?? 'application/octet-stream';
}

/**
 * Extracts the file name's extension (lowercase, pure [a-z0-9]).
 * The name is self-reported by script/user → untrusted input, must be sanitized strictly: no
 * extension gets 'bin'; path separators or non-alphanumerics are stripped (only the part after the
 * last segment's dot is kept), eliminating path escapes.
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

/** Artifact path on disk: <token>.<real extension>. The extension comes from name, so .docx/.xlsx/.pdf each land in their own type. */
function pathOf(token: string, ext: string): string {
  return join(EXPORT_DIR, `${token}.${ext}`);
}

function recordPathOf(token: string): string {
  return join(RECORD_DIR, `${token}.json`);
}

/** Legacy record path (pre-existing files written before the release): coexists with the new record dir; read-time compatible. */
function legacyRecordPathOf(token: string): string {
  return join(EXPORT_DIR, `${token}.json`);
}

/** Disk re-source of the record (used on Map miss; any replica can read the shared volume). path is rebuilt from the token — the persisted string is not trusted; any anomaly is treated as not-found. */
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
  // New record dir first, then the pre-release legacy path for compatibility.
  for (const p of [recordPathOf(token), legacyRecordPathOf(token)]) {
    let raw: string;
    try {
      raw = await readFile(p, 'utf8');
    } catch {
      continue;
    }
    const rec = parseRecord(raw);
    if (!rec) continue;
    // path does not trust the persisted string; rebuilt from token + extension.
    return { ...rec, path: pathOf(token, extOfName(rec.name)) };
  }
  return null;
}

/** Permanent artifact DB row → ArtifactRecord (path rebuilt from the token). */
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
 * Sweeps expired artifacts.
 * Three sources: the new record dir, the old top-level .json records, and orphan artifact files
 * (unowned leftovers from process crashes).
 * Permanent artifacts in DB never expire — all skipped.
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

  // Set of permanent DB artifact tokens: these files ignore TTL, every cleanup must skip them.
  const permanent = new Set<string>();
  try {
    const rows = await db.select({ token: aiThreadArtifacts.token }).from(aiThreadArtifacts);
    for (const r of rows) permanent.add(r.token);
  } catch {
    /* DB unavailable: treat as no permanent artifacts; worst case keeps extra files (acceptable) */
  }

  // 1) Records in the new record dir
  let newRecords: string[] = [];
  try {
    newRecords = await readdir(RECORD_DIR);
  } catch {
    /* dir just created, no content yet */
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

  // 2) Old top-level .json records (written before the release)
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const token = n.slice(0, -'.json'.length);
    if (!TOKEN_RE.test(token)) continue;
    if (permanent.has(token)) continue; // this token is now a permanent artifact; the .json is actually its artifact file itself
    const rec = await readRecordFromDisk(token);
    if (!rec || rec.expiresAt === null) continue;
    if (now - rec.expiresAt <= 0) continue;
    await unlink(rec.path).catch(() => {});
    await unlink(legacyRecordPathOf(token)).catch(() => {});
  }

  // 3) Orphan artifact files: pointed at by no record and mtime exceeds TTL (process-crash leftovers).
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
      /* already swept concurrently */
    }
  }

  for (const [t, a] of artifacts) {
    if (a.expiresAt !== null && now > a.expiresAt) artifacts.delete(t);
  }
}

export interface ArtifactMeta {
  /** Original file name (with extension, may be Chinese). Browser download name = this value. */
  name: string;
  /** Content-Type; inferred from extension when absent. */
  mime?: string;
  /** Optional entry count (xmind semantics: how many cases the file contains). */
  count?: number;
}

/**
 * Registers a short-TTL artifact (one-shot files like xmind exports).
 * Expires after 30 minutes → download returns 410. The record file lands on disk for multi-replica re-sourcing.
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
 * Registers a permanent artifact (downloadable document produced by a skill script): writes to disk
 * + inserts into ai_thread_artifacts.
 * If the insert fails, the already-written file is deleted — no unowned files left behind.
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

/** Permanent artifact list for a thread (newest first). */
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

/** Expired/not-found returns null (route layer turns it into 410). On Map miss, DB (permanent artifacts) is checked first, then the shared disk re-sources; on expiry both files are cleaned best-effort. */
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

/** RFC 5987: ASCII fallback + filename* for Chinese. */
export function contentDispositionUtf8(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
