import { create } from 'zustand';
import { toast } from 'sonner';

type ToastKind = 'success' | 'error' | 'info';

interface UIState {
  showToast: (message: string, kind?: ToastKind) => void;
}

// Rendering is delegated to the shadcn/sonner Toaster (mounted in App.tsx); the store keeps only the showToast API.
export const useUIStore = create<UIState>(() => ({
  showToast: (message, kind = 'info') => {
    if (kind === 'success') toast.success(message, { duration: 3500 });
    else if (kind === 'error') toast.error(message, { duration: 3500 });
    else toast(message, { duration: 3500 });
  },
}));
