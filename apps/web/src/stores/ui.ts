import { create } from 'zustand';

interface Toast {
  id: number;
  message: string;
  kind: 'success' | 'error' | 'info';
}

interface UIState {
  toasts: Toast[];
  showToast: (message: string, kind?: Toast['kind']) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useUIStore = create<UIState>((set) => ({
  toasts: [],
  showToast: (message, kind = 'info') => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));