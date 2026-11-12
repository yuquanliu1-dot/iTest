import type { ValueGenerator, ValueFragment, CompositeValue } from './step-dsl.js';
import { substituteVars } from './variable.js';

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

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : '0'.repeat(len - s.length) + s;
}

function formatDate(d: Date, fmt: 'YYYYMMDD' | 'YYYY-MM-DD' | 'YYYY/MM/DD'): string {
  const y = String(d.getFullYear());
  const m = padLeft(String(d.getMonth() + 1), 2);
  const day = padLeft(String(d.getDate()), 2);
  switch (fmt) {
    case 'YYYYMMDD': return `${y}${m}${day}`;
    case 'YYYY-MM-DD': return `${y}-${m}-${day}`;
    case 'YYYY/MM/DD': return `${y}/${m}/${day}`;
  }
}

function evaluateFragment(f: ValueFragment): string {
  switch (f.mode) {
    case 'fixed': return f.value;
    case 'date': return formatDate(new Date(), f.format);
    case 'randomNumber': {
      // length controls the digit count; when absent, no left zero-padding is done (keeps behavior predictable).
      if (f.length == null) {
        const min = f.min ?? 0;
        const max = f.max ?? 999999;
        if (max < min) throw new Error(`randomNumber range invalid: max (${max}) < min (${min})`);
        return String(randomInt(min, max));
      }
      // When length is given, constrain the range to match the digit count to avoid overflow.
      const len = f.length;
      const max = f.max ?? (len <= 1 ? 9 : Math.pow(10, len) - 1);
      const min = f.min ?? (len <= 1 ? 0 : Math.pow(10, len - 1));
      if (max < min) throw new Error(`randomNumber range invalid: max (${max}) < min (${min})`);
      const n = randomInt(min, max);
      return padLeft(String(n), len);
    }
    case 'randomString': return randomString(f.length);
    case 'timestamp': return String(Date.now());
  }
}

function evaluateComposite(c: CompositeValue): string {
  const parts: string[] = [];
  c.fragments.forEach((f, idx) => {
    try {
      parts.push(evaluateFragment(f));
    } catch (e) {
      throw new Error(`fragment #${idx + 1}: ${(e as Error).message}`);
    }
  });
  return parts.join('');
}

/** Runtime materialization: string goes straight through substituteVars; composite is assembled from fragments then substituteVars; other generators are evaluated then substituteVars. Throws and lists the missing names when the template references undefined variables. */
export function materializeValue(value: string | ValueGenerator | CompositeValue, vars: Record<string, string>): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if ('fragments' in value) text = evaluateComposite(value);
  else text = evaluateGenerator(value);
  const r = substituteVars(text, vars);
  if (r.missing.length > 0) {
    throw new Error(`未定义的变量: ${r.missing.join(', ')}`);
  }
  return r.value;
}

/** Deep JSON comparison (key order independent). */
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
