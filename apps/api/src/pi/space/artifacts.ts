/**
 * AI 产出文件的临时托管（thread 级）。
 * 工具生成 buffer → registerArtifact 落盘 .data/exports/<token>.xmind + <token>.json（登记记录含 threadId）
 * → SSE artifact 事件携 token/name/size → 前端下载卡 → GET /threads/:id/artifacts/:token 换文件。
 * token 30min TTL；登记时惰性清扫过期文件（含进程重启后的磁盘孤儿，按 mtime）。
 * 登记记录随文件落盘：多副本共享 .data 卷，任一副本内存 Map miss 时可从磁盘回源，任意副本皆可服务下载。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../repo.js';

export const EXPORT_DIR = join(DATA_DIR, 'exports');
const TTL_MS = 30 * 60_000;

interface ArtifactRecord {
  path: string;
  name: string;
  size: number;
  expiresAt: number;
  threadId: string;
}

const artifacts = new Map<string, ArtifactRecord>();

function pathOf(token: string): string {
  return join(EXPORT_DIR, `${token}.xmind`);
}

function recordPathOf(token: string): string {
  return join(EXPORT_DIR, `${token}.json`);
}

async function sweep(): Promise<void> {
  await mkdir(EXPORT_DIR, { recursive: true }).catch(() => {});
  let names: string[] = [];
  try {
    names = await readdir(EXPORT_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    names
      .filter((n) => n.endsWith('.xmind') || n.endsWith('.json'))
      .map(async (n) => {
        const p = join(EXPORT_DIR, n);
        try {
          const st = await stat(p);
          if (now - st.mtimeMs <= TTL_MS) return;
          await unlink(p);
          // 成对清理：删 .xmind 时 best-effort 顺删同 token 的 .json；反之不必（孤儿 json 由自身 mtime 清扫）。
          if (n.endsWith('.xmind')) await unlink(recordPathOf(n.slice(0, -'.xmind'.length))).catch(() => {});
        } catch {
          /* 已被并发清扫 */
        }
      }),
  );
  for (const [t, a] of artifacts) {
    if (now > a.expiresAt) artifacts.delete(t);
  }
}

export async function registerArtifact(buffer: Buffer, name: string, threadId: string): Promise<string> {
  void sweep();
  await mkdir(EXPORT_DIR, { recursive: true });
  const token = randomUUID();
  const path = pathOf(token);
  const record: ArtifactRecord = {
    path,
    name,
    size: buffer.length,
    expiresAt: Date.now() + TTL_MS,
    threadId,
  };
  await writeFile(path, buffer);
  await writeFile(recordPathOf(token), JSON.stringify(record));
  artifacts.set(token, record);
  return token;
}

/** 磁盘回源登记记录（Map miss 时用，任意副本可读共享卷）。path 以 token 重建，不信落盘字符串；任何异常按不存在处理。 */
async function readRecordFromDisk(token: string): Promise<ArtifactRecord | null> {
  try {
    const r = JSON.parse(await readFile(recordPathOf(token), 'utf8')) as ArtifactRecord;
    if (typeof r.name !== 'string' || typeof r.size !== 'number' || typeof r.expiresAt !== 'number' || typeof r.threadId !== 'string') return null;
    return { ...r, path: pathOf(token) };
  } catch {
    return null;
  }
}

/** 过期/不存在返回 null（路由层转 410）。Map miss 时从共享磁盘回源，任意副本皆可服务；过期时 best-effort 清掉两个文件。 */
export async function getArtifact(token: string): Promise<ArtifactRecord | null> {
  const a = artifacts.get(token) ?? (await readRecordFromDisk(token));
  if (!a) return null;
  if (Date.now() > a.expiresAt) {
    artifacts.delete(token);
    void unlink(a.path).catch(() => {});
    void unlink(recordPathOf(token)).catch(() => {});
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
