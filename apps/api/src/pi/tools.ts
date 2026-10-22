/**
 * 空间助手工具共享类型与编译步骤归一化。
 * ToolExecutor 是"可单元测试的执行器 + TypeBox schema"形状（不依赖 pi-coding-agent），
 * 由 pi/space/tools/* 与 pi/space/session.ts 消费。
 */
import { Type } from '@earendil-works/pi-ai';

export interface ToolExecutor {
  name: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  /** 成功时可携带回传给模型的文本（如 inspect_page 的元素清单）；缺省回 'ok'。 */
  execute: (input: unknown) => Promise<{ ok: true; data?: string } | { ok: false; error: string }>;
  /** 透传到 defineTool 的 promptGuidelines，追加到 agent system prompt 的 Guidelines 段。 */
  promptGuidelines?: string[];
}

/**
 * 把 LLM 输出的单个 compiled 步骤归一化为回放可识别的形状。
 * 历史实测 LLM 偶尔会产出异常形状：
 *  1) locator 写成 {item:{strategy,value}} 单对象外壳 → 还原成 [{strategy,value}]
 *  2) locator 直接写成 {strategy,value} 单对象 → 包成数组
 *  3) locator 每个候选又被多包一层数组（[[{...},{...}]]）→ 剥到只剩 [{...},{...}]
 *  4) locator 写成 {item:[{...},{...}]}（item 外壳里是候选数组）→ 摊平到 [{...},{...}]
 *  5) 数字字段被写成字符串（timeoutMs:"20000"）→ 数值化
 *  navigate / screenshot / aiTask 等无 locator 字段原样透传。
 *
 * 归一化是「吸收模型的自然输出」层：形状异常不该变成一次工具参数校验失败
 * （prod228 会话 2026-10-21T07-36-23：模型连续 5 次 stage_case 被拒，每次重编一版步骤白烧 LLM 轮次）。
 */
export function normalizeCompiledStep(step: unknown): unknown {
  if (!step || typeof step !== 'object') return step;
  const s = step as Record<string, unknown>;
  const loc = s.locator;
  if (Array.isArray(loc) || (loc && typeof loc === 'object')) {
    const flat: unknown[] = [];
    flattenLocator(loc, flat);
    s.locator = flat;
  }
  for (const k of NUMERIC_STEP_KEYS) coerceNumericString(s, k);
  return s;
}

/** 摊平 locator 的各种外壳/嵌套，直到只剩候选对象数组。
 *  递归吃掉：数组（[[...]] / [{item:[...]}]）、{item:X} 外壳（X 可为对象或数组）。 */
function flattenLocator(value: unknown, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const v of value) flattenLocator(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // 已是候选形状（strategy/value）→ 原样收下；否则若裹着 {item:...} 就剥开。
    if (obj.strategy !== undefined || obj.value !== undefined) {
      out.push(obj);
      return;
    }
    if ('item' in obj) {
      flattenLocator(obj.item, out);
      return;
    }
  }
  out.push(value);
}

/** 步骤 DSL 里常见的数值字段：模型偶尔把它们写成字符串（"20000"），逐个数值化避免整步被 zod 拒。 */
const NUMERIC_STEP_KEYS = [
  'timeoutMs', 'delayMs', 'durationMs', 'longPressMs', 'windowMs', 'fromLine',
  'limit', 'port', 'status', 'group', 'latitude', 'longitude',
] as const;

/** 数字字段被模型写成字符串时数值化（非纯数字串原样保留，交给 zod 报明确错误）。 */
function coerceNumericString(obj: Record<string, unknown>, key: string): void {
  const v = obj[key];
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) obj[key] = Number(v.trim());
}
