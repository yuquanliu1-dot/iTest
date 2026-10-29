/**
 * <uploaded-file …/> 引用标签：构造（adapter send 用）与解析折叠（气泡渲染用）。
 * 标签以纯文本形态进消息正文——这是「乐观消息 == pi 记录 == 回放」一致性的载体，
 * 渲染层只做显示变换，绝不改消息原文。
 */
export interface UploadedFileMeta {
  name: string;
  path: string;
  chars: string;
}

/** 属性顺序固定（name/path/chars），与解析正则互为镜像。
 *  前导 \s*：标签紧贴正文换行时（典型：正文\n<uploaded-file …/>），换行随标签一起吃掉，
 *  正文段不带尾随空白——round-trip 与折叠渲染都依赖这一语义。 */
export const UPLOADED_FILE_TAG_RE = /\s*<uploaded-file\s+name="([^"]*)"\s+path="([^"]*)"\s+chars="([^"]*)"\s*\/>/g;

export function buildUploadedFileTag(name: string, path: string, chars: number | null): string {
  const n = name.replace(/"/g, '&quot;');
  const c = chars === null ? 'unknown' : String(chars);
  return `<uploaded-file name="${n}" path="${path}" chars="${c}"/>`;
}

/** 把文本切成 [string | UploadedFileMeta, …] 段。纯函数。 */
export function splitUploadedFileTags(text: string): (string | UploadedFileMeta)[] {
  // 模块级 /g 正则被外部 .test() 用过后 lastIndex 残留——用前归零，matchAll 从头迭代。
  UPLOADED_FILE_TAG_RE.lastIndex = 0;
  const out: (string | UploadedFileMeta)[] = [];
  let last = 0;
  for (const m of text.matchAll(UPLOADED_FILE_TAG_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    out.push({ name: m[1]!, path: m[2]!, chars: m[3]! });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [''];
}
