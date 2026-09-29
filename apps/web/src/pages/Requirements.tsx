import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';

export default function Requirements() {
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['requirements'], queryFn: api.requirements.list });
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [creating, setCreating] = useState(false);

  const create = useMutation({
    mutationFn: () => api.requirements.create({ title, content }),
    onSuccess: () => {
      setTitle('');
      setContent('');
      setCreating(false);
      toast('需求已创建', 'success');
      qc.invalidateQueries({ queryKey: ['requirements'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (isLoading) return <div className="glass-panel p-8">加载中...</div>;

  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-semibold">需求列表</h1>
        <button className="btn-primary" onClick={() => setCreating((v) => !v)}>
          {creating ? '取消' : '+ 新建需求'}
        </button>
      </div>

      {creating && (
        <div className="glass-panel p-6 flex flex-col gap-3">
          <input
            className="input-base"
            placeholder="标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="input-base"
            placeholder="需求描述"
            rows={4}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <button
            className="btn-primary self-start"
            disabled={!title || !content || create.isPending}
            onClick={() => create.mutate()}
          >
            创建
          </button>
        </div>
      )}

      <div className="glass-panel overflow-hidden">
        <table className="w-full text-sm">
          <thead style={{ background: 'rgba(124,92,252,0.05)' }}>
            <tr>
              <th className="text-left p-3">标题</th>
              <th className="text-left p-3">状态</th>
              <th className="text-left p-3">创建时间</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} className="border-t" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
                <td className="p-3">
                  <Link to={`/requirements/${r.id}`} style={{ color: 'var(--color-primary)' }}>
                    {r.title}
                  </Link>
                </td>
                <td className="p-3">{r.status}</td>
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