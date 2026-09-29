import { Routes, Route } from 'react-router-dom';
import AppShell from './components/AppShell';
import Dashboard from './pages/Dashboard';
import Requirements from './pages/Requirements';
import Cases from './pages/Cases';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/requirements" element={<Requirements />} />
        <Route path="/cases" element={<Cases />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}