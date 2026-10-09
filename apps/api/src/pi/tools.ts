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
 *  navigate / screenshot / aiTask 等无 locator 字段原样透传。
 */
export function normalizeCompiledStep(step: unknown): unknown {
  if (!step || typeof step !== 'object') return step;
  const s = step as Record<string, unknown>;
  const loc = s.locator;
  if (Array.isArray(loc)) {
    // locator 是数组 → 检查是否 [[{...}]] 双层嵌套（LLM 误把每个候选当数组再包了一层）
    const flat: unknown[] = [];
    for (const item of loc) {
      if (Array.isArray(item)) {
        for (const inner of item) flat.push(inner);
      } else if (item && typeof item === 'object' && 'item' in (item as Record<string, unknown>)) {
        flat.push((item as { item: unknown }).item);
      } else {
        flat.push(item);
      }
    }
    s.locator = flat.map((item) => normalizeLocatorItem(item));
  } else if (loc && typeof loc === 'object') {
    s.locator = [normalizeLocatorItem(loc)];
  }
  return s;
}

/** 把单个 locator 候选归一化为 {strategy,value} 对象；非对象/缺字段透传。 */
function normalizeLocatorItem(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item;
  const obj = item as Record<string, unknown>;
  if ('item' in obj && obj.item && typeof obj.item === 'object') {
    return normalizeLocatorItem(obj.item);
  }
  return obj;
}
