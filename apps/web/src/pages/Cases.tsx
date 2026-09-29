import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

const PRIORITIES = ['', 'P0', 'P1', 'P2', 'P3'];

export default function Cases() {
  const [priority, setPriority] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['cases', priority],
    queryFn: () => api.cases.list(priority || undefined),
  });

  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-semibold">用例列表</h1>
        <select className="input-base" style={{ width: 160 }} value={priority} onChange={(e) => setPriority(e.target.value)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p || '全部优先级'}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="glass-panel p-8">加载中...</div>
      ) : (
        <div className="glass-panel overflow-hidden">
          <table className="w-full text-sm">
            <thead style={{ background: 'rgba(124,92,252,0.05)' }}>
              <tr>
                <th className="text-left p-3">标题</th>
                <th className="text-left p-3">优先级</th>
                <th className="text-left p-3">状态</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((c) => (
                <tr key={c.id} className="border-t" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
                  <td className="p-3">
                    <Link to={`/cases/${c.id}`} style={{ color: 'var(--color-primary)' }}>
                      {c.title}
                    </Link>
                  </td>
                  <td className="p-3">{c.priority}</td>
                  <td className="p-3">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}