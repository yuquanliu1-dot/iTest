import { create } from 'zustand';

interface AgentRunState {
  activeRunId: string | null;
  events: Array<{ type: string; payload: unknown }>;
  setActive: (runId: string | null) => void;
  pushEvent: (event: { type: string; payload: unknown }) => void;
  clear: () => void;
}

export const useAgentRunStore = create<AgentRunState>((set) => ({
  activeRunId: null,
  events: [],
  setActive: (runId) => set({ activeRunId: runId }),
  pushEvent: (event) => set((s) => ({ events: [...s.events, event] })),
  clear: () => set({ activeRunId: null, events: [] }),
}));