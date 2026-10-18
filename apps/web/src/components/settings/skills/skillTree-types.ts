/** 技能文件树的节点类型（服务端 AssistantSkillFileNode 的对应物）。
 *  单独成文件是为了 skillTree.ts / SkillFilesDialog.tsx / skillTree.test.ts
 *  都不必把 api/client 拖进类型依赖——纯函数单测不该连带整个 client 模块。 */

export interface SkillTreeDir {
  kind: 'dir';
  /** 相对技能根的完整路径（dir 节点即该目录自身路径）。 */
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

/** 服务端 GET /tree 返回的扁平节点（wire 形态）：没有 name——name 由 path 末段推出。 */
export type FlatSkillNode =
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string; size: number; runtime?: string };
