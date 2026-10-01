import { useMemo } from 'react';
import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react';
import { usePiRuntime, createPiHttpClient } from '@assistant-ui/react-pi';

interface Props {
  requirementId: string;
  threadId: string;
}

/**
 * Pi agent thread pane. The runtime connects to `/api/pi/*` and `ThreadPrimitive`
 * renders the messages. We render only the structural primitives — the Pi
 * runtime wires composer + thread state from `usePiRuntime`.
 */
export default function ThreadPane({ threadId }: Props) {
  const client = useMemo(() => createPiHttpClient(), []);
  const runtime = usePiRuntime({ client, initialThreadId: threadId });

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