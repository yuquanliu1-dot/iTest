import { create } from 'zustand';
import { toast } from 'sonner';

type ToastKind = 'success' | 'error' | 'info';

interface UIState {
  showToast: (message: string, kind?: ToastKind) => void;
}

// 渲染交给 shadcn/sonner Toaster（App.tsx 挂载）；store 只保留 showToast API。
export const useUIStore = create<UIState>(() => ({
  showToast: (message, kind = 'info') => {
    if (kind === 'success') toast.success(message, { duration: 3500 });
    else if (kind === 'error') toast.error(message, { duration: 3500 });
    else toast(message, { duration: 3500 });
  },
}));
