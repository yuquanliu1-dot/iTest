/**
 * resolveInSkill：skill 目录树路径守卫。
 *
 * 现有 runSkillScript 的 safeResolve 是纯词法的（normalize + startsWith），
 * 只挡 ../ 与绝对路径；<skill>/scripts 若是软链则直接穿透到 /etc。本文件专门
 * 覆盖 realpath 解析那一类，以及逐段（而非整串）校验的差异。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInSkill } from '../src/pi/space/skillPaths.js';

describe('resolveInSkill', () => {
  let root: string;

  beforeEach(async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'itest-skillpaths-'));
    // resolveInSkill 返回 realpath 规范化后的路径（/var → /private/var），故 root 也要规范化后比对
    root = await fs.promises.realpath(dir);
    await fs.promises.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'scripts', 'a.py'), 'x');
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('合法相对路径通过', () => {
    expect(resolveInSkill(root, 'scripts/a.py')).toBe(path.join(root, 'scripts', 'a.py'));
    expect(resolveInSkill(root, 'scripts')).toBe(path.join(root, 'scripts'));
    expect(resolveInSkill(root, 'scripts/new.py')).toBe(path.join(root, 'scripts', 'new.py'));
  });

  it('拒绝：绝对路径 / .. / 盘符 / 反斜杠 / 空字节', () => {
    expect(resolveInSkill(root, '/etc/passwd')).toBeNull();
    expect(resolveInSkill(root, '../../etc/passwd')).toBeNull();
    expect(resolveInSkill(root, 'C:\\Windows\\x')).toBeNull();
    expect(resolveInSkill(root, 'scripts\\..\\..\\x')).toBeNull();
    expect(resolveInSkill(root, 'a\0b')).toBeNull();
    expect(resolveInSkill(root, '')).toBeNull();
    expect(resolveInSkill(root, '   ')).toBe(path.join(root, '   ')); // 空格是合法文件名，不额外拒
  });

  it('拒绝：隐藏文件 / .git / node_modules（逐段判，不只判首段）', () => {
    expect(resolveInSkill(root, '.env')).toBeNull();
    expect(resolveInSkill(root, '.git/config')).toBeNull();
    expect(resolveInSkill(root, 'node_modules/x.js')).toBeNull();
    expect(resolveInSkill(root, 'scripts/.hidden')).toBeNull();
    expect(resolveInSkill(root, 'scripts/node_modules/x')).toBeNull();
  });

  it('拒绝：软链逃逸（词法守卫挡不住的那一类）', async () => {
    const link = path.join(root, 'evil');
    try {
      await fs.promises.symlink('/tmp', link);
    } catch {
      return; // Windows 无权限时跳过
    }
    expect(resolveInSkill(root, 'evil/passwd')).toBeNull();
  });

  it('requireParentExisting：写入时父目录必须已存在', () => {
    expect(resolveInSkill(root, 'no/such/dir/f.py', { requireParentExisting: true })).toBeNull();
    expect(resolveInSkill(root, 'scripts/new.py', { requireParentExisting: true })).toBe(
      path.join(root, 'scripts', 'new.py'),
    );
  });
});
