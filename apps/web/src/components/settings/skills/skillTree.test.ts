import { describe, it, expect } from 'vitest';
import type { FlatSkillNode } from './skillTree-types';
import { buildTree, dirnameOf, fileNameOf, uploadDirOf } from './skillTree';

const n = (path: string, kind: 'file' | 'dir', size = 0, runtime?: string): FlatSkillNode =>
  kind === 'dir' ? { path, kind } : { path, kind, size, runtime };

describe('dirnameOf / fileNameOf', () => {
  it('顶层文件无目录，嵌套文件取到父目录', () => {
    expect(dirnameOf('SKILL.md')).toBe('');
    expect(fileNameOf('SKILL.md')).toBe('SKILL.md');
    expect(dirnameOf('scripts/run.py')).toBe('scripts');
    expect(fileNameOf('scripts/run.py')).toBe('run.py');
    expect(dirnameOf('a/b/c.txt')).toBe('a/b');
  });
});

describe('buildTree', () => {
  it('扁平列表 → 嵌套树，目录收拢子节点', () => {
    const tree = buildTree([
      n('SKILL.md', 'file', 100),
      n('scripts', 'dir'),
      n('scripts/run.py', 'file', 10, 'python3'),
      n('references', 'dir'),
      n('references/schemas.md', 'file', 20),
    ]);
    expect(tree.map((x) => x.path)).toEqual(['references', 'scripts', 'SKILL.md']);
    const scripts = tree.find((x) => x.path === 'scripts');
    expect(scripts?.kind).toBe('dir');
    expect(scripts?.kind === 'dir' && scripts.children.map((c) => c.path)).toEqual(['scripts/run.py']);
    const refs = tree.find((x) => x.path === 'references');
    expect(refs?.kind === 'dir' && refs.children[0]?.kind).toBe('file');
  });

  it('目录排在文件前，同类按名称字典序', () => {
    const tree = buildTree([n('b.txt', 'file'), n('a.txt', 'file'), n('zdir', 'dir'), n('adir', 'dir')]);
    expect(tree.map((x) => x.path)).toEqual(['adir', 'zdir', 'a.txt', 'b.txt']);
  });

  it('深层目录递归嵌套', () => {
    const tree = buildTree([
      n('eval-viewer', 'dir'),
      n('eval-viewer/gen.py', 'file'),
      n('eval-viewer/lib', 'dir'),
      n('eval-viewer/lib/util.py', 'file'),
    ]);
    const ev = tree[0]!;
    expect(ev.path).toBe('eval-viewer');
    // lib 目录排在 gen.py 前面
    expect(ev.kind === 'dir' && ev.children.map((c) => c.path)).toEqual(['eval-viewer/lib', 'eval-viewer/gen.py']);
    const lib = ev.kind === 'dir' ? ev.children[0] : null;
    expect(lib?.kind === 'dir' && lib.children[0]?.path).toBe('eval-viewer/lib/util.py');
  });

  it('父目录节点缺失时不丢文件（提升为顶层），而非整段消失', () => {
    // 服务端总会先发 dir 节点；这里是防御：万一没有，文件也得看得见。
    const tree = buildTree([n('scripts/run.py', 'file')]);
    expect(tree.map((x) => x.path)).toEqual(['scripts/run.py']);
  });

  it('保留 file 的 size / runtime', () => {
    const tree = buildTree([n('scripts/run.py', 'file', 42, 'python3')]);
    const f = tree[0]!;
    expect(f.kind === 'file' && f.size).toBe(42);
    expect(f.kind === 'file' && f.runtime).toBe('python3');
  });

  it('空列表 → 空树', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('同名重复路径不产生重复节点', () => {
    const tree = buildTree([n('scripts', 'dir'), n('scripts', 'dir'), n('a.py', 'file')]);
    expect(tree.filter((x) => x.path === 'scripts')).toHaveLength(1);
  });
});

describe('uploadDirOf', () => {
  it('未选中 → 技能根', () => {
    expect(uploadDirOf(null)).toBe('');
  });
  it('选中目录 → 该目录自身', () => {
    expect(uploadDirOf(n('scripts', 'dir'))).toBe('scripts');
  });
  it('选中文件 → 其父目录', () => {
    expect(uploadDirOf(n('scripts/run.py', 'file'))).toBe('scripts');
    expect(uploadDirOf(n('SKILL.md', 'file'))).toBe('');
  });
});
