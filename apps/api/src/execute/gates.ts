/**
 * 平台机械闸门（执行链路的确定性约束，与模型无关）。
 *
 * 抽自 aiTask.ts：探索执行核心从「每轮一个 JSON 大包」换成 pi 工具链后，这些闸门要
 * 在**工具层**再拦一次。闸门语义逐字保留、判定口径单一——两份实现一旦漂移，
 * 「AI 相链路拦住的东西探索链路会放行」是最难发现的一类回归。
 */

/**
 * 破坏性动作关键词表：命中即机械拒收（默认拒，用户在会话里显式授权才放行）。
 *
 * 判定对象 = **被点击元素的可见文本**（text + placeholder + value + selector 拼接），
 * 不是模型输出——闸必须确定性、可复现、可审计。charter 是自然语言，模型会拿它当借口
 * （2026-11-10 prod 实录：章程要求核查删除是否真落库 → 模型点了删除 → 资产真被删）。
 *
 * 刻意不收「清除 / 重置 / 取消 / 确认 / 保存 / 提交 / 导出 / 导入」：这些在探索里是正常
 * 观测动作（探索基底本就允许用测试语义内容提交表单观察校验行为）。误伤方向一律选
 * 「拦住而非执行」，会话级授权开关是兜底。
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

/** 破坏性判定：目标可见文本命中关键词返回原因，null = 放行。 */
export function destructiveActionReason(targetText: string): string | null {
  if (!targetText) return null;
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.re.test(targetText)) return p.why;
  }
  return null;
}

/** 元素 → 破坏性判定用的可见文本（text+placeholder+value+selector 拼接）。
 *  元素找不到 → 返回 fallback（通常是 selector 本身）；都没有 → 空串 = 放行。 */
export function destructiveTextOf(
  el: { text?: string; placeholder?: string; value?: string; selector?: string } | null | undefined,
  fallback = '',
): string {
  if (!el) return fallback;
  return [el.text, el.placeholder, el.value, el.selector].filter(Boolean).join(' ');
}

// —— 数据库取证（sql 动作）的结果回灌渲染 ——
// 查回的行走的是模型的下一轮输入，必须封顶：行数 5、单元格 60、单行 160、整块 700。

export const SQL_ROW_PREVIEW_MAX = 5;
const SQL_CELL_MAX = 60;
const SQL_LINE_MAX = 160;
const SQL_BLOCK_MAX = 700;

/** 单元格取值 → 单行文本（换行压成空格，免得撑破行的结构；null → NULL）。 */
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

/** 取证结果 → 回灌给模型的文本块（行数/单元格/单行/整块四级封顶）。 */
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

/** URL → origin（http/https 之外或解析失败 → null）。 */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** 探索范围闸：navigate 目标 origin 不在白名单 → 拒收原因，null = 放行。
 *  URL 解析不出 origin（理论上 parseAction 已滤成 http/https）也按越界处理。 */
export function scopeViolationReason(url: string, allowedOrigins: string[]): string | null {
  const o = originOf(url);
  if (o && allowedOrigins.includes(o)) return null;
  return `越界（目标 origin ${o ?? '不可解析'} 不在允许范围 ${allowedOrigins.join('、')} 内）`;
}

/** 记一次同目标失败；连续 ≥3 次时返回自检注入行并清零（与既有 3 连错语义一致），否则 null。
 *  customMessage：非页面类目标（sql 取证）自检文案与页面自检不同，措辞错会把模型带偏。 */
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
