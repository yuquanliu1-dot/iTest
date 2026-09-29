import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export default function Reports() {
  const { data, isLoading } = useQuery({ queryKey: ['reports'], queryFn: api.reports.list });

  if (isLoading) return <div className="glass-panel p-8">加载中...</div>;

  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">报告列表</h1>
      <div className="glass-panel overflow-hidden">
        <table className="w-full text-sm">
          <thead style={{ background: 'rgba(124,92,252,0.05)' }}>
            <tr>
              <th className="text-left p-3">用例 ID</th>
              <th className="text-left p-3">状态</th>
              <th className="text-left p-3">耗时</th>
              <th className="text-left p-3">时间</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} className="border-t" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
                <td className="p-3">
                  <Link to={`/reports/${r.id}`} style={{ color: 'var(--color-primary)' }}>
                    {r.caseId.slice(0, 8)}...
                  </Link>
                </td>
                <td className="p-3">
                  <span
                    style={{
                      color: r.status === 'passed' ? 'var(--color-success)' : 'var(--color-destructive)',
                      fontWeight: 600,
                    }}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="p-3">{r.durationMs ?? 0} ms</td>
                <td className="p-3" style={{ color: 'var(--color-text-muted)' }}>
                  {new Date(r.createdAt).toLocaleString('zh-CN')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}