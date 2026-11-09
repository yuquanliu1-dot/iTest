/**
 * 探索式测试会话：提示词与产物契约。
 * 与执行提示词（aiTask.SYSTEM_PROMPT_BASE「忠实/不加戏」）方向相反——探索要求「主动找茬」。
 * 动作 JSON 协议与 runAiTask 的解析器保持一致（坐标主通道 + selector 兜底）。
 */
import { z } from 'zod';
import { getExplorationPersona, type ExplorationReproStep } from '@itest/shared';

/** 单会话 findings 封顶：超出的丢弃（成本与审阅负担的双保险）。 */
export const EXPLORATION_MAX_FINDINGS = 20;

export const EXPLORATION_SYSTEM_PROMPT_BASE = `你是 Web 探索式测试智能体，在真实浏览器里按章程（charter）主动找茬：发现行为异常、校验缺失、状态错乱、体验破绽并如实报告。
每轮你会收到：当前页面 URL、视口尺寸、一张视口截图、可交互元素清单（含与截图对齐的归一化坐标框）。
只输出 JSON，不要输出其他内容。格式：
{"actions": [...], "findings": [...], "done": false, "summary": "一句话进展"}
actions 元素类型（坐标按视口归一化 0-1000，指在目标本体中心，不要指整行或外层容器）：
- {"type":"click","x":<0-1000>,"y":<0-1000>}　点击截图上的目标元素
- {"type":"fill","x":..,"y":..,"value":"<最终文本>"}　聚焦该输入框后整段输入
- 兼容形态 {"type":"click","selector":"<css>"} / {"type":"fill","selector":"<css>","value":...}：仅当元素清单里确有该 selector 且与目标唯一对应时使用；清单里没有时禁止自拟 selector，改用坐标。selector 只能是普通 CSS 或 text=文本，禁止 :has-text() 等 Playwright 专有语法
- {"type":"press","key":"Enter|Tab|Escape|ArrowDown|..."}
- {"type":"wait","ms":<毫秒>}
- {"type":"navigate","url":"<绝对地址>"}（仅 http/https 绝对地址，且不得离开被测站点）
- {"type":"screenshot","selector":"<css>"} / {"type":"screenshot","x":..,"y":..}　请求放大截图，下轮附图后仍按全页坐标输出动作
findings 契约：当轮发现了疑似缺陷/异常，就在本轮的 JSON 里带 "findings" 数组（没发现就省略该字段），每个元素：
{"title":"<不超过50字概括>","description":"<现象、期望 vs 实际、影响面>","severity":"P0"|"P1"|"P2"|"P3","reproSteps":[{"action":"<操作步骤>","expected":"<该步预期>"}]}
- severity 判级：P0=崩溃/数据丢失/安全漏洞；P1=主流程阻断；P2=功能异常但有绕行；P3=轻微/体验问题
- 只报你在截图或元素清单里亲眼证实的现象，不臆测；同一缺陷只报一次，不要多轮重报
- **自己造出来的异常也要报**：你提交表单后，若系统接受了空值/非法值/重复值并把脏数据写进列表，那本身就是缺陷证据（缺校验/缺去重）——不要因为「是我自己填的」就不报；这类缺陷只能在动手试出来，所以更该报
结束方式：
- 章程覆盖面探索完（主要路径都走过、发现都已报告）：{"done": true, "summary": "<本次探索一句话总结：覆盖了什么、发现几条>"}
- 无法继续（页面打不开/被中间态挡死等）：{"fail": "原因"}
规则：
- 主动找茬：这是探索不是执行——每轮问自己「还有哪些没试过的路径/输入/状态」。优先尝试：边界值、非法输入、必填项留空、重复提交、返回/刷新后的状态保持、筛选排序组合。
- 发现即报：发现异常的当轮立即输出 findings（平台会截当前页面作证据），不要攒到最后一起报。
- 改动克制：可以填写、选择、点击查看类操作，也可以用明显测试语义的内容（如「测试数据」）提交表单来观察校验行为；但删除、支付、发送、审批等不可逆/外发操作，除非章程明确要求，一律不执行——发现此类入口就输出 finding 描述风险，不要点下去；遇到「确认删除」类二次确认弹窗一律取消。
- 范围约束：只在被测站点域名内探索，不访问外部链接；遇到登录页按指令里的登录准备段处理。
- 不空转：同一目标连续 3 次失败就换路径；页面加载中/骨架屏先 wait 再观察；长列表小步滚动（50~150px）。
- 别用整页滚动代替探索：元素清单已给出全部可交互控件的坐标框，直接对目标下手；确要看下方内容才滚一次，滚动后下一轮就动手。
- 每轮最多 2 个动作，宁可多轮推进；每个动作的执行结果（ok/错误）下轮反馈给你。`;

export interface ComposeExplorationArgs {
  startUrl: string;
  charter: string;
  personaKey: string;
  /** true = 拼「登录准备」前导段（无暖登录态且环境有凭据时）；缺省 false。 */
  needsLoginPreamble?: boolean;
  /** 登录占位符字面量（credentialPlaceholder 产物），needsLoginPreamble 时必填。 */
  loginPlaceholders?: { user: string; password: string };
  /** web 资源清单文本（renderWebResourceManifest 产物），可空。 */
  manifest?: string;
}

/** 组装探索指令（runAiTask 的 instruction 参数，每轮随 user message 携带）。 */
export function composeExplorationInstruction(args: ComposeExplorationArgs): string {
  const persona = getExplorationPersona(args.personaKey);
  const sections: string[] = [`## 章程（charter）\n${args.charter.trim()}`, `## 视角\n${persona.directive}`];
  if (args.needsLoginPreamble && args.loginPlaceholders) {
    sections.push(
      `## 登录准备\n当前可能是登录页。若在登录页：找到用户名/密码输入框，fill 的 value 一律用字面量 ${args.loginPlaceholders.user} / ${args.loginPlaceholders.password}（平台会替换为真实值；你不得猜测、拼接或输出真实凭据）；有验证码先 screenshot 放大逐字符辨认再 fill；登录后若出现强制改密/绑定等弹窗，能跳过则跳过，然后继续章程。已有登录态（页面无登录表单）则跳过本段直接探索。`,
    );
  }
  if (args.manifest?.trim()) {
    sections.push(`## 可选 web 服务\n${args.manifest.trim()}`);
  }
  sections.push(`## 起点\n从 ${args.startUrl} 开始，按章程在站点内导航探索。`);
  sections.push('## 输出契约\n发现疑似缺陷当轮输出 findings 数组；结束时 done.summary = 本次探索总结（覆盖了什么、发现几条）。');
  return sections.join('\n\n');
}

const FindingSchema = z.object({
  title: z.string().trim().min(1).transform((s) => s.slice(0, 200)),
  description: z.string().trim().min(1).transform((s) => s.slice(0, 4000)),
  /** 非法/缺失判级 → P2 兜底（判级脏值不丢整条 finding）。 */
  severity: z
    .string()
    .optional()
    .transform((s): 'P0' | 'P1' | 'P2' | 'P3' => (s === 'P0' || s === 'P1' || s === 'P2' || s === 'P3' ? s : 'P2')),
  reproSteps: z
    .array(
      z.object({
        action: z.string().trim().min(1).transform((s) => s.slice(0, 500)),
        expected: z.string().optional(),
      }),
    )
    .transform((a) => a.slice(0, 10))
    .default([]),
});

export interface CoercedFinding {
  title: string;
  description: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  reproSteps: ExplorationReproStep[];
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 模型 findings 原始数组 → 可落库形态：字段截断兜底（脏 severity→P2/超长→slice）、
 *  仅空标题/空描述判非法丢弃、剩余配额截断、跨轮按标题去重。 */
export function coerceFindings(
  raw: unknown[],
  opts?: { existingTitles?: string[]; max?: number },
): { accepted: CoercedFinding[]; dropped: number } {
  const seen = new Set((opts?.existingTitles ?? []).map(normalizeTitle));
  const max = opts?.max ?? EXPLORATION_MAX_FINDINGS;
  const accepted: CoercedFinding[] = [];
  let dropped = 0;
  for (const item of raw) {
    if (accepted.length >= max) {
      dropped += 1;
      continue;
    }
    const parsed = FindingSchema.safeParse(item);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    const key = normalizeTitle(parsed.data.title);
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    accepted.push(parsed.data);
  }
  return { accepted, dropped };
}
