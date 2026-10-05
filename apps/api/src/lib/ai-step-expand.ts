/**
 * 把"已编译"的 aiStep 就地展开为多条具体 DSL 步骤。
 *
 * 背景：AI 暂存阶段 LLM 已在 `compiled` 字段输出 DSL 数组；保存到 test_steps 时，
 * 原实现是把整段 `{kind:'aiStep', instruction, compiled}` 整体入库，回放时由 cdp.ts
 * 走 aiStep 分支循环 dispatch 子步骤。这样有几个副作用：
 *  1) UI 看到的 step.kind='aiStep'，无法直接编辑定位器 / value / 等；
 *  2) 回放多一层 aiStep 递归（虽然功能等价）；
 *  3) 触发"AI 双字段"功能的核心目的被弱化（用户期望"自然语言 + 可执行指令"并排，
 *     而不是被包成一个 aiStep 壳）。
 *
 * 本文件把"已编译"的 aiStep 展开成等价的 navigate/click/fill/...，让前端能直接编辑、
 * 让回放走更短路径。"未尝试"(无 compiled 字段) / "已放弃"(compiled:null) 的 aiStep
 * 原样保留，行为与之前完全一致——回放时仍按 aiStep 兜底（fail-fast / 实时编译）。
 */
import { StepAction } from '@itest/shared';

interface StepRow {
  source: 'agent';
  name: string;
  action: object;
  assertion: object | null;
  sensitive: boolean;
  [k: string]: unknown;
}

/** 一个 Prepared 用例：stepRows 是按顺序的步骤行。 */
interface PreparedCase {
  stepRows: StepRow[];
}

export function expandCompiledAiStepsInPlace(prepared: PreparedCase[]): void {
  for (const p of prepared) {
    if (p.stepRows.length === 0) continue;
    const out: StepRow[] = [];
    for (const row of p.stepRows) {
      const a = row.action as { kind?: string; instruction?: string; compiled?: unknown };
      if (a?.kind !== 'aiStep' || !Array.isArray(a.compiled)) {
        out.push(row);
        continue;
      }
      // 已编译 → 展开：每条子步骤成为一条独立 step row。
      //   - 名字取子步骤 kind（如 "navigate" / "click" / "fill"）；保留原始 aiStep.name 作 fallback
      //     （用于回放报告里能定位"这条 aiStep 原本叫什么"）。
      //   - assertion 字段从 aiStep 顶层搬到首条子步骤的同行（如果存在），
      //     其它子步骤 assertion 留空——避免把"用例整体断言"复制到每条子步骤。
      //   - aiStep 上的 tabRef / delayMs 等元数据继承到首条子步骤。
      const compiled = a.compiled;
      const baseName = row.name;
      const baseAssertion = row.assertion;
      const baseInherit: Partial<StepRow> = {};
      for (const k of ['delayMs', 'tabRef', 'componentKind'] as const) {
        if (row[k] !== undefined) baseInherit[k] = row[k];
      }
      let first = true;
      for (const sub of compiled) {
        // 防御性：用 StepAction.safeParse 过滤掉非法形状（避免把 LLM 的脏数据写库）。
        const r = StepAction.safeParse(sub);
        if (!r.success) {
          // 子步骤非法 → 跳过这条 aiStep 的整段展开，原 aiStep 保留（回放时再兜底）。
          out.length = 0;
          out.push(row);
          break;
        }
        const action = r.data;
        // name 取自子步骤 kind（人类可读）；保留 aiStep.name 作为信息源：
        // 我们把它放到 componentKind 字段，回放报告 / UI 详情里仍能反查。
        const subName = String((action as { kind: string }).kind);
        const newRow: StepRow = {
          ...row,
          source: row.source,
          name: subName,
          action: action as unknown as object,
          assertion: first && baseAssertion ? baseAssertion : null,
          sensitive: false,
          ...(first ? baseInherit : {}),
        };
        if (first) {
          // componentKind 列是 varchar(32),`aiStep/<name>` 在 name 较长时会溢出;截到 32 字符。
          // 保留 `aiStep/` 前缀以便回放报告 / UI 详情反查。
          const ck = `aiStep/${baseName}`.slice(0, 32);
          (newRow as Record<string, unknown>).componentKind = ck;
        }
        out.push(newRow);
        first = false;
      }
    }
    p.stepRows = out;
  }
}
