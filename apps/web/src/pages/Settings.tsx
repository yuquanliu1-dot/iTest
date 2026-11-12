import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../i18n';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useThemeStore } from '../stores/theme';
import Icon from '../components/Icon';
import Toggle from '../components/ui/Toggle';
import AssistantPanel, { type AssistantSectionKey } from '../components/settings/AssistantPanel';
import LlmChannelsPanel from '../components/settings/LlmChannelsPanel';
import {
  PageShell,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
} from '../components/layout/PageShell';

// Mirrors AI_FALLBACK_KEYS in apps/api/src/execute/aiFallback.ts.
// (The compile-missing switch was removed: AI on-the-spot execution of NL visual steps is official execution semantics and can no longer be turned off.)
const AI_FALLBACK_LOCATOR_FAILED_KEY = 'ai_fallback_locator_failed';

type Panel = 'general' | 'llm' | 'assistant-tools' | 'assistant-memory' | 'assistant-prompt' | 'assistant-feedback';

/** Left nav grouped by domain: general (appearance/replay/model access) + AI assistant (split into four subpages by content). */
const NAV_GROUPS: Array<{
  labelKey: string;
  items: Array<{ key: Panel; labelKey: string; icon: 'sun' | 'beaker' | 'plug' | 'database' | 'terminal' | 'message' }>;
}> = [
  {
    labelKey: 'settings:panelGeneral',
    items: [
      { key: 'general', labelKey: 'settings:panelAppearanceReplay', icon: 'sun' },
      { key: 'llm', labelKey: 'settings:llmProvider', icon: 'beaker' },
    ],
  },
  {
    labelKey: 'settings:panelAssistant',
    items: [
      { key: 'assistant-tools', labelKey: 'settings:panelAssistantTools', icon: 'plug' },
      { key: 'assistant-memory', labelKey: 'settings:panelAssistantMemory', icon: 'database' },
      { key: 'assistant-prompt', labelKey: 'settings:panelAssistantPrompt', icon: 'terminal' },
      { key: 'assistant-feedback', labelKey: 'settings:feedbackTitle', icon: 'message' },
    ],
  },
];

/** AI assistant subpage → page header (title+intro) and the Sections to render. Single-card pages (user feedback) carry their own title/intro on the card, so the header is omitted to avoid duplication. */
const ASSISTANT_PAGES: Record<
  Exclude<Panel, 'general' | 'llm'>,
  { titleKey: string; introKey: string; sections: AssistantSectionKey[]; hideHeader?: boolean }
> = {
  'assistant-tools': { titleKey: 'settings:panelAssistantTools', introKey: 'settings:assistantIntro', sections: ['mcp', 'skills'] },
  'assistant-memory': { titleKey: 'settings:panelAssistantMemory', introKey: 'settings:assistantMemoryIntro', sections: ['memories', 'trajectories'] },
  'assistant-prompt': { titleKey: 'settings:panelAssistantPrompt', introKey: 'settings:assistantPromptIntro', sections: ['prompts', 'solidify'] },
  'assistant-feedback': { titleKey: 'settings:feedbackTitle', introKey: 'settings:feedbackIntro', sections: ['feedback'], hideHeader: true },
};

export default function Settings() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const [panel, setPanel] = useState<Panel>('general');

  // Replay AI redo switch (mechanical failure fallback)
  const [locatorFailedFallback, setLocatorFailedFallback] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: api.settings.list });

  useEffect(() => {
    if (!data) return;
    setLocatorFailedFallback(data[AI_FALLBACK_LOCATOR_FAILED_KEY] === true);
  }, [data]);

  // Replay fallback switch saves immediately
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

      {/* Two-panel card (iDO settings page convention) */}
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
            {NAV_GROUPS.map((g) => (
              <div key={g.labelKey} className="mb-1">
                <div
                  className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide"
                  style={{ color: 'var(--muted-foreground)', opacity: 0.75 }}
                >
                  {t(g.labelKey)}
                </div>
                {g.items.map((p) => {
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
            ))}
          </div>
        </div>

        <div className="bg-card border flex-1 min-w-0 overflow-y-auto" style={{ padding: 20 }}>
          {panel === 'llm' && <LlmChannelsPanel />}

          {panel === 'general' && (
            <div className="flex flex-col gap-8 max-w-xl">
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--foreground)' }}>
                    {t('settings:appearance')}
                  </h3>
                  <p className="text-[12px] mb-2" style={{ color: 'var(--muted-foreground)' }}>
                    {t('settings:currentTheme', { theme: theme === 'dark' ? t('settings:darkGlass') : t('settings:lightGlass') })}
                  </p>
                </div>
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
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--foreground)' }}>
                    {t('settings:replayTitle')}
                  </h3>
                  <p className="text-[12px] mb-2" style={{ color: 'var(--muted-foreground)' }}>
                    {t('settings:replayIntro')}
                  </p>
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

          {panel !== 'general' && panel !== 'llm' && (
            <div className="flex flex-col gap-4 max-w-2xl">
              {!ASSISTANT_PAGES[panel].hideHeader && (
                <div>
                  <h3 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--foreground)' }}>
                    {t(ASSISTANT_PAGES[panel].titleKey)}
                  </h3>
                  <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                    {t(ASSISTANT_PAGES[panel].introKey)}
                  </p>
                </div>
              )}
              <AssistantPanel sections={ASSISTANT_PAGES[panel].sections} />
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}