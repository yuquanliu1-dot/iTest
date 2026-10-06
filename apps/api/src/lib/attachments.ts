import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(process.cwd(), '.data', 'uploads');
export const DEFAULT_UPLOAD_MAX_BYTES = 10485760; // 10 MB; iTest cap. Override via UPLOAD_MAX_BYTES.

// Read at call time so tests can tweak the limit via process.env without re-importing.
export function uploadMaxBytes(): number {
  return Number(process.env.UPLOAD_MAX_BYTES ?? DEFAULT_UPLOAD_MAX_BYTES);
}

export interface PreparedUpload {
  sha256: string;
  storedPath: string;
  size: number;
}

export async function ensureUploadDir(): Promise<void> {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

export async function persistUpload(buf: Buffer): Promise<PreparedUpload> {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  // Bucket by first 2 chars of sha256 to avoid single-directory file count blow-up
  const storedPath = join(UPLOAD_DIR, sha256.slice(0, 2), sha256);
  await mkdir(join(UPLOAD_DIR, sha256.slice(0, 2)), { recursive: true });
  await writeFile(storedPath, buf);
  return { sha256, storedPath, size: buf.length };
}
