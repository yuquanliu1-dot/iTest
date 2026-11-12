import { create } from 'zustand';
import { api, type LoginResponse, type MeResponse, type OrgMembership, type SafeUser } from '../api/client';
import { useProjectStore } from './project';

interface AuthState {
  user: SafeUser | null;
  organizations: OrgMembership[];
  activeOrgId: string | null;
  isAuthenticated: boolean;
  /** First /me probe in progress (AuthGuard shows loading based on this, avoiding a premature jump to the login page before probing finishes) */
  isLoading: boolean;
  initialize: () => Promise<void>;
  applyLogin: (r: Extract<LoginResponse, { status: 'ok' }>) => Promise<void>;
  applyMe: (me: MeResponse) => void;
  switchOrg: (orgId: string) => Promise<void>;
  logout: () => Promise<void>;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  organizations: [],
  activeOrgId: null,
  isAuthenticated: false,
  isLoading: true,

  // On startup, probe the session with /me; 401 → clear the session (the client layer exempts /auth/me from the redirect)
  initialize: async () => {
    // When applyLogin has already set isAuthenticated (redirect to / after direct /login sign-in), the initial isLoading must also be cleared,
    // otherwise AuthGuard stays in the loading state forever (the early return skips the finally).
    if (get().isAuthenticated) {
      set({ isLoading: false });
      return;
    }
    try {
      get().applyMe(await api.auth.me());
    } catch {
      get().clearSession();
    } finally {
      set({ isLoading: false });
    }
  },

  applyMe: (me) =>
    set({
      user: me.user,
      organizations: me.organizations,
      activeOrgId: me.activeOrganizationId,
      isAuthenticated: true,
    }),

  // The login response only carries the active organization; fetch /me once more to complete the organization list (used by the org switcher)
  applyLogin: async (r) => {
    set({ user: r.user, activeOrgId: r.organization.id, isAuthenticated: true });
    try {
      get().applyMe(await api.auth.me());
    } catch {
      // A /me failure must not block login; the organization list stays empty
    }
  },

  // Switching org = the server re-mints the cookie; the project context must be cleared so localStorage does not keep pointing at invisible projects
  switchOrg: async (orgId) => {
    await api.auth.switchOrg(orgId);
    useProjectStore.getState().exit();
    get().applyMe(await api.auth.me());
  },

  logout: async () => {
    try {
      await api.auth.logout();
    } finally {
      get().clearSession();
    }
  },

  clearSession: () => {
    set({ user: null, organizations: [], activeOrgId: null, isAuthenticated: false, isLoading: false });
    useProjectStore.getState().exit();
  },
}));
