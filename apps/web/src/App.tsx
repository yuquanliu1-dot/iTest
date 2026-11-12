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
import LandingPage from './pages/LandingPage';
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
import Explorations from './pages/Explorations';
import ExplorationDetail from './pages/ExplorationDetail';
import ExplorationMatrix from './pages/ExplorationMatrix';
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
      {/* Global toast container: must be mounted outside Routes so the login page (no AppShell) can also show error toasts */}
      <Toaster />
      <Routes>
      {/* Public routes: login (including first-login forced password change) */}
      <Route path="/login" element={<LoginPage />} />
      {/* Public route: product marketing page */}
      <Route path="/landing" element={<LandingPage />} />
      {/* Protected routes: AuthGuard probes the session, then rendering goes through AppShell */}
      <Route element={<AppShell><AuthGuard /></AppShell>}>
        <Route path="/" element={<ProjectsHome />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/members/*" element={<MembersPage />} />
        {/* The standalone product-lines page has been merged into the home "Projects & product lines" page; old links redirect */}
        <Route path="/product-lines" element={<Navigate to="/" replace />} />
        <Route path="/settings" element={<Settings />} />
        {/* Project-level environment maintenance: no version context needed, and no requirement to have "entered" the project (ProjectGuard validates store.current) */}
        <Route path="/p/:projectId/environments" element={<EnvironmentsPage />} />
        {/* Project-level dataset maintenance: same level as the environments page, no version context needed */}
        <Route path="/p/:projectId/datasets" element={<DatasetsPage />} />
        {/* Project-level device target maintenance: simulator/emulator config for mobile cases */}
        <Route path="/p/:projectId/device-targets" element={<DeviceTargetsPage />} />
        <Route path="/p/:projectId" element={<ProjectGuard />}>
          {/* Versioned nested path /v/:versionId/...: the version is written to the store when "entering" from the ProjectsHome row */}
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
            <Route path="explorations" element={<Explorations />} />
            <Route path="explorations/matrix/:matrixId" element={<ExplorationMatrix />} />
            <Route path="explorations/:id" element={<ExplorationDetail />} />
          </Route>
          {/* Legacy path compatibility: no version number → back to the home page to pick a project */}
          <Route index element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
        <Route path="*" element={<ProjectsHome />} />
      </Route>
      </Routes>
    </>
  );
}