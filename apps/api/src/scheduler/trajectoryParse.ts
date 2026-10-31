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
        isError: typeof m.isError === 'boolean' ? m.isError : undefined,
      });
    }
  }
  return turns;
}

/** 判据核实（终审口径）：localId 集合中，哪些被「verify_case 实测通过且验的就是暂存草稿」证实。
 *  session 包装层 ok:true 不代表验证通过——verify_case 常规失败也返回 ok:true（isError=false），
 *  必须判正文 JSON：result==='passed' 且 basedOn==='staged'（'db' 可能是与 localId 撞名的
 *  已落库真用例，UUID 命名空间不同，不算证实本草稿）。isError:true 是 infra 错误，必弃。
 *  时序：每个 localId 以最后一次 verify 为准（失败→修正→通过是正常路径，末次 passed 才算）；
 *  passed 之后又出现同 localId 的 stage_case（草稿被改过、未复验）则该 localId 不算已证实。 */
export function findVerifiedLocalIds(turns: ParsedTurn[], localIds: string[]): Set<string> {
  const want = new Set(localIds);
  const passState = new Map<string, boolean>(); // localId → 当前是否已证实（末次 verify 结果；后续 stage 置失效）
  const callById = new Map<string, string>(); // toolCallId → localId（仅 verify_case 且 caseId 命中）
  for (const t of turns) {
    if (t.role === 'assistant') {
      for (const c of t.toolCalls) {
        if (c.name === 'verify_case') {
          const caseId = String(c.arguments.caseId ?? '');
          if (caseId && want.has(caseId)) callById.set(c.id, caseId);
        } else if (c.name === 'stage_case') {
          // 缺/坏 localId 的 stage_case 不影响判据（避免误杀）
          const lid = typeof c.arguments.localId === 'string' ? c.arguments.localId : '';
          if (lid && want.has(lid)) passState.set(lid, false); // 草稿被改过——须重新 verify 才算
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

/** verify_case toolResult 正文判定：JSON 且 result==='passed' 且 basedOn==='staged'。fail-closed。 */
function verifyPassed(text: string): boolean {
  try {
    const p = JSON.parse(text) as { result?: unknown; basedOn?: unknown };
    return p.result === 'passed' && p.basedOn === 'staged';
  } catch {
    return false;
  }
}

/** 对话流压缩：user 全文 / assistant 决策文本（弃 thinking）/ toolCall 摘要行 / toolResult 截头。
 *  尾部超预算整体截断（蒸馏重最新上下文）；首条用户消息保底保留在头部——22min 长会话尾部
 *  截断会把首条需求整条截掉，检索面失锚。首条本身超长截到 2000 字符，总长仍 ≤ maxChars。 */
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
