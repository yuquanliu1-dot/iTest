import { create } from 'zustand';

type RecorderStatus = 'idle' | 'starting' | 'recording' | 'finishing' | 'error';

interface RecorderState {
  status: RecorderStatus;
  sessionId: string | null;
  errorMessage: string | null;
  setStatus: (status: RecorderStatus) => void;
  setSession: (sessionId: string) => void;
  setError: (msg: string) => void;
  reset: () => void;
}

export const useRecorderStore = create<RecorderState>((set) => ({
  status: 'idle',
  sessionId: null,
  errorMessage: null,
  setStatus: (status) => set({ status }),
  setSession: (sessionId) => set({ sessionId }),
  setError: (msg) => set({ status: 'error', errorMessage: msg }),
  reset: () => set({ status: 'idle', sessionId: null, errorMessage: null }),
}));