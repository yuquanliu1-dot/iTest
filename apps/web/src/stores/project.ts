import { create } from 'zustand';

const STORAGE_KEY = 'itest-current-project';

export interface CurrentProject {
  id: string;
  name: string;
  defaultUrl: string | null;
  versionId: string | null;
  versionName: string | null;
}

interface ProjectState {
  current: CurrentProject | null;
  enter: (p: CurrentProject) => void;
  switchVersion: (versionId: string, versionName: string) => void;
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
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string') return null;
    return {
      id: parsed.id,
      name: parsed.name,
      defaultUrl: parsed.defaultUrl ?? null,
      versionId: parsed.versionId ?? null,
      versionName: parsed.versionName ?? null,
    };
  } catch {
    return null;
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  current: readStored(),

  enter: (p) => {
    set({ current: p });
    persist(p);
  },

  switchVersion: (versionId, versionName) => {
    const cur = get().current;
    if (!cur) return;
    const next: CurrentProject = { ...cur, versionId, versionName };
    set({ current: next });
    persist(next);
  },

  exit: () => {
    set({ current: null });
    persist(null);
  },
}));