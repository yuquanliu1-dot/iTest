import { create } from 'zustand';

export interface AgentRunEvent {
  type: string;
  payload: unknown;
}

interface AgentRunState {
  activeRunId: string | null;
  events: AgentRunEvent[];
  setActive: (runId: string | null) => void;
  pushEvent: (event: AgentRunEvent) => void;
  clear: () => void;
}

export const useAgentRunStore = create<AgentRunState>((set) => ({
  activeRunId: null,
  events: [],
  setActive: (runId) => set({ activeRunId: runId }),
  pushEvent: (event) => set((s) => ({ events: [...s.events, event] })),
  clear: () => set({ activeRunId: null, events: [] }),
}));