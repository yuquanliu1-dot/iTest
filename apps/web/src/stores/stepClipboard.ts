import { create } from 'zustand';

export interface StepClip {
  action: unknown;
  source: string;
  delayMs?: number | null;
  /** 2026-10-06：行级自然语言。
   *  取代旧 name 字段(2026-10-07 移除):之前 name 既当 UI 短标题又当 instruction 兜底,职责混;现在统一到 instruction。 */
  instruction?: string | null;
  /** 2026-10-06：可执行 DSL 数组；空数组 = 未编译（保存时 blocker）。
   *  类型为 unknown[]，与 TestStep 对齐；dispatcher 与 AI 编译最终按 StepAction[] 解析。 */
  compiled?: unknown[] | null;
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
