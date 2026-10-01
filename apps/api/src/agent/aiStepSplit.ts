/**
 * 按编号段拆一条自然语言指令。匹配规则：行首空白 + 数字 + `.` 或 `、` + 空白。
 * - 无编号段 → 返回 [raw]
 * - 编号段数 < 2 → 返回 [raw]（不去凑数）
 * - 编号段之间允许空白行；段内多行用 \n 拼接
 */
export function splitByNumber(raw: string): string[] {
  const re = /^[ \t]*\d+(?:\.[ \t]+|、[ \t]*)(.+)$/;
  const lines = raw.split(/\r?\n/);
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) matches.push(i);
  }
  if (matches.length < 2) return [raw];
  const result: string[] = [];
  for (let k = 0; k < matches.length; k++) {
    const start = matches[k]!;
    const end = k + 1 < matches.length ? matches[k + 1]! : lines.length;
    const inner = lines
      .slice(start, end)
      .map((line) => line.replace(re, '$1'))
      .filter((s) => s.length > 0);
    const joined = inner.join('\n').trim();
    if (joined) result.push(joined);
  }
  return result.length >= 2 ? result : [raw];
}

/** 整批拆条；就地把 aiStep 拆为多条同 kind 步骤，保留原步骤元数据。返回展开数量。 */
export function splitAiStepsInPlace(
  steps: Array<{ action: unknown; order?: number; name?: string; delayMs?: number; source?: string }>,
): { expanded: number } {
  let expanded = 0;
  const out: typeof steps = [];
  for (const s of steps) {
    const a = s.action as { kind?: string; instruction?: string; compiled?: unknown };
    if (a?.kind !== 'aiStep') {
      out.push(s);
      continue;
    }
    const parts = splitByNumber(a.instruction ?? '');
    if (parts.length <= 1) {
      out.push(s);
      continue;
    }
    expanded += parts.length - 1;
    parts.forEach((p, idx) => {
      out.push({
        ...s,
        action: {
          kind: 'aiStep',
          instruction: p,
          compiled: idx === 0 ? (a.compiled ?? null) : null,
        },
      });
    });
  }
  steps.length = 0;
  steps.push(...out);
  return { expanded };
}
