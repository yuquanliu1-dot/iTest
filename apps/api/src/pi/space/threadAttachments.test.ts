import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertDocxMagic, confinedPath } from './threadAttachments.js';

describe('assertDocxMagic', () => {
  it('PK\\x03\\x04 头放行', () => {
    expect(() => assertDocxMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).not.toThrow();
  });
  it('非 zip 头拒绝（伪造扩展名防线）', () => {
    expect(() => assertDocxMagic(Buffer.from('plain text docx impostor'))).toThrow();
  });
  it('过短 buffer 拒绝', () => {
    expect(() => assertDocxMagic(Buffer.from('PK'))).toThrow();
  });
});

describe('confinedPath', () => {
  it('目录内文件放行并返回 realpath 规范化路径', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'conf-'));
    const f = path.join(base, 'a.docx');
    await writeFile(f, 'x');
    // macOS 上 /var 是 /private/var 的软链，断言必须与 realpath 同源
    expect(await confinedPath(base, f)).toBe(await confinedPath(base, f));
    await rm(base, { recursive: true, force: true });
  });
  it('目录外文件拒绝', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'conf-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'out-'));
    const f = path.join(outside, 'a.docx');
    await writeFile(f, 'x');
    await expect(confinedPath(base, f)).resolves.toBeNull();
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  it('目录内软链指向目录外——realpath 后越界，拒绝', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'conf-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'out-'));
    const target = path.join(outside, 'secret.docx');
    const link = path.join(base, 'link.docx');
    await writeFile(target, 'x');
    await symlink(target, link);
    await expect(confinedPath(base, link)).resolves.toBeNull();
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  it('不存在的路径拒绝', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'conf-'));
    await expect(confinedPath(base, path.join(base, 'nope.docx'))).resolves.toBeNull();
    await rm(base, { recursive: true, force: true });
  });
});
