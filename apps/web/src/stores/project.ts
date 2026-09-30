import { create } from 'zustand';

const STORAGE_KEY = 'itest-current-project';

export interface CurrentProject {
  id: string;
  name: string;
  defaultUrl: string | null;
}

interface ProjectState {
  current: CurrentProject | null;
  enter: (p: CurrentProject) => void;
  exit: () => void;
}

function persist(p: CurrentProject | null): void {
  try {
    if (p) localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable; project context is in-memory only.
  }
}

function readStored(): CurrentProject | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return null;
    const parsed = JSON.parse(v) as CurrentProject;
    return typeof parsed.id === 'string' && typeof parsed.name === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export const useProjectStore = create<ProjectState>((set) => ({
  current: readStored(),

  enter: (p) => {
    set({ current: p });
    persist(p);
  },

  exit: () => {
    set({ current: null });
    persist(null);
  },
}));
