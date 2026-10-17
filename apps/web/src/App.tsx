import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import { Toaster } from './components/ui/shadcn/sonner';
import AuthGuard from './components/auth/AuthGuard';
import ProjectGuard from './components/layout/ProjectGuard';
import { useThemeStore } from './stores/theme';
import { useAuthStore } from './stores/auth';
import { applyLang, langFromPref } from './stores/lang';
import LoginPage from './pages/LoginPage';
import ProjectsHome from './pages/ProjectsHome';
import EnvironmentsPage from './pages/EnvironmentsPage';
import DatasetsPage from './pages/DatasetsPage';
import DeviceTargetsPage from './pages/DeviceTargetsPage';
import Dashboard from './pages/Dashboard';
import AssistantPage from './pages/AssistantPage';
import GroupsPage from './pages/GroupsPage';
import CaseDetail from './pages/CaseDetail';
import Plans from './pages/Plans';
import PlanDetail from './pages/PlanDetail';
import PlanRunDetail from './pages/PlanRunDetail';
import Executions from './pages/Reports';
import ReportDetail from './pages/ReportDetail';
import MembersPage from './pages/MembersPage';
import Settings from './pages/Settings';

export default function App() {
  const initTheme = useThemeStore((s) => s.init);
  useEffect(() => { initTheme(); }, [initTheme]);

  const user = useAuthStore((s) => s.user);
  useEffect(() => {
    applyLang(langFromPref(user?.languagePreference));
  }, [user?.languagePreference]);

  return (
    <>
      {/* 全局 toast 容器：必须挂在 Routes 之外，登录页（无 AppShell）也能显示错误提示 */}
      <Toaster />
      <Routes>
      {/* 公开路由：登录（含首登强制改密） */}
      <Route path="/login" element={<LoginPage />} />
      {/* 受保护路由：AuthGuard 探测会话后经 AppShell 渲染 */}
      <Route element={<AppShell><AuthGuard /></AppShell>}>
        <Route path="/" element={<ProjectsHome />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/members/*" element={<MembersPage />} />
        <Route path="/settings" element={<Settings />} />
        {/* 项目级环境维护：不依赖版本上下文，也不要求「进入」过项目（ProjectGuard 校验 store.current） */}
        <Route path="/p/:projectId/environments" element={<EnvironmentsPage />} />
        {/* 项目级数据集维护：与环境页同层级，不依赖版本上下文 */}
        <Route path="/p/:projectId/datasets" element={<DatasetsPage />} />
        {/* 项目级设备目标维护：移动端用例的 simulator/emulator 配置 */}
        <Route path="/p/:projectId/device-targets" element={<DeviceTargetsPage />} />
        <Route path="/p/:projectId" element={<ProjectGuard />}>
          {/* 版本化二级路径 /v/:versionId/...：版本号由 ProjectsHome 行「进入」写入 store */}
          <Route path="v/:versionId">
            <Route index element={<Navigate to="assistant" replace />} />
            <Route path="assistant" element={<AssistantPage />} />
            <Route path="overview" element={<Dashboard />} />
            <Route path="groups" element={<GroupsPage />} />
            <Route path="groups/:groupId" element={<GroupsPage />} />
            <Route path="cases/:id" element={<CaseDetail />} />
            <Route path="plans" element={<Plans />} />
            <Route path="plans/:id" element={<PlanDetail />} />
            <Route path="plans/:id/runs/:runId" element={<PlanRunDetail />} />
            <Route path="reports" element={<Executions />} />
            <Route path="reports/:id" element={<ReportDetail />} />
          </Route>
          {/* 旧路径兼容：未带版本号 → 回首页选项目 */}
          <Route index element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
        <Route path="*" element={<ProjectsHome />} />
      </Route>
      </Routes>
    </>
  );
}