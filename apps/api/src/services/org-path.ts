// 组织 path 纯函数：均以 / 开头、/ 结尾（如 /org-a/org-b/）；此处对无尾斜杠输入做防御性归一化。
export function isPathInSubtree(candidatePath: string, ancestorPath: string): boolean {
  const cand = candidatePath.endsWith('/') ? candidatePath : candidatePath + '/';
  const anc = ancestorPath.endsWith('/') ? ancestorPath : ancestorPath + '/';
  if (cand === anc) return true;
  return cand.startsWith(anc);
}
