/** Diff text for scalar fields: `k: before → after` (sorted by key); object/array fields and updatedAt are skipped. Returns undefined when nothing changed. */
export function diffText(before: Record<string, unknown>, after: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  for (const k of Object.keys(before).sort()) {
    if (k === 'updatedAt' || !(k in after)) continue;
    const b = before[k];
    const a = after[k];
    if (b === a) continue;
    if (b !== null && typeof b === 'object') continue;
    if (a !== null && typeof a === 'object') continue;
    lines.push(`${k}: ${String(b)} → ${String(a)}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}
