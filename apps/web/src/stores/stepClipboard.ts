import { create } from 'zustand';

export interface StepClip {
  action: unknown;
  source: string;
  delayMs?: number | null;
  /** 2026-10-06: row-level natural language.
   *  Replaces the old name field (removed 2026-10-07): name previously served both as the UI short title and the instruction fallback — mixed responsibilities; now unified into instruction. */
  instruction?: string | null;
  /** 2026-10-06: executable DSL array; empty array = uncompiled (a blocker at save time).
   *  Typed as unknown[], aligned with TestStep; the dispatcher and AI compilation ultimately resolve it as StepAction[]. */
  compiled?: unknown[] | null;
}

interface StepClipboardState {
  steps: StepClip[];
  setSteps: (steps: StepClip[]) => void;
}

/** Cross-case step clipboard: after copying, steps can be pasted into any case. */
export const useStepClipboard = create<StepClipboardState>((set) => ({
  steps: [],
  setSteps: (steps) => set({ steps }),
}));
