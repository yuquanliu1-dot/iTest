/**
 * Space assistant tools' shared types and compiled-step normalization.
 * ToolExecutor is the "unit-testable executor + TypeBox schema" shape (no pi-coding-agent dependency),
 * consumed by pi/space/tools/* and pi/space/session.ts.
 */
import { Type } from '@earendil-works/pi-ai';

export interface ToolExecutor {
  name: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  /** On success may carry text back to the model (e.g. inspect_page's element listing); defaults to 'ok'.
   *  signal = session stop signal (passed through per-tool by the pi agent): long tasks (verify/solidify) interrupt via it. */
  execute: (
    input: unknown,
    signal?: AbortSignal,
  ) => Promise<{ ok: true; data?: string } | { ok: false; error: string }>;
  /** Passed through to defineTool's promptGuidelines, appended to the agent system prompt's Guidelines section. */
  promptGuidelines?: string[];
}

/** Stop guard: rejects immediately if signal is already aborted or when it aborts, for Promise.race to preempt long tasks. */
export function abortGuard(signal: AbortSignal | undefined, message = '已停止：用户中断了本次操作'): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(new Error(message));
    else signal.addEventListener('abort', () => reject(new Error(message)), { once: true });
  });
}

/**
 * Normalizes a single LLM-emitted compiled step into the shape replay recognizes.
 * Historical measurement shows the LLM occasionally produces abnormal shapes:
 *  1) locator written as a {item:{strategy,value}} single-object wrapper → restored to [{strategy,value}]
 *  2) locator written directly as a {strategy,value} single object → wrapped into an array
 *  3) each locator candidate wrapped in an extra array ([[{...},{...}]]) → peeled down to [{...},{...}]
 *  4) locator written as {item:[{...},{...}]} (a candidate array inside an item wrapper) → flattened to [{...},{...}]
 *  5) numeric fields written as strings (timeoutMs:"20000") → coerced to numbers
 *  navigate / screenshot / aiTask and other locator-less fields pass through as-is.
 *
 * Normalization is the "absorb the model's natural output" layer: shape anomalies must not become a tool-parameter validation failure
 * (prod228 session 2026-10-21T07-36-23: the model had 5 consecutive stage_case calls rejected, re-editing a step version each time — pure wasted LLM turns).
 */
export function normalizeCompiledStep(step: unknown): unknown {
  if (!step || typeof step !== 'object') return step;
  const s = step as Record<string, unknown>;
  const loc = s.locator;
  if (Array.isArray(loc) || (loc && typeof loc === 'object')) {
    const flat: unknown[] = [];
    flattenLocator(loc, flat);
    s.locator = flat;
  }
  for (const k of NUMERIC_STEP_KEYS) coerceNumericString(s, k);
  return s;
}

/** Flattens a locator's various wrappers/nestings until only the candidate-object array remains.
 *  Recursively consumes: arrays ([[...]] / [{item:[...]}]), {item:X} wrappers (X may be an object or array). */
function flattenLocator(value: unknown, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const v of value) flattenLocator(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Already candidate-shaped (strategy/value) → accept as-is; otherwise if wrapped in {item:...}, peel it.
    if (obj.strategy !== undefined || obj.value !== undefined) {
      out.push(obj);
      return;
    }
    if ('item' in obj) {
      flattenLocator(obj.item, out);
      return;
    }
  }
  out.push(value);
}

/** Common numeric fields in the step DSL: the model occasionally writes them as strings ("20000"); coercing each avoids the whole step being rejected by zod. */
const NUMERIC_STEP_KEYS = [
  'timeoutMs', 'delayMs', 'durationMs', 'longPressMs', 'windowMs', 'fromLine',
  'limit', 'port', 'status', 'group', 'latitude', 'longitude',
] as const;

/** Coerces numeric fields the model wrote as strings (non-pure-digit strings are kept as-is and left for zod to report a clear error). */
function coerceNumericString(obj: Record<string, unknown>, key: string): void {
  const v = obj[key];
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) obj[key] = Number(v.trim());
}
