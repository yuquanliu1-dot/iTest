import { StepAction, type StepAction as StepActionType } from '@itest/shared';
import { resolveLlmClient } from './llmSettings.js';
import type { LLMClient } from './llm-client.js';
import { planVision } from './aiStepVision.js';
import { logger } from '../logger.js';

const SYSTEM_PROMPT = `你是测试自动化步骤编译器。把用户的自然语言操作指令编译为具体的 JSON 步骤数组。
只输出 JSON：{"steps": [...]}，不要输出其他内容。
每个步骤形如 {"kind": "...", ...}，允许的 kind：
navigate {url} | click {locator} | fill {locator, value} | hover {locator} |
waitFor {locator, timeoutMs?} | assertText {locator, equals} | assertVisible {locator} |
check {locator, checked} | select {locator, value} | extract {locator, varName}。
locator 是 [{"strategy": "...", "value": "..."}] 数组，规则：
- strategy 只能是 "role" | "text" | "testId" | "css" | "xpath"。
- role 的 value 形如 "textbox" 或 "textbox[name='用户名']"。role 必须小写。
- text 的 value 是元素可见文字。
- testId 的 value 是 data-testid 值。
- css 的 value 是 CSS 选择器。
- xpath 的 value 是 xpath 表达式。
- locator 数组里给出多个候选，回放时按顺序探测；至少 1 个。
navigate 的 url 必须是绝对 URL（如 http://localhost:5173/login），不要用相对路径。
value 字段：固定字符串直接给字符串；"Abc@123456" 之类密码占位直接用占位字符串。
不要输出 aiStep kind。`;

const BATCH_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

本次为批量编译：用户消息是编号指令列表，每行形如 "N. 指令: ... | 页面 URL: ..."。
只输出 JSON：{"results": [{"index": N, "steps": [...]}]}，必须覆盖输入的每一个编号；
每个 steps 数组的语义与单条编译相同。`;

/** 批量单次调用打包的指令条数上限（受 provider max_tokens 输出上限约束，避免 JSON 被截断）。 */
const BATCH_CHUNK = 20;

/**
 * 批量编译：把多条指令合并为一次 LLM 调用。返回 0-based 位置 → 编译结果；
 * 缺失/不合法的位置不在返回值里（由调用方逐条回退）。
 * 兼容：provider 返回单条形状 {"steps": [...]} 时视为第 0 条的结果。
 */
export async function compileAiStepsBatch(
  items: Array<{ text: string; url?: string }>,
  client?: LLMClient,
): Promise<Map<number, StepActionType[]>> {
  const llm = client ?? (await resolveLlmClient()).client;
  const userMessage = items
    .map((it, i) => `${i + 1}. 指令: ${it.text}${it.url ? ` | 页面 URL: ${it.url}` : ''}`)
    .join('\n');
  const r = await llm.complete({ systemPrompt: BATCH_SYSTEM_PROMPT, userMessage });
  const out = new Map<number, StepActionType[]>();
  const parseSteps = (raw: unknown): StepActionType[] => {
    const steps: StepActionType[] = [];
    if (!Array.isArray(raw)) return steps;
    for (const item of raw) {
      const p = StepAction.safeParse(item);
      if (p.success && p.data.kind !== 'aiStep') steps.push(p.data);
    }
    return steps;
  };
  if (r.kind === 'json') {
    const results = (r.value as { results?: unknown }).results;
    if (Array.isArray(results)) {
      for (const entry of results) {
        const e = entry as { index?: unknown; steps?: unknown };
        const idx = typeof e.index === 'number' ? e.index - 1 : -1;
        if (idx < 0 || idx >= items.length) continue;
        const steps = parseSteps(e.steps);
        if (steps.length > 0) out.set(idx, steps);
      }
      return out;
    }
    // 单条形状兜底：模型忽略批量格式时至少救回第 0 条
    const single = parseSteps((r.value as { steps?: unknown }).steps);
    if (single.length > 0 && items.length > 0) out.set(0, single);
  }
  return out;
}

/**
 * 把一条自然语言指令编译为具体 DSL 步骤。
 * instruction 为空时回退用 step.name 作指令（userMessage 标记 [fallback-by-name]）。
 * LLM 输出经 zod 校验，全部不合法时带提示重试一次；仍失败则抛错（调用方决定容错策略）。
 */
export async function compileAiStep(
  instruction: string,
  ctx: { url?: string; name?: string } = {},
  client?: LLMClient,
): Promise<StepActionType[]> {
  const llm = client ?? (await resolveLlmClient()).client;
  const effective = buildEffectiveInstruction(ctx, instruction);
  const attempt = async (hint: string): Promise<StepActionType[]> => {
    const userMessage = [
      'ai-step',
      ctx.url ? `页面 URL: ${ctx.url}` : '',
      `指令: ${effective.text}${effective.fallback ? ' [fallback-by-name]' : ''}`,
      hint,
    ].filter(Boolean).join('\n');
    const r = await llm.complete({ systemPrompt: SYSTEM_PROMPT, userMessage });
    const raw = r.kind === 'json' ? (r.value as { steps?: unknown }).steps : undefined;
    if (!Array.isArray(raw)) return [];
    const out: StepActionType[] = [];
    for (const item of raw) {
      const p = StepAction.safeParse(item);
      if (p.success && p.data.kind !== 'aiStep') out.push(p.data);
    }
    return out;
  };
  const first = await attempt('');
  if (first.length > 0) return first;
  const second = await attempt('上一次输出不合法：请只输出纯 JSON {"steps":[...]}，kind 必须从允许列表中取。');
  if (second.length > 0) return second;
  throw new Error(`AI 步骤编译失败: ${effective.text.slice(0, 50)}`);
}

function buildEffectiveInstruction(
  ctx: { name?: string },
  raw: string,
): { text: string; fallback: boolean } {
  const trimmed = raw.trim();
  if (trimmed) return { text: trimmed, fallback: false };
  const fallback = ctx.name?.trim();
  if (!fallback) throw new Error('编译失败: AI 步骤缺少指令且无步骤名兜底');
  return { text: fallback, fallback: true };
}

/** 视觉路径：按 #cssSelector 占位符从 instruction 解析出 source/output；调用 provider；返回识别文本。 */
export async function compileAiStepVision(
  instruction: string,
  ctx: { image: { base64: string; mime: 'image/png' | 'image/jpeg' } },
  client?: LLMClient,
): Promise<string> {
  const llm = client ?? (await resolveLlmClient()).client;
  const plan = planVision(instruction);
  if (!plan.useVision) throw new Error('compileAiStepVision: no #cssSelector placeholder in instruction');
  const sys = `你是 OCR 助手。从图片中识别文本并只输出识别结果，不要解释，不要包含多余字符。`;
  const user = plan.outputSelector
    ? `页面元素: ${plan.sourceSelector}\n填写到: ${plan.outputSelector}\n${plan.cleanedInstruction}`
    : `页面元素: ${plan.sourceSelector}\n${plan.cleanedInstruction}`;
  const r = await llm.complete({ systemPrompt: sys, userMessage: user, image: ctx.image });
  const text = r.kind === 'text' ? r.value : JSON.stringify(r.value);
  const out = text.trim();
  if (!out) throw new Error('compileAiStepVision: provider returned empty result');
  return out;
}

/** 启发式跳过的页面关键词 + 路径，与 routes/requirements.ts inferPageUrl 同源；
 * 用于把「打开登录页」一类的 aiStep 直接编成 navigate，省一次 LLM 调用。 */
const PAGE_HINT: Array<{ keywords: string[]; path: string }> = [
  { keywords: ['登录', 'login'], path: '/login' },
  { keywords: ['注册', 'signup', 'sign up'], path: '/signup' },
  { keywords: ['工作台', '首页', 'home'], path: '/' },
  { keywords: ['设置', 'settings'], path: '/settings' },
  { keywords: ['需求', 'requirements'], path: '/requirements' },
  { keywords: ['用例', 'cases'], path: '/cases' },
  { keywords: ['计划', 'plans'], path: '/plans' },
];

/** 「打开/访问/进入」类动作开头，去掉后方便只对目标词匹配。 */
const NAV_VERB_RE = /^\s*(打开|访问|进入|跳转(?:到|至)?|前往|打开到|访问到|进入到|go\s*to|navigate\s*to|open|visit|go)\s*/i;

/** 把 instruction 与 step.name 拼起来小写后做关键词命中；命中返回绝对 URL，否则 undefined。 */
function tryHeuristicNavigate(
  instruction: string,
  name: string | undefined,
  baseUrl: string | undefined,
): string | undefined {
  // 只对 instruction 做匹配，不要把 name 拼进去——name 是后端元数据（"步骤1" 之类），
  // 拼上后会污染 stripped，启发式会失效或误命中。
  const text = instruction.trim().toLowerCase();
  if (!text) return undefined;
  if (!NAV_VERB_RE.test(text)) return undefined;
  const stripped = text.replace(NAV_VERB_RE, '').trim();
  // 命中条件：stripped 完全等于关键词，或 stripped 以「关键词 + 空格 / 页 / 界面 / 页面 / page / pages」开头。
  // 这样既能挡掉「点击登录按钮」之类的按钮文案，也能识别「打开登录页」「访问工作台」「go to login page」等。
  // 「点击登录按钮」的 stripped = "登录按钮"，不会命中任何一种尾缀；只有「打开登录页」「访问工作台」
  // 这种 stripped = "登录页" / "工作台" / "登录" / "login page" 的才会命中。
  // 注意：text 含 step.name 前缀（例如 "步骤1 访问首页"），匹配 stripped 而不是 text，
  // 否则 name 部分可能抢先匹配（这里是 "步骤1 访问首页" 完整词条没有动词开头，所以命中 stripped）。
  const matches = (k: string) => {
    if (stripped === k) return true;
    if (stripped.startsWith(`${k} `)) return true;
    if (stripped.startsWith(`${k}页`)) return true;
    if (stripped.startsWith(`${k}界面`)) return true;
    if (stripped.startsWith(`${k}页面`)) return true;
    if (stripped.startsWith(`${k} page`)) return true;
    if (stripped.startsWith(`${k} pages`)) return true;
    return false;
  };
  for (const { keywords, path } of PAGE_HINT) {
    if (keywords.some(matches)) {
      const base = (baseUrl ?? 'http://localhost:5173').replace(/\/$/, '');
      return `${base}${path}`;
    }
  }
  return undefined;
}

/** 把「断言看到工作台」「断言页面显示成功」这种纯文本断言直接编成 assertText，
 * locator 用 text 策略 + 第一个非空短句作为 equals；含 # 选择器或动态占位的让 LLM 处理。
 * 只看 instruction，name 是后端元数据（"步骤1"）会污染启发式。 */
function tryHeuristicAssertText(
  instruction: string,
  _name: string | undefined,
): StepActionType[] | undefined {
  const text = instruction.trim();
  if (!text) return undefined;
  // 有 CSS / 视觉占位 / 长指令 → 不启发式
  if (/#[\w-]+/.test(text)) return undefined;
  if (text.length > 80) return undefined;
  // 断言类关键词开头
  if (!/^(断言|检查|确认|期望|验证|assert|expect|verify|check\s+that|should\s+see|should\s+show|应|必须|可见)/i.test(text)) {
    return undefined;
  }
  // 抽出被断言的文本：去掉前缀动词
  const equals = text
    .replace(/^(断言|检查|确认|期望|验证|应|必须|可见)\s*[:：]?\s*/i, '')
    .replace(/^(看到|显示|出现|为|是|等于)\s*/i, '')
    .replace(/^(assert|expect|verify|check\s+that|should\s+see|should\s+show)\s+/i, '')
    .trim();
  if (!equals || equals.length > 40) return undefined;
  return [{
    kind: 'assertText',
    locator: [{ strategy: 'text', value: equals }],
    target: 'specifiedElement',
    match: 'contains',
    equals,
  }];
}

/** 就地编译步骤数组里的 aiStep；返回编译失败的 index 列表。不抛错、不阻塞保存。
 * 启发式跳过的步骤（navigate / 纯断言）不调 LLM；剩余指令按 BATCH_CHUNK 分块、
 * 块间并发走批量编译（单块一次 LLM 调用）；块失败或缺项的指令回退到单条编译。 */
export async function compileAiStepsInPlace(
  steps: Array<{ action: unknown; url?: string; name?: string }>,
  client?: LLMClient,
  urlResolver?: (name?: string) => string | undefined,
): Promise<number[]> {
  let llm: LLMClient | null = client ?? null;
  if (!llm) {
    try {
      llm = (await resolveLlmClient()).client;
    } catch (e) {
      logger.warn({ err: e }, 'llm unresolved; skip ai-step compile');
    }
  }

  const failed: number[] = [];
  const pending: Array<{ index: number; text: string; url?: string; name?: string }> = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const a = step.action as { kind?: string; instruction?: string; compiled?: unknown };
    if (a?.kind !== 'aiStep') continue;
    // Short-circuit: skip LLM if 'compiled' key is present (array OR null).
    // array means it was already compiled — keep as-is. null means LLM
    // already attempted and gave up — don't retry, but still report as failed.
    if ('compiled' in a) {
      if (a.compiled === null) failed.push(i);
      continue;
    }

    const instruction = a.instruction ?? '';
    const name = step.name;
    const baseUrl = step.url ?? urlResolver?.(name);

    // 启发式 1：navigate 类 → 直接出 navigate，省 LLM
    const navUrl = tryHeuristicNavigate(instruction, name, baseUrl);
    if (navUrl) {
      a.compiled = [{ kind: 'navigate', url: navUrl }];
      continue;
    }

    // 启发式 2：纯文本断言 → 直接出 assertText
    const assertCompiled = tryHeuristicAssertText(instruction, name);
    if (assertCompiled) {
      a.compiled = assertCompiled;
      continue;
    }

    let text: string;
    try {
      text = buildEffectiveInstruction(step, instruction).text;
    } catch (e) {
      logger.warn({ err: e, instruction, index: i }, 'ai-step compile failed');
      a.compiled = null;
      failed.push(i);
      continue;
    }
    pending.push({ index: i, text, url: step.url ?? urlResolver?.(name), name });
  }
  if (!llm || pending.length === 0) {
    for (const p of pending) {
      (steps[p.index]!.action as { compiled: unknown }).compiled = null;
      failed.push(p.index);
    }
    return failed;
  }

  const chunks: Array<typeof pending> = [];
  for (let i = 0; i < pending.length; i += BATCH_CHUNK) chunks.push(pending.slice(i, i + BATCH_CHUNK));
  await Promise.all(
    chunks.map(async (chunk) => {
      let batch = new Map<number, StepActionType[]>();
      try {
        batch = await compileAiStepsBatch(chunk, llm!);
      } catch {
        // 整块失败 → 全部逐条回退
      }
      for (let k = 0; k < chunk.length; k++) {
        const item = chunk[k]!;
        const a = steps[item.index]!.action as { compiled?: unknown };
        const got = batch.get(k);
        if (got) {
          a.compiled = got;
          continue;
        }
        try {
          a.compiled = await compileAiStep(item.text, { url: item.url, name: item.name }, llm!);
        } catch (e) {
          logger.warn({ err: e, instruction: item.text, index: item.index }, 'ai-step compile failed');
          a.compiled = null;
          failed.push(item.index);
        }
      }
    }),
  );
  return failed.sort((a, b) => a - b);
}
