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

/** Grabs all string field paths on a step that substituteVars can substitute. */
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

  // Initial variables (columns of a bound dataset): treated as defined before step 0 (order=-1).
  // Only kills undefined/forwardRefs false positives; does not participate in duplicates — an extract overwriting an
  // initial variable of the same name is legal runtime semantics (last write wins), and definedOrder keeps -1:
  // forward references to it use the initial value and do not count as forward.
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
      // prev === -1 (initial variable): keep -1, do not record a duplicate
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
