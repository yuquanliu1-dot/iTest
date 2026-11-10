/**
 * 探索式测试会话：提示词与产物契约。
 * 与执行提示词（aiTask.SYSTEM_PROMPT_BASE「忠实/不加戏」）方向相反——探索要求「主动找茬」。
 * 动作 JSON 协议与 runAiTask 的解析器保持一致（坐标主通道 + selector 兜底）。
 */
import { z } from 'zod';
import { getExplorationPersona, type ExplorationReproStep } from '@itest/shared';

/** 单会话 findings 封顶：超出的丢弃（成本与审阅负担的双保险）。 */
export const EXPLORATION_MAX_FINDINGS = 20;

/** 单会话数据库取证次数封顶：查库是取证手段不是探索主路径，超额即拒（防模型把预算烧在扫库上）。 */
export const EXPLORATION_MAX_SQL_PROBES = 20;

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
- {"type":"sql","query":"<只读 SELECT/WITH 语句>","limit":<行数>,"db":"<库名，可选>"}　对被测系统的数据库跑一条只读查询取证（可选通道：环境配了数据库才有；不写 db 就查环境默认库）
子目标清单（可选，章程可分解为 2 条以上子操作时使用；简单章程不需要）：
- 第 1 轮随 actions 一起输出 "plan": [{"text":"打开新增对话框"},{"text":"填写名称"},{"text":"保存并确认"}]
- 之后每轮输出更新后的完整清单：截图确认已生效的条目加 "done":true（预期下一步才会完成的不算提前标），可按页面实际增删改条目
- 每轮的当前进度会回显给你——用它保持方向感，不要重复已完成的目标
findings 契约：当轮发现了疑似缺陷/异常，就在本轮的 JSON 里带 "findings" 数组（没发现就省略该字段），每个元素**严格用下面这四个字段名**，不要改名、不要加自创字段：
{"title":"<不超过50字概括>","description":"<现象、期望 vs 实际、影响面>","severity":"P0"|"P1"|"P2"|"P3","reproSteps":[{"action":"<操作步骤>","expected":"<该步预期>"}]}
- description 就叫 description（不能写成 evidence/detail/desc）；severity 只能是 P0/P1/P2/P3（不能写「高/中/低」）；要补充缺陷位置就写进 description 里
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
- 范围约束（平台强制）：只在被测站点域名内探索，不访问外部链接——越界的 navigate 会被平台机械拒收并计为一次失败；起点页面打不开/不可达时直接输出 fail 如实说明，不要改去任何其它站点或凭记忆换地址；遇到登录页按指令里的登录准备段处理。
- 不空转：同一目标连续 3 次失败就换路径；页面加载中/骨架屏先 wait 再观察；长列表小步滚动（50~150px）。
- 别用整页滚动代替探索：元素清单已给出全部可交互控件的坐标框，直接对目标下手；确要看下方内容才滚一次，滚动后下一轮就动手。
- 每轮最多 2 个动作，宁可多轮推进；每个动作的执行结果（ok/错误）下轮反馈给你。
- 反馈里的「页面消息: "…"」是应用 toast/提示（aria-live 区域）的一手文本——写 findings 的 description 时以此为准，截图读不清不成为漏报理由。
- 反馈里的「页面无观测变化」= 该点击没有产生任何效果（目标被遮挡/禁用/命中非交互元素）——不要原样重试同一目标，换用元素清单坐标或换目标。
- 数据库取证（可选通道）：环境配了数据库时可用 sql 动作查证「前端没显示但库里写进去了」「列表少了一条但库里有」这类只在数据层可见的现象。只允许 SELECT / WITH 开头的只读查询（写语句会被平台机械拒收并计为一次失败）；一次最多回 20 行；先有具体假设再查，别反复扫全库；查到的行里若有手机号/身份证/密码哈希这类敏感值，不要写进 findings。`;

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
  /** 环境里的数据库对象（label + 方言）；非空则拼「## 数据库取证」段（sql 动作的可用库清单）。 */
  dbs?: Array<{ label: string; dialect: string }>;
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
  if (args.dbs && args.dbs.length > 0) {
    const list = args.dbs.map((d) => `${d.label}（${d.dialect}）`).join('、');
    sections.push(
      `## 数据库取证\n环境配了数据库，你可以用 {"type":"sql","query":"<只读 SELECT/WITH>","limit":<行数>} 直接查库取证——这是拿到「前端没显示但库里写进去了」这类数据层证据的唯一手段。\n可用数据库：${list}；要查指定库就在 sql 动作里加 "db":"<库名>"（库名照抄上面的清单），不写 db 就查环境默认库。\n约束：只允许 SELECT / WITH 开头的只读查询（写语句会被平台机械拒收）；一次最多回 20 行；查库不改变页面状态。\n用法：先有具体假设再查（例如「新增后列表没显示」→ 查对应表的最新一条）；表名/字段名不确定时先查元数据 SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')；行里的手机号/身份证/密码哈希等敏感值不要写进 findings。`,
    );
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

/** 一条动作留痕（平台记录的 ground truth，非模型自述）。
 *  会话级（exploration_sessions.actions_trail）存整场动作序列；
 *  缺陷级（exploration_findings.actions_trail）存"自上一条 finding 起"的片段。 */
export interface ExplorationStep {
  type: string;
  target: string;
  ok: boolean;
  /** sql 步骤的结果摘要（行数 + 首行）；其余动作无。 */
  detail?: string;
}

/** 老会话回落：会话级留痕列为空时，把各 finding 的片段按 order 拼回整场动作序列。 */
export function mergeExplorationTrails(
  findings: Array<{ actionsTrail?: Array<Partial<ExplorationStep>> | null }>,
): ExplorationStep[] {
  const out: ExplorationStep[] = [];
  for (const f of findings) {
    for (const s of f.actionsTrail ?? []) {
      if (!s || typeof s !== 'object') continue;
      out.push({
        type: typeof s.type === 'string' ? s.type : '',
        target: typeof s.target === 'string' ? s.target : '',
        ok: s.ok === true,
        ...(typeof s.detail === 'string' && s.detail ? { detail: s.detail } : {}),
      });
    }
  }
  return out;
}

/** 动作留痕 → 复现步骤文本：平台自己记的动作序列 = ground truth（模型脑补的步骤靠不住）。
 *  升格用例与详情展示共用这一份口径。 */
export function trailToSteps(trail: Array<{ type?: unknown; target?: unknown; detail?: unknown }>): ExplorationReproStep[] {
  const steps: ExplorationReproStep[] = [];
  for (const a of trail) {
    const type = typeof a.type === 'string' ? a.type : '';
    const target = typeof a.target === 'string' ? a.target : '';
    const detail = typeof a.detail === 'string' ? a.detail : '';
    switch (type) {
      case 'click': steps.push({ action: `点击 ${target}` }); break;
      case 'fill': steps.push({ action: `在 ${target} 输入内容` }); break;
      case 'press': steps.push({ action: `按键 ${target}` }); break;
      case 'wait': steps.push({ action: `等待 ${target} 毫秒` }); break;
      case 'navigate': steps.push({ action: `访问 ${target}` }); break;
      case 'screenshot': steps.push({ action: `截图 ${target}` }); break;
      // 查库取证：expected 带平台记录的行数/摘要——reviewer 不用再自己去查一遍库。
      case 'sql': steps.push({ action: `查库 ${target}`, ...(detail ? { expected: detail } : {}) }); break;
      default:
        if (target) steps.push({ action: `${type} ${target}`.trim() });
        break;
    }
  }
  return steps;
}

// —— 形状容错：真实模型常把字段写成别的名字/别的判级词，形状漂移不该让整条 finding 消失 ——
// 2026-11-10 prod 实录：模型输出 {title,severity:"中",location,evidence}，
// 旧实现只认 description → 5 条全被 safeParse 静默丢弃（摘要说 5 条、库里 0 条）。
// 同日二次实录：另一模型输出 {type,描述,证据} → title/description 双缺全灭（8 条 0 落库）。
const DESCRIPTION_KEYS = ['description', 'evidence', 'detail', 'details', 'desc', 'analysis', 'content', '描述', '现象', '详情', '说明', '证据'];
const TITLE_KEYS = ['title', 'name', 'issue', 'bug', 'summary', '标题', '缺陷', '问题', 'type'];
const LOCATION_KEYS = ['location', 'position', 'where', 'page', '位置', '所在位置', '页面'];
const STEPS_KEYS = ['reproSteps', 'repro', 'steps', 'reproduceSteps', '复现步骤', '操作步骤', '步骤'];
const SEVERITY_KEYS = ['severity', 'priority', 'level', '严重程度', '级别', '优先级'];

/** 中文/英文判级词 → P0-P3（未知判级 → P2 兜底）。 */
const SEVERITY_ALIASES: Record<string, 'P0' | 'P1' | 'P2' | 'P3'> = {
  p0: 'P0', blocker: 'P0', critical: 'P0', 致命: 'P0', 阻塞: 'P0',
  p1: 'P1', high: 'P1', 高: 'P1', 严重: 'P1', 高危: 'P1',
  p2: 'P2', medium: 'P2', 中: 'P2', 中危: 'P2', 一般: 'P2', 普通: 'P2',
  p3: 'P3', low: 'P3', 低: 'P3', 低危: 'P3', 轻微: 'P3', 次要: 'P3',
};

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function normalizeSeverity(raw: unknown): 'P0' | 'P1' | 'P2' | 'P3' {
  if (typeof raw !== 'string') return 'P2';
  return SEVERITY_ALIASES[raw.trim().toLowerCase()] ?? 'P2';
}

function normalizeSteps(raw: unknown): ExplorationReproStep[] {
  if (!Array.isArray(raw)) return [];
  const out: ExplorationReproStep[] = [];
  for (const s of raw) {
    if (typeof s === 'string') {
      const t = s.trim();
      if (t) out.push({ action: t.slice(0, 500) });
    } else if (s && typeof s === 'object') {
      const o = s as Record<string, unknown>;
      const action = pickString(o, ['action', 'step', 'instruction', 'text', '操作']);
      if (!action) continue;
      const expected = pickString(o, ['expected', 'expect', 'result', '预期']);
      out.push({ action: action.slice(0, 500), ...(expected ? { expected: expected.slice(0, 500) } : {}) });
    }
    if (out.length >= 10) break;
  }
  return out;
}

// —— 近义标题合并：同一缺陷被模型换措辞重报，只留第一条 ——
// 2026-11-10 prod 实录：一次探索落了 7 条 ≈ 3 个真缺陷（字体方框 ×3、名称误报 ×2、undefined/NaN ×2）。
// 口径 = 字符集 Dice 相似度（借 explorbot similarityScore 的集合交并）≥ 阈值，
// 且「定位细节 / 主体词」不冲突——相似度高但指代不同对象的（不同行/不同按钮/不同字段）必须分开。

/** 相似度阈值：标定自 prod 7 条近义标题（聚成 3 组）+ 合成必须分开的对（0 误并）。 */
const SIMILARITY_MERGE_THRESHOLD = 0.72;

/** 定位细节：数字 / 第N行列项页条 / 引号内文本——指代不同对象即视为不同缺陷。 */
function positionTokens(title: string): string[] {
  const out = new Set<string>();
  for (const m of title.matchAll(/\d+(?:\.\d+)*/g)) out.add(m[0]);
  for (const m of title.matchAll(/第.{1,3}?[行列项页条]/g)) out.add(m[0]);
  for (const m of title.matchAll(/[「『“"']([^」』”"']{1,12})[」』”"']/g)) if (m[1]) out.add(m[1]);
  return [...out].sort();
}

/** 主体词：字段名 / 操作对象 / 值特征——同句式换主体词 = 另一个缺陷（保存按钮 vs 删除按钮、用户名 vs 密码）。 */
const SUBJECT_TOKENS = [
  // 字段
  '用户名', '密码', '手机号', '手机', '邮箱', '验证码', '姓名', '名称', '标题', '金额', '价格', '数量',
  '日期', '时间', '地址', '备注', '描述', '类型', '状态', '编号', '角色', '部门', '文件', '图片',
  // 操作对象
  '保存', '删除', '提交', '导出', '导入', '上传', '下载', '搜索', '筛选', '排序', '分页', '新增',
  '编辑', '复制', '粘贴', '撤销', '重置', '刷新', '登录', '退出', '注册', '勾选', '全选', '展开',
  '折叠', '切换', '关闭', '打开', '确认', '取消', '审批', '支付', '打印',
  // 值特征
  '负数', '正数', '小数', '整数', '超大值', '超长', '为空', '空值', '边界值', '特殊字符',
  '中文', '英文', '重复值', '空格', '全角', '半角',
];

function subjectTokens(title: string): string[] {
  return SUBJECT_TOKENS.filter((t) => title.includes(t)).sort();
}

/** 字符集 Dice 相似度。 */
function diceSimilarity(a: string, b: string): number {
  const A = new Set([...a.replace(/\s/g, '')]);
  const B = new Set([...b.replace(/\s/g, '')]);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const c of A) if (B.has(c)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

/** 形状指纹：被拒条目的键名/类型——形状漂移时一眼看出模型写了什么（不落全文）。 */
export function shapeFingerprint(item: unknown): string {
  if (typeof item === 'string') return `string:${item.slice(0, 40)}`;
  if (Array.isArray(item)) return `array:${item.length}`;
  if (item && typeof item === 'object') return `keys:${Object.keys(item as object).join(',')}`;
  return `type:${typeof item}`;
}

/** 两条标题是否同一缺陷（近义重报）。 */
function isNearDuplicate(a: string, b: string): boolean {
  if (a === b) return true;
  if (positionTokens(a).join(' ') !== positionTokens(b).join(' ')) return false;
  const sa = subjectTokens(a);
  const sb = subjectTokens(b);
  if (sa.length && sb.length && sa.join(' ') !== sb.join(' ')) return false;
  return diceSimilarity(a, b) >= SIMILARITY_MERGE_THRESHOLD;
}

/** 原始条目 → 契约形状；标题或描述双缺（或非对象）判废条目返回 null。
 *  字符串条目也收：模型有时直接把缺陷写成一句话（当标题兼描述）。 */
function canonicalizeFinding(raw: unknown): CoercedFinding | null {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    return { title: text.slice(0, 200), description: text.slice(0, 4000), severity: 'P2', reproSteps: [] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const title = pickString(o, TITLE_KEYS);
  const description = pickString(o, DESCRIPTION_KEYS);
  if (!title || !description) return null;
  const location = pickString(o, LOCATION_KEYS);
  let desc = location && !description.includes(location) ? `${description}\n位置：${location}` : description;
  // 高优先级描述键（如 描述）赢了位次时，证据文本不能丢——并作补充段（同 location 合并法）。
  const evidence = pickString(o, ['证据']);
  if (evidence && !desc.includes(evidence)) desc = `${desc}\n证据：${evidence}`;
  const severityRaw = SEVERITY_KEYS.map((k) => o[k]).find((v) => typeof v === 'string' && v.trim());
  const stepsRaw = STEPS_KEYS.map((k) => o[k]).find((v) => Array.isArray(v));
  return { title, description: desc, severity: normalizeSeverity(severityRaw), reproSteps: normalizeSteps(stepsRaw) };
}

/** 模型 findings 原始数组 → 可落库形态：字段截断兜底（脏 severity→P2/超长→slice）、
 *  仅空标题/空描述判非法丢弃、剩余配额截断、跨轮按标题去重（逐字 + 近义）。
 *  dropped = 被拒总数（重复/超配额/非法）；invalid = 其中字段实在不可救的非法条数。 */
export function coerceFindings(
  raw: unknown[],
  opts?: { existingTitles?: string[]; max?: number },
): { accepted: CoercedFinding[]; dropped: number; invalid: number; invalidShapes: string[] } {
  const seen: string[] = (opts?.existingTitles ?? []).map(normalizeTitle);
  const max = opts?.max ?? EXPLORATION_MAX_FINDINGS;
  const accepted: CoercedFinding[] = [];
  const invalidShapes: string[] = [];
  let dropped = 0;
  let invalid = 0;
  for (const item of raw) {
    if (accepted.length >= max) {
      dropped += 1;
      continue;
    }
    const canon = canonicalizeFinding(item);
    if (!canon) {
      dropped += 1;
      invalid += 1;
      if (invalidShapes.length < 5) invalidShapes.push(shapeFingerprint(item));
      continue;
    }
    const parsed = FindingSchema.safeParse(canon);
    if (!parsed.success) {
      dropped += 1;
      invalid += 1;
      if (invalidShapes.length < 5) invalidShapes.push(shapeFingerprint(item));
      continue;
    }
    const key = normalizeTitle(parsed.data.title);
    // 逐字重复 + 近义重报（同一缺陷换措辞）都算重复
    if (seen.some((t) => isNearDuplicate(t, key))) {
      dropped += 1;
      continue;
    }
    seen.push(key);
    accepted.push(parsed.data);
  }
  return { accepted, dropped, invalid, invalidShapes };
}
