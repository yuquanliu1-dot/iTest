/** File tree pure functions: convert the flat path list returned by the server into a nested tree for the settings page.
 *  Extracted into its own file so it can be unit-tested without React — grouping/sorting rules are easy to get wrong,
 *  and such bugs only show up in the UI as an imperceptible deviation like "dirs not indented". */
import type { FlatSkillNode, SkillTreeDir, SkillTreeFile, SkillTreeNode } from './skillTree-types';

export type { SkillTreeDir, SkillTreeFile, SkillTreeNode, FlatSkillNode } from './skillTree-types';

/** Get the parent directory path; the parent of a top-level node is '' (the skill root). */
export function dirnameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}
export function fileNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Flat list → nested tree.
 *  - Dirs come before files, both sorted by name lexicographically (localeCompare) — same direction as the server's listSkillTree ordering.
 *  - When a parent dir is missing (the server should send dir nodes first), create an empty dir in place so files don't vanish.
 *  - When the same path appears repeatedly, the later one overwrites the earlier (the server already dedupes; this is just defensive). */
export function buildTree(nodes: FlatSkillNode[]): SkillTreeNode[] {
  const dirs = new Map<string, SkillTreeDir>();
  const roots: SkillTreeNode[] = [];

  // Build the full dir skeleton first, then attach files — otherwise an "earlier file" can't find its not-yet-created parent dir.
  for (const n of nodes) {
    if (n.kind !== 'dir' || dirs.has(n.path)) continue;
    dirs.set(n.path, { kind: 'dir', path: n.path, name: fileNameOf(n.path), children: [] });
  }
  for (const [path, dir] of dirs) {
    const parent = dirnameOf(path);
    const p = parent === '' ? undefined : dirs.get(parent);
    // No parent means top level: prefer showing a wrong level over letting a dir and its whole subtree disappear.
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

/** Target upload dir: a selected dir uses itself; a selected file uses its parent dir; nothing selected uses the skill root ('').
 *  The server doesn't create dirs recursively: resolveInSkill(requireParentExisting) rejects a missing target dir,
 *  so "where to upload" is always decided by the current selection instead of asking the user to type a path. */
export function uploadDirOf(selected: { kind: 'file' | 'dir'; path: string } | null): string {
  if (!selected) return '';
  return selected.kind === 'dir' ? selected.path : dirnameOf(selected.path);
}
