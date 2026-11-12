/**
 * pi-sessions JSONL parsing + trajectory criterion verification + conversation compression (pure functions, no IO).
 * Record shapes (verified in practice, see the R2 plan's "key code facts"):
 *   {type:'message', message:{role:'user'|'assistant'|'toolResult'|'system', content}}
 *   assistant content blocks: {type:'text'|'thinking'|'toolCall', id?, name?, arguments?}
 *   toolResult message extra fields: toolCallId / toolName / isError (hard signal for the success criterion).
 */
export interface ParsedToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface ParsedTurn {
  role: 'user' | 'assistant' | 'toolResult';
  text: string;
  toolCalls: ParsedToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Line-level timestamp (ISO) parsed into epoch ms; missing/bad → undefined (used by the R3.6 session-duration metrics). */
  timestamp?: number;
}

export function parseSessionJsonl(content: string): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean } };
    try {
      o = JSON.parse(t);
    } catch {
      continue; // skip bad lines (partial writes etc.)
    }
    if (o.type !== 'message' || !o.message?.role) continue;
    const m = o.message;
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    const tsField = Number.isNaN(ts) ? {} : { timestamp: ts };
    const blocks = Array.isArray(m.content) ? m.content.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null) : [];
    const textOf = (b: Record<string, unknown>): string => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '');
    if (m.role === 'user') {
      const text = blocks.map(textOf).filter(Boolean).join('\n');
      if (text) turns.push({ role: 'user', text, toolCalls: [], ...tsField });
    } else if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map(textOf).filter(Boolean).join('\n');
      const toolCalls = blocks
        .filter((b) => b.type === 'toolCall')
        .map((b) => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), arguments: (b.arguments ?? {}) as Record<string, unknown> }))
        .filter((c) => c.id && c.name);
      if (text || toolCalls.length > 0) turns.push({ role: 'assistant', text, toolCalls, ...tsField });
    } else if (m.role === 'toolResult') {
      turns.push({
        role: 'toolResult',
        text: blocks.map(textOf).filter(Boolean).join('\n'),
        toolCalls: [],
        toolCallId: typeof m.toolCallId === 'string' ? m.toolCallId : undefined,
        toolName: typeof m.toolName === 'string' ? m.toolName : undefined,
        isError: typeof m.isError === 'boolean' ? m.isError : undefined,
        ...tsField,
      });
    }
  }
  return turns;
}

/** Criterion verification (final-review semantics): which of the localIds are confirmed by "verify_case actually passed and verified the staged draft".
 *  The session wrapper's ok:true does not mean verification passed — verify_case ordinary failures also return ok:true (isError=false),
 *  so the body JSON must be judged: result==='passed' and basedOn==='staged' ('db' may be a real persisted case
 *  whose name collides with the localId; different UUID namespaces, so it does not confirm this draft). isError:true is an infra error, always discarded.
 *  Ordering: each localId is judged by its last verify (fail→fix→pass is the normal path; only the final passed counts);
 *  if a stage_case with the same localId appears again after passed (draft was edited, not re-verified), that localId no longer counts as confirmed. */
export function findVerifiedLocalIds(turns: ParsedTurn[], localIds: string[]): Set<string> {
  const want = new Set(localIds);
  const passState = new Map<string, boolean>(); // localId → currently confirmed or not (last verify result; a later stage invalidates it)
  const callById = new Map<string, string>(); // toolCallId → localId (only verify_case with a caseId hit)
  for (const t of turns) {
    if (t.role === 'assistant') {
      for (const c of t.toolCalls) {
        if (c.name === 'verify_case') {
          const caseId = String(c.arguments.caseId ?? '');
          if (caseId && want.has(caseId)) callById.set(c.id, caseId);
        } else if (c.name === 'stage_case') {
          // stage_case with a missing/bad localId doesn't affect the criterion (avoids false kills)
          const lid = typeof c.arguments.localId === 'string' ? c.arguments.localId : '';
          if (lid && want.has(lid)) passState.set(lid, false); // draft was edited — must re-verify to count
        }
      }
    } else if (t.role === 'toolResult' && t.toolName === 'verify_case' && t.isError === false && t.toolCallId) {
      const localId = callById.get(t.toolCallId);
      if (localId) passState.set(localId, verifyPassed(t.text));
    }
  }
  const verified = new Set<string>();
  for (const [lid, ok] of passState) if (ok) verified.add(lid);
  return verified;
}

/** verify_case toolResult body check: JSON with result==='passed' and basedOn==='staged'. fail-closed. */
function verifyPassed(text: string): boolean {
  try {
    const p = JSON.parse(text) as { result?: unknown; basedOn?: unknown };
    return p.result === 'passed' && p.basedOn === 'staged';
  } catch {
    return false;
  }
}

/** Conversation compression: user full text / assistant decision text (thinking dropped) / toolCall summary lines / toolResult truncated head.
 *  Tail is truncated wholesale when over budget (distillation weights recent context); the first user message is always kept at the head —
 *  tail-truncating a 22min session would cut the original request entirely, leaving retrieval unanchored. An over-long first message is cut to 2000 chars; total stays ≤ maxChars. */
export function compressConversation(turns: ParsedTurn[], maxChars = 24_000): string {
  const lines: string[] = [];
  for (const t of turns) {
    if (t.role === 'user') {
      lines.push(`[用户] ${t.text}`);
    } else if (t.role === 'assistant') {
      if (t.text) lines.push(`[助手] ${t.text}`);
      for (const c of t.toolCalls) {
        const args = JSON.stringify(c.arguments);
        lines.push(`[助手→工具] ${c.name}(${args.length > 300 ? `${args.slice(0, 300)}…` : args})`);
      }
    } else {
      const head = t.text.length > 400 ? `${t.text.slice(0, 400)}…` : t.text;
      lines.push(`[工具结果${t.isError ? '·失败' : ''}] ${head}`);
    }
  }
  const firstUserIdx = lines.findIndex((l) => l.startsWith('[用户] '));
  let firstUser = '';
  if (firstUserIdx >= 0) {
    firstUser = lines[firstUserIdx]!.slice(0, Math.min(2_000, Math.max(0, maxChars - 1)));
    lines.splice(firstUserIdx, 1);
  }
  const rest = lines.join('\n');
  const budget = maxChars - firstUser.length - (firstUser ? 1 : 0);
  const restKept = budget <= 0 ? '' : rest.length > budget ? rest.slice(rest.length - budget) : rest;
  return firstUser ? `${firstUser}\n${restKept}` : restKept;
}
