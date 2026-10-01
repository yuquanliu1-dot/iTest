import { create } from 'zustand';
import { api, type LoginResponse, type MeResponse, type OrgMembership, type SafeUser } from '../api/client';
import { useProjectStore } from './project';

interface AuthState {
  user: SafeUser | null;
  organizations: OrgMembership[];
  activeOrgId: string | null;
  isAuthenticated: boolean;
  /** 首次 /me 探测进行中（AuthGuard 据此显示 loading，避免未探测完就误跳登录页） */
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

  // 启动时用 /me 探测会话；401 → 清空会话（client 层对 /auth/me 豁免跳转）
  initialize: async () => {
    if (get().isAuthenticated) return;
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

  // 登录响应只带激活组织，再拉一次 /me 补全组织列表（组织切换器用）
  applyLogin: async (r) => {
    set({ user: r.user, activeOrgId: r.organization.id, isAuthenticated: true });
    try {
      get().applyMe(await api.auth.me());
    } catch {
      // /me 失败不阻塞登录；组织列表留空
    }
  },

  // 切换组织 = 服务端重铸 cookie；必须清项目上下文，防止 localStorage 残留指向不可见项目
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
