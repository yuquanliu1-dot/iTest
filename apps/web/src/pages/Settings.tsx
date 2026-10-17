import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../i18n';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useThemeStore } from '../stores/theme';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Toggle from '../components/ui/Toggle';
import {
  PageShell,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
} from '../components/layout/PageShell';

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

/** 与 apps/api/src/execute/aiFallback.ts 的 AI_FALLBACK_KEYS 互为镜像。 */
const AI_FALLBACK_COMPILE_MISSING_KEY = 'ai_fallback_compile_missing';
const AI_FALLBACK_LOCATOR_FAILED_KEY = 'ai_fallback_locator_failed';

type Panel = 'llm' | 'appearance' | 'replay';

const PANELS: Array<{ key: Panel; labelKey: string; icon: 'beaker' | 'sparkles' | 'layers' }> = [
  { key: 'llm', labelKey: 'settings:llmProvider', icon: 'beaker' },
  { key: 'appearance', labelKey: 'settings:panelAppearance', icon: 'sparkles' },
  { key: 'replay', labelKey: 'settings:panelReplay', icon: 'layers' },
];

export default function Settings() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const [panel, setPanel] = useState<Panel>('llm');

  // LLM form
  const [provider, setProvider] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  // 回放 AI 降级开关
  const [compileMissingFallback, setCompileMissingFallback] = useState(false);
  const [locatorFailedFallback, setLocatorFailedFallback] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: api.settings.list });

  useEffect(() => {
    if (!data) return;
    setProvider((data.llm_provider as string) ?? 'openai');
    setApiKey((data.llm_api_key as string) ?? '');
    setModel((data.llm_model as string) ?? '');
    setBaseUrl((data.llm_base_url as string) ?? '');
    setCompileMissingFallback(data[AI_FALLBACK_COMPILE_MISSING_KEY] === true);
    setLocatorFailedFallback(data[AI_FALLBACK_LOCATOR_FAILED_KEY] === true);
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      await api.settings.put('llm_provider', provider);
      await api.settings.put('llm_api_key', apiKey);
      await api.settings.put('llm_model', model);
      await api.settings.put('llm_base_url', baseUrl);
    },
    onSuccess: () => toast(t('settings:saved'), 'success'),
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const test = useMutation({
    mutationFn: () => api.settings.testConnection({ provider, apiKey, model, baseUrl }),
  });

  // 回放降级开关即时保存
  const saveFallback = useMutation({
    mutationFn: ({ key, value }: { key: string; value: boolean }) => api.settings.put(key, value),
    onError: (e: Error) => toast(localizeApiError(e as { code?: string; message?: string }) || t('settings:saveFailed'), 'error'),
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>{t('common:loading')}</span>
      </div>
    );
  }

  return (
    <PageShell contained className="gap-4">
      <PageShellHeader>
        <PageShellTitle>{t('settings:title')}</PageShellTitle>
        <PageShellDescription>{t('settings:description')}</PageShellDescription>
      </PageShellHeader>

      {/* Two-panel card（iDO 设置页规范） */}
      <div className="flex gap-3 flex-1 min-h-0">
        <div
          className="bg-card border shrink-0 flex flex-col"
          style={{ width: 240 }}
        >
          <div className="hairline-bottom" style={{ padding: '12px 16px' }}>
            <h2 className="text-[14px] font-semibold m-0" style={{ color: 'var(--foreground)' }}>
              {t('settings:panelTitle')}
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
                      borderRadius: 'var(--radius-sm)',
                      background: active ? 'var(--primary-soft)' : undefined,
                      color: active ? 'var(--primary)' : 'var(--muted-foreground)',
                      fontWeight: active ? 500 : 400,
                      fontSize: 13,
                    }}
                  >
                    <Icon name={p.icon} size={14} />
                    <span className="flex-1">{t(p.labelKey)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="bg-card border flex-1 min-w-0 overflow-y-auto" style={{ padding: 20 }}>
          {panel === 'llm' && (
            <div className="flex flex-col gap-4 max-w-xl">
              <div>
                <h3 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--foreground)' }}>
                  LLM Provider
                </h3>
                <p className="text-[12px] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                  {t('settings:llmIntro')}
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
                  label={t('settings:baseUrlLabel')}
                  placeholder={t('settings:baseUrlPlaceholder')}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <p className="text-[11px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
                  {t('settings:baseUrlHelp')}
                </p>
              </div>
              <div>
                <Input
                  label="Model"
                  placeholder={t('settings:modelPlaceholder')}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                {DEFAULT_MODELS[provider] && (
                  <p className="text-[11px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
                    {t('settings:defaultModel', { model: DEFAULT_MODELS[provider] })}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <Button disabled={save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? t('settings:saving') : t('common:save')}
                </Button>
                <Button variant="ghost" disabled={test.isPending} onClick={() => test.mutate()}>
                  {test.isPending ? t('settings:testing') : t('settings:testConnection')}
                </Button>
                {test.isPending && (
                  <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                    {t('settings:testingProbe')}
                  </span>
                )}
                {test.isSuccess && test.data.ok && (
                  <span className="text-[12px]" style={{ color: 'var(--success)' }}>
                    {t('settings:testOk', { latencyMs: test.data.latencyMs })}
                  </span>
                )}
                {test.isSuccess && !test.data.ok && (
                  <span className="text-[12px]" style={{ color: 'var(--destructive)' }}>
                    {t('settings:testFail', { error: test.data.error })}
                  </span>
                )}
                {test.isError && (
                  <span className="text-[12px]" style={{ color: 'var(--destructive)' }}>
                    {t('settings:testFail', { error: localizeApiError(test.error as { code?: string; message?: string }) })}
                  </span>
                )}
              </div>
            </div>
          )}

          {panel === 'appearance' && (
            <div className="flex flex-col gap-4 max-w-xl">
              <div>
                <h3 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--foreground)' }}>
                  {t('settings:appearance')}
                </h3>
                <p className="text-[12px] mb-4" style={{ color: 'var(--muted-foreground)' }}>
                  {t('settings:currentTheme', { theme: theme === 'dark' ? t('settings:darkGlass') : t('settings:lightGlass') })}
                </p>
              </div>
              <div className="flex flex-col gap-3">
                <div className="bg-card border flex items-center justify-between" style={{ padding: 16 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--foreground)' }}>{t('settings:darkGlass')}</div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                      {t('settings:darkGlassDesc')}
                    </div>
                  </div>
                  <Toggle checked={theme === 'dark'} onChange={() => toggleTheme()} />
                </div>
              </div>
            </div>
          )}

          {panel === 'replay' && (
            <div className="flex flex-col gap-4 max-w-xl">
              <div>
                <h3 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--foreground)' }}>
                  {t('settings:replayTitle')}
                </h3>
                <p className="text-[12px] mb-4" style={{ color: 'var(--muted-foreground)' }}>
                  {t('settings:replayIntro')}
                </p>
              </div>
              <div className="flex flex-col gap-3">
                <div className="bg-card border flex items-center justify-between" style={{ padding: 16 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--foreground)' }}>{t('settings:compileFallbackTitle')}</div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                      {t('settings:compileFallbackDesc')}
                    </div>
                  </div>
                  <Toggle
                    checked={compileMissingFallback}
                    onChange={(v) => {
                      setCompileMissingFallback(v);
                      saveFallback.mutate({ key: AI_FALLBACK_COMPILE_MISSING_KEY, value: v });
                    }}
                  />
                </div>
                <div className="bg-card border flex items-center justify-between" style={{ padding: 16 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--foreground)' }}>{t('settings:locatorFallbackTitle')}</div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                      {t('settings:locatorFallbackDesc')}
                    </div>
                  </div>
                  <Toggle
                    checked={locatorFailedFallback}
                    onChange={(v) => {
                      setLocatorFailedFallback(v);
                      saveFallback.mutate({ key: AI_FALLBACK_LOCATOR_FAILED_KEY, value: v });
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}