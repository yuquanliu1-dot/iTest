/**
 * pi-sessions JSONL 解析 + 轨迹判据核实 + 对话流压缩（纯函数，无 IO）。
 * 记录形状（实测，见 R2 计划「关键代码事实」）：
 *   {type:'message', message:{role:'user'|'assistant'|'toolResult'|'system', content}}
 *   assistant content 块：{type:'text'|'thinking'|'toolCall', id?, name?, arguments?}
 *   toolResult message 额外字段：toolCallId / toolName / isError（成功判据的硬信号）。
 */
export interface ParsedToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface ParsedTurn {
  role: 'user' | 'assistant' | 'toolResult';
  text: string;
  toolCalls: ParsedToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export function parseSessionJsonl(content: string): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean } };
    try {
      o = JSON.parse(t);
    } catch {
      continue; // 坏行跳过（半行写入等）
    }
    if (o.type !== 'message' || !o.message?.role) continue;
    const m = o.message;
    const blocks = Array.isArray(m.content) ? m.content.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null) : [];
    const textOf = (b: Record<string, unknown>): string => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '');
    if (m.role === 'user') {
      const text = blocks.map(textOf).filter(Boolean).join('\n');
      if (text) turns.push({ role: 'user', text, toolCalls: [] });
    } else if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map(textOf).filter(Boolean).join('\n');
      const toolCalls = blocks
        .filter((b) => b.type === 'toolCall')
        .map((b) => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), arguments: (b.arguments ?? {}) as Record<string, unknown> }))
        .filter((c) => c.id && c.name);
      if (text || toolCalls.length > 0) turns.push({ role: 'assistant', text, toolCalls });
    } else if (m.role === 'toolResult') {
      turns.push({
        role: 'toolResult',
        text: blocks.map(textOf).filter(Boolean).join('\n'),
        toolCalls: [],
        toolCallId: typeof m.toolCallId === 'string' ? m.toolCallId : undefined,
        toolName: typeof m.toolName === 'string' ? m.toolName : undefined,
        isError: m.isError === true,
      });
    }
  }
  return turns;
}

/** 判据核实：localId 集合中，哪些存在「verify_case(caseId=localId) 的 toolResult isError=false」。
 *  多次 verify 末次成功即成功（失败→修正→通过是正常路径）。 */
export function findVerifiedLocalIds(turns: ParsedTurn[], localIds: string[]): Set<string> {
  const want = new Set(localIds);
  const verified = new Set<string>();
  const callById = new Map<string, string>(); // toolCallId → localId（仅 verify_case 且 caseId 命中）
  for (const t of turns) {
    if (t.role === 'assistant') {
      for (const c of t.toolCalls) {
        const caseId = c.name === 'verify_case' ? String(c.arguments.caseId ?? '') : '';
        if (caseId && want.has(caseId)) callById.set(c.id, caseId);
      }
    } else if (t.role === 'toolResult' && t.toolName === 'verify_case' && t.isError === false && t.toolCallId) {
      const localId = callById.get(t.toolCallId);
      if (localId) verified.add(localId);
    }
  }
  return verified;
}

/** 对话流压缩：user 全文 / assistant 决策文本（弃 thinking）/ toolCall 摘要行 / toolResult 截头。
 *  尾部超预算整体截断（蒸馏重最新上下文，头部被截不影响判据——判据已由 findVerifiedLocalIds 完成）。 */
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
  const joined = lines.join('\n');
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}
