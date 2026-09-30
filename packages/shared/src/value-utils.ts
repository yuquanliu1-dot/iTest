import type { ValueGenerator } from './step-dsl.js';

const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function randomString(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CHARS[Math.floor(Math.random() * CHARS.length)];
  return out;
}

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function evaluateGenerator(gen: ValueGenerator): string {
  switch (gen.mode) {
    case 'randomString':
      return randomString(gen.length);
    case 'randomNumber':
      return String(randomInt(gen.min, gen.max));
    case 'timestamp':
      return String(Date.now());
    case 'prefixTimestamp':
      return `${gen.prefix}${Date.now()}`;
  }
}

const VAR_RE = /\{\{(\w+)\}\}/g;

/** 替换 {{var}} 模板；未定义变量抛错并列出缺失变量名。 */
export function substituteVars(text: string, vars: Record<string, string>): string {
  const missing: string[] = [];
  const out = text.replace(VAR_RE, (m, name: string) => {
    if (!(name in vars)) {
      missing.push(name);
      return m;
    }
    return vars[name]!;
  });
  if (missing.length > 0) {
    throw new Error(`未定义的变量: ${[...new Set(missing)].join(', ')}`);
  }
  return out;
}

/** 执行期物化：generator 先求值，再做 {{var}} 替换。 */
export function materializeValue(value: string | ValueGenerator, vars: Record<string, string>): string {
  const text = typeof value === 'string' ? value : evaluateGenerator(value);
  return substituteVars(text, vars);
}

/** JSON 深比较（key 顺序无关）。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => deepEqual(v, b[i]))
    );
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}