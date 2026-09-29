import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';

const PROVIDERS = [
  { value: 'mock', label: 'mock（推荐，无需 API key）' },
  { value: 'openai', label: 'openai' },
  { value: 'anthropic', label: 'anthropic' },
  { value: 'google', label: 'google' },
];

export default function Settings() {
  const toast = useUIStore((s) => s.showToast);
  const [provider, setProvider] = useState('mock');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');

  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: api.settings.list });

  useEffect(() => {
    if (!data) return;
    setProvider((data.llm_provider as string) ?? 'mock');
    setApiKey((data.llm_api_key as string) ?? '');
    setModel((data.llm_model as string) ?? '');
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      await api.settings.put('llm_provider', provider);
      await api.settings.put('llm_api_key', apiKey);
      await api.settings.put('llm_model', model);
    },
    onSuccess: () => toast('设置已保存', 'success'),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (isLoading) return <div className="glass-panel p-8">加载中...</div>;

  return (
    <div className="glass-panel p-8 max-w-2xl">
      <h1 className="text-2xl font-semibold mb-2">设置</h1>
      <p style={{ color: 'var(--color-text-secondary)' }} className="mb-6">
        LLM Provider / API Key 配置
      </p>
      <div className="flex flex-col gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">LLM Provider</label>
          <select className="input-base" value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            mock 模式不消耗 token；选择具体 provider 后需填写 API key。
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">API Key</label>
          <input
            className="input-base"
            type="password"
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Model</label>
          <input
            className="input-base"
            placeholder="例如 gpt-4o-mini / claude-sonnet-4-6"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
        <button
          className="btn-primary self-start"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );
}