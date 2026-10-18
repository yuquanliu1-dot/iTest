/** 文件树纯函数：把服务端返回的扁平 path 列表转成嵌套树，供设置页渲染。
 *  独立成文件是为了能脱离 React 直接单测——分组/排序规则很容易写错，
 *  而这类 bug 在 UI 上只表现为「目录没缩进」这种看不出来的偏差。 */
import type { FlatSkillNode, SkillTreeDir, SkillTreeFile, SkillTreeNode } from './skillTree-types';

export type { SkillTreeDir, SkillTreeFile, SkillTreeNode, FlatSkillNode } from './skillTree-types';

/** 取父目录路径；顶层节点的父是 ''（技能根）。 */
export function dirnameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}
export function fileNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** 扁平列表 → 嵌套树。
 *  - 目录排在文件前面，且都按名称字典序（localeCompare）——与服务端 listSkillTree 的排序同向。
 *  - 父目录缺失时（服务端理论上会先发目录节点）就地补一个空目录，避免文件凭空消失。
 *  - 同一路径重复出现时后者覆盖前者（服务端已去重，这里只是防御）。 */
export function buildTree(nodes: FlatSkillNode[]): SkillTreeNode[] {
  const dirs = new Map<string, SkillTreeDir>();
  const roots: SkillTreeNode[] = [];

  // 先建全部目录骨架，再挂文件——否则「先来的文件」找不到尚未创建的父目录。
  for (const n of nodes) {
    if (n.kind !== 'dir' || dirs.has(n.path)) continue;
    dirs.set(n.path, { kind: 'dir', path: n.path, name: fileNameOf(n.path), children: [] });
  }
  for (const [path, dir] of dirs) {
    const parent = dirnameOf(path);
    const p = parent === '' ? undefined : dirs.get(parent);
    // 父不存在则视为顶层：宁可展示错层级，也不能让目录连带子树整段消失。
    if (p) p.children.push(dir);
    else roots.push(dir);
  }

  for (const n of nodes) {
    if (n.kind !== 'file') continue;
    const file: SkillTreeFile = {
      kind: 'file', path: n.path, name: fileNameOf(n.path), size: n.size, runtime: n.runtime,
    };
    const parent = dirnameOf(n.path);
    const p = parent === '' ? undefined : dirs.get(parent);
    if (p) p.children.push(file);
    else roots.push(file);
  }

  const sortRec = (list: SkillTreeNode[]): void => {
    list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    for (const n of list) if (n.kind === 'dir') sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** 目标上传目录：选中目录用它自己；选中文件用其父目录；没选东西用技能根（''）。
 *  服务端不递归建目录：目标目录不存在时 resolveInSkill(requireParentExisting) 会拒，
 *  所以「上传到哪」永远由当前选中项决定，而不是让人敲路径。 */
export function uploadDirOf(selected: { kind: 'file' | 'dir'; path: string } | null): string {
  if (!selected) return '';
  return selected.kind === 'dir' ? selected.path : dirnameOf(selected.path);
}
