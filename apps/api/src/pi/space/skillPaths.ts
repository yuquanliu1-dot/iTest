/**
 * skill 目录树路径守卫 + 原子写。全仓唯一的技能文件路径校验入口：REST 文件树接口 /
 * read_skill / run_skill_script / import_skill 落盘都走这里。
 *
 * 为什么不用现成的纯词法写法：runSkillScript 里的 normalize+startsWith 只挡 ../ 与绝对路径，
 * <skill>/scripts 若是软链则直接穿透到 /etc。本模块补 realpath 解析，且按「段」而非整串校验
 * （.git / node_modules / 隐藏文件逐段拒，而不是只查首段）。
 *
 * 不递归 mkdir：写入目标的所有父目录必须已存在——目录结构来自 import（可信来源），
 * 不是来自人在设置页敲的路径。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_REL_LEN = 512;
const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules']);

/** rel 合法则返回绝对路径，非法返回 null。opts.requireParentExisting=true 用于写入路径。 */
export function resolveInSkill(
  root: string,
  rel: string,
  opts: { requireParentExisting?: boolean } = {},
): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_REL_LEN) return null;
  if (rel.includes('\0') || rel.includes('\\')) return null;
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;

  const segments = rel.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return null;
    if (seg.startsWith('.')) return null;
    if (FORBIDDEN_SEGMENTS.has(seg)) return null;
  }

  const realRoot = realOrSelf(root);
  const abs = path.resolve(realRoot, ...segments);
  if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) return null;

  // 目标尚不存在时 realpath 会抛；改用「最深已存在祖先」解析后把尾部接回去再校验。
  const realAbs = realpathDeepestExisting(abs);
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) return null;

  if (opts.requireParentExisting && !fs.existsSync(path.dirname(abs))) return null;
  return abs;
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** abs 可能尚不存在：向上找到第一个存在的祖先，realpath 它，再把尾部接回去。 */
function realpathDeepestExisting(abs: string): string {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // 一路到根都不存在，交由上层 startsWith 判负
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** 原子写：同目录临时文件 + rename（同文件系统，rename 原子）。中途被 kill 不会留半截文件。 */
export function writeSkillFileAtomic(absPath: string, content: string): void {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, absPath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 已清理 */ }
    throw e;
  }
}

/** 删除技能目录：目录名必须是合法 slug，且父目录必须恰为 root（防未来重构误删整个 root）。 */
export function removeSkillDir(root: string, name: string): void {
  const dir = path.join(root, name);
  if (path.dirname(dir) !== path.resolve(root)) throw new Error(`拒绝删除非技能目录: ${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
