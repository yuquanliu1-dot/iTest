import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import ToastRenderer from './components/layout/ToastRenderer';
import AuthGuard from './components/auth/AuthGuard';
import ProjectGuard from './components/layout/ProjectGuard';
import { useThemeStore } from './stores/theme';
import LoginPage from './pages/LoginPage';
import ProjectsHome from './pages/ProjectsHome';
import Dashboard from './pages/Dashboard';
import AiWorkspacePage from './pages/AiWorkspacePage';
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

  return (
    <>
      {/* 全局 toast 容器：必须挂在 Routes 之外，登录页（无 AppShell）也能显示错误提示 */}
      <ToastRenderer />
      <Routes>
      {/* 公开路由：登录（含首登强制改密） */}
      <Route path="/login" element={<LoginPage />} />
      {/* 受保护路由：AuthGuard 探测会话后经 AppShell 渲染 */}
      <Route element={<AppShell><AuthGuard /></AppShell>}>
        <Route path="/" element={<ProjectsHome />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/members/*" element={<MembersPage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/p/:projectId" element={<ProjectGuard />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<Dashboard />} />
          <Route path="groups" element={<GroupsPage />} />
          <Route path="groups/:groupId" element={<GroupsPage />} />
          <Route path="cases/:id" element={<CaseDetail />} />
          <Route path="ai/:id" element={<AiWorkspacePage />} />
          <Route path="plans" element={<Plans />} />
          <Route path="plans/:id" element={<PlanDetail />} />
          <Route path="plans/:id/runs/:runId" element={<PlanRunDetail />} />
          <Route path="reports" element={<Executions />} />
          <Route path="reports/:id" element={<ReportDetail />} />
        </Route>
        <Route path="*" element={<ProjectsHome />} />
      </Route>
      </Routes>
    </>
  );
}
