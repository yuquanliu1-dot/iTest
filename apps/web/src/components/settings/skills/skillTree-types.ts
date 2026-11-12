/** Node types for the skill file tree (the counterpart of the server's AssistantSkillFileNode).
 *  A separate file so that skillTree.ts / SkillFilesDialog.tsx / skillTree.test.ts
 *  don't have to drag api/client into their type dependencies — pure-function unit tests shouldn't pull in the whole client module. */

export interface SkillTreeDir {
  kind: 'dir';
  /** Full path relative to the skill root (for a dir node, the directory's own path). */
  path: string;
  name: string;
  children: SkillTreeNode[];
}
export interface SkillTreeFile {
  kind: 'file';
  path: string;
  name: string;
  size: number;
  runtime?: string;
}
export type SkillTreeNode = SkillTreeDir | SkillTreeFile;

/** Flat node returned by the server's GET /tree (wire shape): no name — name is derived from the path's last segment. */
export type FlatSkillNode =
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string; size: number; runtime?: string };
