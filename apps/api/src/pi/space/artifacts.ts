/**
 * AI 产出文件的临时托管（thread 级）。
 * 工具生成 buffer → registerArtifact 落盘 .data/exports/<token>.xmind → SSE artifact 事件
 * 携 token/name/size → 前端下载卡 → GET /threads/:id/artifacts/:token 换文件。
 * token 30min TTL；登记时惰性清扫过期文件（含进程重启后的磁盘孤儿，按 mtime）。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const EXPORT_DIR = join(process.cwd(), '.data', 'exports');
const TTL_MS = 30 * 60_000;

interface ArtifactRecord {
  path: string;
  name: string;
  size: number;
  expiresAt: number;
}

const artifacts = new Map<string, ArtifactRecord>();

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
      .filter((n) => n.endsWith('.xmind'))
      .map(async (n) => {
        const p = join(EXPORT_DIR, n);
        try {
          const st = await stat(p);
          if (now - st.mtimeMs > TTL_MS) await unlink(p);
        } catch {
          /* 已被并发清扫 */
        }
      }),
  );
  for (const [t, a] of artifacts) {
    if (now > a.expiresAt) artifacts.delete(t);
  }
}

export async function registerArtifact(buffer: Buffer, name: string): Promise<string> {
  void sweep();
  await mkdir(EXPORT_DIR, { recursive: true });
  const token = randomUUID();
  const path = join(EXPORT_DIR, `${token}.xmind`);
  await writeFile(path, buffer);
  artifacts.set(token, { path, name, size: buffer.length, expiresAt: Date.now() + TTL_MS });
  return token;
}

/** 过期/不存在返回 null（路由层转 410）。 */
export function getArtifact(token: string): ArtifactRecord | null {
  const a = artifacts.get(token);
  if (!a) return null;
  if (Date.now() > a.expiresAt) {
    artifacts.delete(token);
    return null;
  }
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
