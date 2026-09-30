import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import ProjectGuard from './components/layout/ProjectGuard';
import { useThemeStore } from './stores/theme';
import ProjectsHome from './pages/ProjectsHome';
import Dashboard from './pages/Dashboard';
import Requirements from './pages/Requirements';
import RequirementDetail from './pages/RequirementDetail';
import GroupsPage from './pages/GroupsPage';
import CaseDetail from './pages/CaseDetail';
import Plans from './pages/Plans';
import PlanDetail from './pages/PlanDetail';
import Reports from './pages/Reports';
import ReportDetail from './pages/ReportDetail';
import Settings from './pages/Settings';

export default function App() {
  const initTheme = useThemeStore((s) => s.init);
  useEffect(() => { initTheme(); }, [initTheme]);

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<ProjectsHome />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/p/:projectId" element={<ProjectGuard />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<Dashboard />} />
          <Route path="groups" element={<GroupsPage />} />
          <Route path="groups/:groupId" element={<GroupsPage />} />
          <Route path="cases/:id" element={<CaseDetail />} />
          <Route path="requirements" element={<Requirements />} />
          <Route path="requirements/:id" element={<RequirementDetail />} />
          <Route path="plans" element={<Plans />} />
          <Route path="plans/:id" element={<PlanDetail />} />
          <Route path="reports" element={<Reports />} />
          <Route path="reports/:id" element={<ReportDetail />} />
        </Route>
        <Route path="*" element={<ProjectsHome />} />
      </Routes>
    </AppShell>
  );
}
