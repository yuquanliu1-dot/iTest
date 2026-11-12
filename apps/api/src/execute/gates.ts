/**
 * Platform mechanical gates (deterministic constraints on the execution chain, model-independent).
 *
 * Extracted from aiTask.ts: after the exploration execution core switched from「每轮一个 JSON 大包」to the pi tool chain,
 * these gates must intercept again at the **tool layer**. Gate semantics preserved verbatim, a single judging definition — once the two implementations drift,
 * 「AI 相链路拦住的东西探索链路会放行」is the hardest class of regression to spot.
 */

/**
 * Destructive-action keyword table: a hit means mechanical rejection (default deny; passes only with the user's explicit in-session authorization).
 *
 * Judging target = **the clicked element's visible text** (text + placeholder + value + selector concatenated),
 * not the model's output — the gate must be deterministic, reproducible, auditable. The charter is natural language, and the model will use it as an excuse
 * (2026-11-10 prod record: the charter asked to verify whether deletes really land in the DB → the model clicked delete → the asset was really deleted).
 *
 * Deliberately NOT covering「清除 / 重置 / 取消 / 确认 / 保存 / 提交 / 导出 / 导入」: these are normal observation actions in exploration
 * (the exploration base already allows submitting forms with test-semantic content to observe validation behavior). For false positives always choose
 * 「拦住而非执行」 (block rather than execute); the session-level authorization switch is the fallback.
 */
export const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /删除|销毁|格式化/, why: '删除/销毁' },
  { re: /清空数据|清空全部|一键清空|批量清空/, why: '清空数据' },
  { re: /移除/, why: '移除' },
  { re: /注销|销户|停用|禁用|下线|封禁|解绑|解约|退订|终止服务/, why: '停用/注销/解绑' },
  { re: /支付|付款|结算|扣款|转账|提现|下单|购买|充值/, why: '支付/出账' },
  { re: /发送|发布|群发|外发|寄出|提交订单/, why: '外发' },
  { re: /审批|核准|驳回|授权|放行|授予/, why: '审批/授权' },
  { re: /恢复出厂|重置密码|初始化数据/, why: '重置/初始化数据' },
  { re: /delete|remove|destroy|purge|wipe|erase|deprovision/i, why: 'delete/remove' },
  { re: /deactivate|disable|terminate|revoke|unbind|unsubscribe|offboard/i, why: 'deactivate/revoke' },
  { re: /pay|checkout|settle|purchase|buy|place order|withdraw|top up/i, why: 'payment' },
  { re: /send|publish|dispatch|broadcast|submit order/i, why: 'send/publish' },
  { re: /approve|reject|authorize|grant/i, why: 'approve/authorize' },
  { re: /factory reset|reset password|wipe data|clear all/i, why: 'factory reset' },
];

/** Destructive verdict: returns the reason when the target's visible text hits a keyword; null = pass through. */
export function destructiveActionReason(targetText: string): string | null {
  if (!targetText) return null;
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.re.test(targetText)) return p.why;
  }
  return null;
}

/** Brittle-selector hard gate (borrowed from srbarrios agentic-test-explorer engine.py _BRITTLE_SELECTOR_PATTERNS):
 *  XPath / :nth-child / :nth-of-type / bare-tag position chains drift under tiny layout changes; reject up front at runtime
 *  (the enforcement of the prompt ban; :has-text is additionally substring-matching and ambiguity-prone). Applies only to the model action channel —
 *  platform-produced selectors (SYNTH_SELECTOR_SRC, the solidify replay/report chain) don't pass through here and are unaffected.
 *  Extracted from aiTask.ts: the pi tool chain's model selector channel (screenshot/click/fill) uses this same definition. */
const BRITTLE_SELECTOR_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /^\//, why: 'XPath 绝对路径' },
  { re: /\/\//, why: 'XPath（//）' },
  { re: /:nth-child\s*\(/i, why: ':nth-child() 位置选择' },
  { re: /:nth-of-type\s*\(/i, why: ':nth-of-type() 位置选择' },
  { re: />\s*(?:div|span|li|ul|ol|td|tr|th)\s*[\s>+~[{,]/i, why: '裸标签位置链' },
  { re: /:has-text\s*\(/i, why: ':has-text()' },
];

/** Brittle-selector check: returns the reason on hit; null = pass through. */
export function brittleSelectorReason(selector: string): string | null {
  for (const p of BRITTLE_SELECTOR_PATTERNS) {
    if (p.re.test(selector)) return p.why;
  }
  return null;
}

/** Element → visible text for the destructive verdict (text+placeholder+value+selector concatenated).
 *  Element not found → returns the fallback (usually the selector itself); none present → empty string = pass through. */
export function destructiveTextOf(
  el: { text?: string; placeholder?: string; value?: string; selector?: string } | null | undefined,
  fallback = '',
): string {
  if (!el) return fallback;
  return [el.text, el.placeholder, el.value, el.selector].filter(Boolean).join(' ');
}

// —— DB evidence (sql action) result feed-back rendering ——
// The queried rows go into the model's next-turn input and must be capped: rows 5, cell 60, line 160, whole block 700.

export const SQL_ROW_PREVIEW_MAX = 5;
const SQL_CELL_MAX = 60;
const SQL_LINE_MAX = 160;
const SQL_BLOCK_MAX = 700;

/** Cell value → single-line text (newlines collapsed to spaces so the row's structure isn't broken; null → NULL). */
function renderSqlCell(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) s = 'NULL';
  else if (typeof v === 'string') s = v;
  else if (typeof v === 'object') {
    try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); }
  } else s = String(v);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > SQL_CELL_MAX ? `${s.slice(0, SQL_CELL_MAX)}…` : s;
}

/** Evidence result → the text block fed back to the model (four-level caps: rows/cell/line/block). */
export function renderSqlProbeRows(
  rows: Array<Record<string, unknown>>,
  rowCount: number,
  truncated: boolean,
): string {
  if (!Array.isArray(rows) || rows.length === 0) return '（无结果行）';
  const lines: string[] = [];
  for (const row of rows.slice(0, SQL_ROW_PREVIEW_MAX)) {
    const cells = Object.entries(row).map(([k, v]) => `${k}=${renderSqlCell(v)}`);
    let line = `- ${cells.join(' | ')}`;
    if (line.length > SQL_LINE_MAX) line = `${line.slice(0, SQL_LINE_MAX)}…`;
    lines.push(line);
  }
  let block = lines.join('\n');
  if (block.length > SQL_BLOCK_MAX) block = `${block.slice(0, SQL_BLOCK_MAX)}…（已截断）`;
  const notes: string[] = [];
  if (rows.length > SQL_ROW_PREVIEW_MAX) notes.push(`共 ${rowCount} 行，仅显示前 ${SQL_ROW_PREVIEW_MAX} 行`);
  if (truncated) notes.push('结果已按 limit 截断');
  return notes.length > 0 ? `${block}\n（${notes.join('；')}）` : block;
}

/** URL → origin (non-http/https or parse failure → null). */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Exploration scope gate: navigate target origin not in the whitelist → rejection reason; null = pass through.
 *  A URL with no parseable origin (theoretically already filtered to http/https by parseAction) is also treated as out of scope. */
export function scopeViolationReason(url: string, allowedOrigins: string[]): string | null {
  const o = originOf(url);
  if (o && allowedOrigins.includes(o)) return null;
  return `越界（目标 origin ${o ?? '不可解析'} 不在允许范围 ${allowedOrigins.join('、')} 内）`;
}

/** Records one same-target failure; on ≥3 consecutive failures returns the self-check injection line and resets (consistent with the existing 3-streak semantics), otherwise null.
 *  customMessage: non-page targets (sql evidence) use a self-check text different from the page one — wrong wording would steer the model astray. */
export function noteStreakFailure(errStreak: Map<string, number>, key: string | null, customMessage?: string): string | null {
  if (key == null) return null;
  const streak = (errStreak.get(key) ?? 0) + 1;
  errStreak.set(key, streak);
  if (streak < 3) return null;
  errStreak.set(key, 0);
  return customMessage
    ? customMessage
    : `[system] 目标 ${key} 已连续 3 次失败：停止对它重试。先用截图核对当前页面是否在指令期望的界面（弹窗/跳转/加载中都会让目标消失），页面不对先处理页面；确认页面正确而目标确实不存在，则输出 fail 如实说明。`;
}
