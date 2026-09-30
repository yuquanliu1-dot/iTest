import { create } from 'zustand';

export interface StepClip {
  action: unknown;
  source: string;
  name?: string | null;
  delayMs?: number | null;
}

interface StepClipboardState {
  steps: StepClip[];
  setSteps: (steps: StepClip[]) => void;
}

/** 跨用例步骤剪贴板：复制后可粘贴到任意用例。 */
export const useStepClipboard = create<StepClipboardState>((set) => ({
  steps: [],
  setSteps: (steps) => set({ steps }),
}));
