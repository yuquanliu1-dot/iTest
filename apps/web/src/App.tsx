import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import { useThemeStore } from './stores/theme';
import Dashboard from './pages/Dashboard';
import Requirements from './pages/Requirements';
import RequirementDetail from './pages/RequirementDetail';
import Cases from './pages/Cases';
import CaseDetail from './pages/CaseDetail';
import Reports from './pages/Reports';
import ReportDetail from './pages/ReportDetail';
import Settings from './pages/Settings';

export default function App() {
  const initTheme = useThemeStore((s) => s.init);
  useEffect(() => { initTheme(); }, [initTheme]);

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/requirements" element={<Requirements />} />
        <Route path="/requirements/:id" element={<RequirementDetail />} />
        <Route path="/cases" element={<Cases />} />
        <Route path="/cases/:id" element={<CaseDetail />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/reports/:id" element={<ReportDetail />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}
