/**
 * <uploaded-file …/> reference tag: construction (adapter send) and parsing/folding (bubble rendering).
 * The tag enters the message body as plain text — it is the carrier of "optimistic message == pi record == replay" consistency;
 * the render layer only does display transforms and never alters the message original.
 */
export interface UploadedFileMeta {
  name: string;
  path: string;
  chars: string;
}

/** Attribute order fixed (name/path/chars), mirror of the parsing regex.
 *  Leading \s*: when the tag hugs the body's newline (typical: body\n<uploaded-file …/>), the newline is consumed together with the tag,
 *  so the body segment carries no trailing whitespace — both round-trip and folded rendering depend on this semantic. */
export const UPLOADED_FILE_TAG_RE = /\s*<uploaded-file\s+name="([^"]*)"\s+path="([^"]*)"\s+chars="([^"]*)"\s*\/>/g;

export function buildUploadedFileTag(name: string, path: string, chars: number | null): string {
  const n = name.replace(/"/g, '&quot;');
  const c = chars === null ? 'unknown' : String(chars);
  return `<uploaded-file name="${n}" path="${path}" chars="${c}"/>`;
}

/** Split text into [string | UploadedFileMeta, …] segments. Pure function. */
export function splitUploadedFileTags(text: string): (string | UploadedFileMeta)[] {
  // A module-level /g regex keeps a stale lastIndex after external .test() calls — reset before use, matchAll iterates from the start.
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
