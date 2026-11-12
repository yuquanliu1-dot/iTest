// Org path pure functions: all start and end with / (e.g. /org-a/org-b/); this defensively normalizes inputs missing the trailing slash.
export function isPathInSubtree(candidatePath: string, ancestorPath: string): boolean {
  const cand = candidatePath.endsWith('/') ? candidatePath : candidatePath + '/';
  const anc = ancestorPath.endsWith('/') ? ancestorPath : ancestorPath + '/';
  if (cand === anc) return true;
  return cand.startsWith(anc);
}
