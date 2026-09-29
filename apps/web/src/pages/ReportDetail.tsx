import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

interface StepResult {
  order: number;
  status: string;
  durationMs: number;
  error?: string;
  screenshot?: string;
}

export default function ReportDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.reports.get(id!),
    enabled: !!id,
  });

  if (isLoading || !data) return <div className="glass-panel p-8">加载中...</div>;

  const stepResults = (data.stepResults as StepResult[]) ?? [];

  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <Link to="/reports" style={{ color: 'var(--color-text-secondary)' }}>
        ← 返回报告列表
      </Link>
      <div className="glass-panel p-6">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-semibold">测试报告</h1>
            <p style={{ color: 'var(--color-text-muted)' }} className="text-sm mt-1">
              {new Date(data.createdAt).toLocaleString('zh-CN')}
            </p>
          </div>
          <div
            className="text-lg font-bold px-4 py-2 rounded"
            style={{
              color: data.status === 'passed' ? 'var(--color-success)' : 'var(--color-destructive)',
              background:
                data.status === 'passed' ? 'rgba(18,183,106,0.1)' : 'rgba(240,68,56,0.1)',
            }}
          >
            {data.status.toUpperCase()}
          </div>
        </div>
        {data.summary && <p className="mt-4">{data.summary}</p>}
        <p className="text-sm mt-2" style={{ color: 'var(--color-text-muted)' }}>
          总耗时：{data.durationMs ?? 0} ms
        </p>
      </div>

      <div className="glass-panel p-6">
        <h2 className="text-lg font-semibold mb-4">步骤时间线</h2>
        <ol className="flex flex-col gap-3">
          {stepResults.map((s, i) => (
            <li key={i} className="flex gap-3 items-start p-3 rounded border" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
              <span
                className="font-mono text-sm flex-shrink-0"
                style={{
                  color: s.status === 'passed' ? 'var(--color-success)' : 'var(--color-destructive)',
                }}
              >
                {s.status === 'passed' ? '✓' : '✕'} #{s.order}
              </span>
              <div className="flex-1">
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {s.durationMs} ms
                </div>
                {s.error && (
                  <div className="text-sm mt-1" style={{ color: 'var(--color-destructive)' }}>
                    {s.error}
                  </div>
                )}
              </div>
              {s.screenshot && (
                <img
                  src={s.screenshot}
                  alt={`step ${s.order}`}
                  className="w-16 h-16 rounded border"
                  style={{ borderColor: 'rgba(0,0,0,0.1)' }}
                />
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}