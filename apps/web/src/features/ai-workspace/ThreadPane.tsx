import { useEffect, useMemo } from 'react';
import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react';
import { usePiRuntime, usePiRuntimeExtras, createPiHttpClient } from '@assistant-ui/react-pi';
import { useQuery } from '@tanstack/react-query';

interface Props {
  requirementId: string;
  threadId: string;
}

interface PiModelInfo {
  id: string;
}

/**
 * Pi agent thread pane. The runtime connects to `/api/pi/*` and `ThreadPrimitive`
 * renders the messages. We render only the structural primitives — the Pi
 * runtime wires composer + thread state from `usePiRuntime`.
 */
export default function ThreadPane({ requirementId, threadId }: Props) {
  const { data: models = [] } = useQuery({
    queryKey: ['pi-models'],
    queryFn: () =>
      fetch('/api/pi/models').then(
        (r) => r.json() as Promise<PiModelInfo[]>,
      ),
    refetchInterval: 30_000,
  });

  const client = useMemo(() => createPiHttpClient(), []);
  const runtime = usePiRuntime({ client, initialThreadId: threadId });
  // acknowledge extras as part of the runtime surface
  usePiRuntimeExtras();

  useEffect(() => {
    // assistant-ui manages thread lifecycle internally; nothing to wire here.
    void requirementId;
    void models;
  }, [requirementId, models]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex flex-col h-full">
        <ThreadPrimitive.Root className="flex flex-col h-full">
          <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto p-4">
            <ThreadPrimitive.Messages components={{ Message: DefaultMessage }} />
          </ThreadPrimitive.Viewport>
          <ThreadPrimitive.ViewportFooter className="border-t p-3" style={{ borderColor: 'var(--color-border)' }}>
            <ThreadPrimitive.Suggestions components={{ Suggestion: DefaultSuggestion }} />
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}

function DefaultMessage() {
  return <div className="text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>…</div>;
}

function DefaultSuggestion() {
  return null;
}