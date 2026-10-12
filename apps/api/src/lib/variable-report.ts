import { collectVarRefs, safeRegex, validateVariableName } from '@itest/shared';
import type { StepAction } from '@itest/shared';

export interface VariableIssue {
  stepOrder: number;
  field: string;
  name: string;
}

export interface DuplicateIssue {
  name: string;
  definedAt: number[];
}

export interface RegexIssue {
  stepOrder: number;
  reason: string;
}

export interface VarNameIssue {
  stepOrder: number;
  field: string;
  name: string;
  reason: string;
}

export interface VariableReport {
  undefined: VariableIssue[];
  duplicates: DuplicateIssue[];
  forwardRefs: VariableIssue[];
  regexIssues: RegexIssue[];
  invalidNames: VarNameIssue[];
}

/** 从 step 抓可被 substitute 的所有字符串字段路径。 */
function stringFields(step: StepAction): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  const a = step as Record<string, unknown>;
  switch (a.kind) {
    case 'fill':
      if (typeof a.value === 'string') out.push({ field: 'fill.value', text: a.value });
      break;
    case 'select':
      if (typeof a.value === 'string') out.push({ field: 'select.value', text: a.value });
      break;
    case 'assertText':
      if (typeof a.equals === 'string') out.push({ field: 'assertText.equals', text: a.equals });
      break;
    case 'assertJson':
      out.push({ field: 'assertJson.equals', text: JSON.stringify(a.equals ?? null) });
      break;
    case 'navigate':
      if (typeof a.url === 'string') out.push({ field: 'navigate.url', text: a.url });
      break;
    case 'screenshot':
      if (typeof a.name === 'string') out.push({ field: 'screenshot.name', text: a.name });
      break;
    case 'httpRequest': {
      if (typeof a.url === 'string') out.push({ field: 'httpRequest.url', text: a.url });
      const headers = a.headers;
      if (Array.isArray(headers)) {
        for (const h of headers as Array<{ key?: unknown; value?: unknown }>) {
          if (typeof h.key === 'string') out.push({ field: 'httpRequest.headers.key', text: h.key });
          if (typeof h.value === 'string') out.push({ field: 'httpRequest.headers.value', text: h.value });
        }
      }
      if (typeof a.body === 'string') out.push({ field: 'httpRequest.body', text: a.body });
      const assertion = a.assertion as { expected?: unknown } | undefined;
      if (assertion && typeof assertion.expected === 'string') out.push({ field: 'httpRequest.assertion.expected', text: assertion.expected });
      break;
    }
  }
  return out;
}

export function buildVariableReport(steps: StepAction[], initialVars?: string[]): VariableReport {
  const definedOrder = new Map<string, number>();
  const duplicates = new Map<string, number[]>();
  const undef: VariableIssue[] = [];
  const forward: VariableIssue[] = [];
  const regexIssues: RegexIssue[] = [];
  const invalidNames: VarNameIssue[] = [];

  // 初始变量（绑定数据集的列）：视为步骤 0 前已定义（order=-1）。
  // 只消灭 undefined/forwardRefs 误报；不参与 duplicates —— extract 覆盖同名初始变量属合法运行时语义（后写生效），
  // 且 definedOrder 保留 -1：对它的前向引用用初始值，不算 forward。
  for (const name of initialVars ?? []) definedOrder.set(name, -1);

  // First pass: register all extract varName / httpRequest saveAs varName → earliest definition order.
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i]!;
    if (a.kind === 'extract') {
      const nameCheck = validateVariableName(a.varName);
      if (!nameCheck.ok) {
        invalidNames.push({ stepOrder: i, field: 'extract.varName', name: a.varName, reason: nameCheck.reason ?? 'invalid' });
      }
      const name = a.varName;
      const prev = definedOrder.get(name);
      if (prev !== undefined && prev >= 0) {
        const arr = duplicates.get(name) ?? [prev];
        arr.push(i);
        duplicates.set(name, arr);
      } else if (prev === undefined) {
        definedOrder.set(name, i);
      }
      // prev === -1（初始变量）：保留 -1，不记 duplicate
      if (a.mode === 'regex' && a.pattern) {
        const r = safeRegex(a.pattern);
        if (!r.ok) regexIssues.push({ stepOrder: i, reason: r.reason });
      }
    } else if (a.kind === 'httpRequest' && a.saveAs) {
      const nameCheck = validateVariableName(a.saveAs.varName);
      if (!nameCheck.ok) {
        invalidNames.push({ stepOrder: i, field: 'httpRequest.saveAs.varName', name: a.saveAs.varName, reason: nameCheck.reason ?? 'invalid' });
      }
      const name = a.saveAs.varName;
      const prev = definedOrder.get(name);
      if (prev !== undefined && prev >= 0) {
        const arr = duplicates.get(name) ?? [prev];
        arr.push(i);
        duplicates.set(name, arr);
      } else if (prev === undefined) {
        definedOrder.set(name, i);
      }
      if (a.assertion?.match === 'regex' && a.assertion.expected) {
        const r = safeRegex(a.assertion.expected);
        if (!r.ok) regexIssues.push({ stepOrder: i, reason: r.reason });
      }
    }
  }

  // Second pass: walk string fields and classify refs.
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i]!;
    if (a.kind === 'extract') continue;
    for (const { field, text } of stringFields(a)) {
      for (const name of collectVarRefs(text)) {
        if (!definedOrder.has(name)) {
          undef.push({ stepOrder: i, field, name });
        } else if (definedOrder.get(name)! > i) {
          forward.push({ stepOrder: i, field, name });
        }
      }
    }
  }

  return {
    undefined: undef,
    duplicates: [...duplicates.entries()].map(([name, definedAt]) => ({ name, definedAt })),
    forwardRefs: forward,
    regexIssues,
    invalidNames,
  };
}
