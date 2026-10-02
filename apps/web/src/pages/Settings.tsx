import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useThemeStore } from '../stores/theme';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Toggle from '../components/ui/Toggle';

const PROVIDERS = [
  { value: 'openai', label: 'openai' },
  { value: 'anthropic', label: 'anthropic' },
  { value: 'google', label: 'google' },
];

/** 与 apps/api/src/agent/llm-client.ts 中的服务端回退默认值保持一致。 */
const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-6',
  google: 'gemini-2.0-flash',
};

type Panel = 'llm' | 'appearance';

const PANELS: Array<{ key: Panel; label: string; icon: 'beaker' | 'sparkles' }> = [
  { key: 'llm', label: 'LLM Provider', icon: 'beaker' },
  { key: 'appearance', label: '外观', icon: 'sparkles' },
];

export default function Settings() {
  const toast = useUIStore((s) => s.showToast);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const [panel, setPanel] = useState<Panel>('llm');

  // LLM form
  const [provider, setProvider] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: api.settings.list });

  useEffect(() => {
    if (!data) return;
    setProvider((data.llm_provider as string) ?? 'openai');
    setApiKey((data.llm_api_key as string) ?? '');
    setModel((data.llm_model as string) ?? '');
    setBaseUrl((data.llm_base_url as string) ?? '');
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      await api.settings.put('llm_provider', provider);
      await api.settings.put('llm_api_key', apiKey);
      await api.settings.put('llm_model', model);
      await api.settings.put('llm_base_url', baseUrl);
    },
    onSuccess: () => toast('设置已保存', 'success'),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const test = useMutation({
    mutationFn: () => api.settings.testConnection({ provider, apiKey, model, baseUrl }),
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            设置
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            LLM provider 与偏好配置
          </p>
        </div>
      </div>

      {/* Two-panel card（iDO 设置页规范） */}
      <div className="flex h-full gap-3 p-3 flex-1 min-h-0">
        <div
          className="glass-card shrink-0 flex flex-col"
          style={{ width: 240 }}
        >
          <div className="hairline-bottom" style={{ padding: '12px 16px' }}>
            <h2 className="text-[14px] font-semibold m-0" style={{ color: 'var(--color-foreground)' }}>
              设置面板
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto" style={{ padding: 8 }}>
            {PANELS.map((p) => {
              const active = p.key === panel;
              return (
                <button
                  key={p.key}
                  onClick={() => setPanel(p.key)}
                  data-active={active || undefined}
                  className="group-nav-item block"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', padding: 0 }}
                >
                  <div
                    className="flex items-center gap-2 w-full"
                    style={{
                      height: 36,
                      padding: '0 8px',
                      borderRadius: 5,
                      background: active ? 'var(--color-accent-light)' : undefined,
                      color: active ? 'var(--color-accent)' : 'var(--color-foreground-secondary)',
                      fontWeight: active ? 500 : 400,
                      fontSize: 13,
                    }}
                  >
                    <Icon name={p.icon} size={14} />
                    <span className="flex-1">{p.label}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="glass-card flex-1 min-w-0 overflow-y-auto" style={{ padding: 20 }}>
          {panel === 'llm' && (
            <div className="flex flex-col gap-4 max-w-xl">
              <div>
                <h3 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--color-foreground)' }}>
                  LLM Provider
                </h3>
                <p className="text-[12px] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
                  选择 provider 并填写 API key 后即可使用。
                </p>
                <select className="input-base" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <Input
                type="password"
                label="API Key"
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <div>
                <Input
                  label="Base URL（可选）"
                  placeholder="https://api.anthropic.com（留空用官方地址）"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <p className="text-[11px] mt-1" style={{ color: 'var(--color-foreground-muted)' }}>
                  内网网关 / 代理地址，如 http://192.168.2.197:3000
                </p>
              </div>
              <div>
                <Input
                  label="Model"
                  placeholder="留空使用默认模型"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                {DEFAULT_MODELS[provider] && (
                  <p className="text-[11px] mt-1" style={{ color: 'var(--color-foreground-muted)' }}>
                    默认：{DEFAULT_MODELS[provider]}（留空时服务端自动使用）
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <Button disabled={save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? '保存中...' : '保存'}
                </Button>
                <Button variant="secondary" disabled={test.isPending} onClick={() => test.mutate()}>
                  {test.isPending ? '测试中...' : '测试连接'}
                </Button>
                {test.isPending && (
                  <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
                    正在发送探测请求...
                  </span>
                )}
                {test.isSuccess && test.data.ok && (
                  <span className="text-[12px]" style={{ color: 'var(--color-success)' }}>
                    连接成功 · {test.data.latencyMs}ms
                  </span>
                )}
                {test.isSuccess && !test.data.ok && (
                  <span className="text-[12px]" style={{ color: 'var(--color-destructive)' }}>
                    连接失败：{test.data.error}
                  </span>
                )}
                {test.isError && (
                  <span className="text-[12px]" style={{ color: 'var(--color-destructive)' }}>
                    连接失败：{(test.error as Error).message}
                  </span>
                )}
              </div>
            </div>
          )}

          {panel === 'appearance' && (
            <div className="flex flex-col gap-4 max-w-xl">
              <div>
                <h3 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--color-foreground)' }}>
                  外观
                </h3>
                <p className="text-[12px] mb-4" style={{ color: 'var(--color-foreground-muted)' }}>
                  当前主题：{theme === 'dark' ? '深色玻璃' : '浅色玻璃'}
                </p>
              </div>
              <div className="flex flex-col gap-3">
                <div className="glass-card flex items-center justify-between" style={{ padding: 16 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-foreground)' }}>深色玻璃</div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
                      高对比，适合长时间使用
                    </div>
                  </div>
                  <Toggle checked={theme === 'dark'} onChange={() => toggleTheme()} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}