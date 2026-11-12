import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import Button from '../components/ui/Button';
import {
  PageShell,
  PageShellContent,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
} from '../components/layout/PageShell';
import SpaceWorkspace from '../features/space-assistant/SpaceWorkspace';

interface AssistantInitialMessageState {
  initialMessage?: string;
}

/**
 * Version-space AI assistant (the AI-First main entry): landing in a version space means landing in a conversation.
 * Thread management (list/switch/rename/delete) is fully delegated to the ThreadList primitives inside SpaceWorkspace;
 * the page layer keeps only banners: create/send failure (initError, blocking guidance) and per-thread lastError warnings.
 *
 * First-message support: when jumping in from case management's "AI create case"/other entries carrying location.state.initialMessage,
 * the first prompt is auto-injected onto the initial draft (the injector lives inside SpaceWorkspace; aui must be used
 * inside AssistantRuntimeProvider, the page holds no runtime).
 */
export default function AssistantPage() {
  const { t } = useTranslation();
  const { versionId } = useParams<{ projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [initError, setInitError] = useState<string | null>(null);
  // Non-blocking warnings (repo unavailable etc., surfaced by the backend via snapshot lastError at thread creation): recorded by thread id, conversation still usable
  const [warnings, setWarnings] = useState<Record<string, string>>({});
  const [activeThreadId, setActiveThreadId] = useState('');
  // First prompt carried by the previous hop's location.state: captured into component state,
  // because location.state is cleared by an effect after SpaceWorkspace mounts.
  const [initialMessage] = useState(((location.state ?? {}) as AssistantInitialMessageState).initialMessage);

  // Clear location.state on mount, so re-entering the same path doesn't bring back a stale initialMessage
  useEffect(() => {
    if (!initialMessage) return;
    navigate(location.pathname, { replace: true });
    // Clear stale state only on mount, not dependent on navigate/location (otherwise every navigation would trigger)
  }, []);

  const llmMissing = initError?.includes('LLM 未配置') ?? false;
  const warning = activeThreadId ? warnings[activeThreadId] : undefined;

  return (
    <PageShell contained>
      <PageShellHeader>
        <PageShellTitle>{t('common:navAssistant')}</PageShellTitle>
        <PageShellDescription>{t('assistant:subtitle')}</PageShellDescription>
      </PageShellHeader>

      <PageShellContent className="min-h-0">
        {initError && (
          <div
            className="rounded-[var(--radius-sm)] px-4 py-3 text-[13px] shrink-0"
            style={{ border: '1px solid var(--destructive)', color: 'var(--destructive)' }}
          >
            {initError}
            <div className="flex gap-2 mt-2">
              {llmMissing && <Button size="sm" onClick={() => navigate('/settings')}>{t('assistant:goConfigureModel')}</Button>}
              {/* Blocking errors only affect that one send: dismissing the banner allows re-sending, no full-page retry needed */}
              <Button size="sm" variant="ghost" onClick={() => setInitError(null)}>{t('common:close')}</Button>
            </div>
          </div>
        )}
        {warning && (
          <div
            className="rounded-[var(--radius-sm)] px-4 py-2.5 text-[12px] shrink-0"
            style={{ border: '1px solid var(--warning-soft-border)', color: 'var(--warning)', background: 'var(--warning-soft)' }}
          >
            {warning}
          </div>
        )}
        <SpaceWorkspace
          key={versionId}
          versionId={versionId!}
          initialMessage={initialMessage}
          onError={(e) => setInitError(e instanceof Error ? e.message : String(e))}
          onWarning={(threadId, msg) => setWarnings((m) => ({ ...m, [threadId]: msg }))}
          onActiveThreadIdChange={setActiveThreadId}
        />
      </PageShellContent>
    </PageShell>
  );
}
