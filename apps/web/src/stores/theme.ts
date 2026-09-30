import { create } from 'zustand';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'itest-theme';

interface ThemeState {
  theme: Theme;
  init: () => void;
  toggleTheme: () => void;
}

function applyTheme(theme: Theme): void {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage unavailable; theme is in-memory only.
  }
}

function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: 'light',

  init: () => {
    const theme = readStoredTheme();
    set({ theme });
    applyTheme(theme);
  },

  toggleTheme: () => {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
    set({ theme: next });
    applyTheme(next);
    persistTheme(next);
  },
}));
