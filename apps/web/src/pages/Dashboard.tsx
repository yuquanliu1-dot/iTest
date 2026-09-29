import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

interface Stats {
  requirements: number;
  cases: number;
  reports: number;
  recentRuns: Array<{ id: string; targetType: string; status: string; startedAt: string }>;
}

export default function Dashboard() {
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: async (): Promise<Stats> => {
      const [reqs, cases, reports] = await Promise.all([
        api.requirements.list(),
        api.cases.list(),
        api.reports.list(),
      ]);
      return {
        requirements: reqs.length,
        cases: cases.length,
        reports: reports.length,
        recentRuns: reports.slice(0, 5).map((r) => ({
          id: r.id,
          targetType: 'execute',
          status: r.status,
          startedAt: r.createdAt,
        })),
      };
    },
  });

  if (stats.isLoading) return <div className="glass-panel p-8">加载中...</div>;
  if (!stats.data) return null;

  const cards = [
    { label: '需求', value: stats.data.requirements, to: '/requirements' },
    { label: '用例', value: stats.data.cases, to: '/cases' },
    { label: '报告', value: stats.data.reports, to: '/reports' },
  ];

  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">iTest 控制台</h1>
      <div className="grid grid-cols-3 gap-4">
        {cards.map((c) => (
          <Link
            key={c.label}
            to={c.to}
            className="glass-panel p-6 hover:shadow-lg transition"
            style={{ textDecoration: 'none', color: 'var(--color-text-primary)' }}
          >
            <div className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              {c.label}
            </div>
            <div className="text-3xl font-bold mt-2" style={{ color: 'var(--color-primary)' }}>
              {c.value}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}