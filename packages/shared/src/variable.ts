export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Validates the variable name format: `^[A-Za-z_][A-Za-z0-9_]*$`, 1-64 characters. */
export function validateVariableName(name: string): { ok: boolean; reason?: string } {
  if (!name) return { ok: false, reason: '变量名不能为空' };
  if (name.length > 64) return { ok: false, reason: '变量名长度不能超过 64' };
  if (!VAR_NAME_RE.test(name)) return { ok: false, reason: '变量名只能包含字母、数字、下划线，且不能以数字开头' };
  return { ok: true };
}

/** Extracts all `{{name}}` reference names from a string, deduplicated, order preserved. */
export function collectVarRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(VAR_RE)) out.add(m[1]!);
  return [...out];
}

export interface SubstituteResult {
  value: string;
  missing: string[];
}

/** Substitutes `{{name}}` templates. Undefined variables keep the template as-is and are recorded in missing (never throws). */
export function substituteVars(text: string, vars: Record<string, string>): SubstituteResult {
  const missing: string[] = [];
  const value = text.replace(VAR_RE, (m, name: string) => {
    if (Object.hasOwn(vars, name)) return vars[name]!;
    if (!missing.includes(name)) missing.push(name);
    return m;
  });
  return { value, missing };
}

/** Nested quantifier blacklist (a hit means possible catastrophic backtracking). */
const NESTED_QUANTIFIER_RE = /\([^?][^)]*[+*]\)[+*?]|\([^?][^)]*\+[^)]*[+*]\)/;

/** Regex safety check: rejects on compile time > 50ms or a blacklist hit. */
export function safeRegex(
  pattern: string,
): { ok: true } | { ok: false; reason: string } {
  if (!pattern) return { ok: false, reason: 'pattern 不能为空' };
  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    return { ok: false, reason: 'pattern 含嵌套量词，可能造成灾难性回溯' };
  }
  const t0 = Date.now();
  try {
    new RegExp(pattern);
  } catch (e) {
    return { ok: false, reason: `pattern 不是合法正则: ${(e as Error).message}` };
  }
  if (Date.now() - t0 > 50) {
    return { ok: false, reason: 'pattern 编译耗时 > 50ms，可能含灾难性回溯' };
  }
  return { ok: true };
}