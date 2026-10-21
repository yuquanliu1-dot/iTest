/**
 * verify_case 工具：生成/修改用例后在真实被测系统上实测验证（全 AI 驱动，无硬编码登录）。
 * 编排：读用例 → resolveEnv → resolveCaseUrl → launch → 逐步骤 runAiTask（LLM 看截图+元素清单
 * 自主操作浏览器）→ 失败即停 → 失败页元素清单（复用 inspectPage 提取器）→ 结构化反馈供 agent 自修正。
 * AI 步骤 + 终态判定全过后，追加与正式回放同引擎的 compiled 机械干跑（executeCaseInBrowser）：
 * AI 临场执行可自适应修正（换落点/换目标重试），回放是逐字派发——分叉只有真机回放能暴露。
 * 登录/验证码/改密弹窗等场景由 LLM 按页面实际状态自主判断处理；凭据经占位符注入、执行时刻替换，
 * 不进 LLM 上下文/返回值/日志。验证不落 report（结果只回对话上下文）；副作用与正式执行一致（spec 已确认接受）。
 */
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
// 步骤/元哈希已移 verifyTrace.ts（solidify 轨迹新鲜度与 verify 前缀确认共用同一套哈希）
import { hashEffectiveSteps, hashVerifyMeta, traceKey, saveVerifiedTrace, clearVerifiedTrace } from './verifyTrace.js';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { asc, eq, and } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { testCases, testSteps, aiStageCaseOps, aiStageCases } from '../../../db/schema.js';
import { runAiTask, USER_PH, PASSWORD_PH, SECRET_PH, makeCredentialValueSub, credentialPlaceholder, type AiAction } from '../../../execute/aiTask.js';
import { buildCredentialSource, renderWebResourceManifest } from '../../../execute/credentialSource.js';
import { isVisualStep } from '../../../execute/aiActionMap.js';
import { writeStepScreenshot, executeCaseInBrowser, type ExecStepResult } from '../../../execute/cdp.js';
import { LOCATOR_PROBE_ROUNDS, LOCATOR_PROBE_INTERVAL_MS } from '../../../execute/locator-probe.js';
import { buildCandidates } from '../../../execute/locator-resolver.js';
import type { Locator } from '@itest/shared';
import { runCaseVisionAssert } from '../../../execute/visionAssert.js';
import { resolveEnv } from '../../../execute/envContext.js';
import { resolveCaseUrl } from '../../../lib/resolve-url.js';
import { decrypt } from '../../../lib/secret-crypto.js';
import { analyzeLocatorCandidatesBatch, summarizeStaticReports, type StaticLocatorReport } from '../../../execute/staticLocator.js';
import { resolveLlmClient } from '../../../agent/llmSettings.js';
import { tryParseJson } from '../../../agent/llm-client.js';
import { extractPageElements, extractPageEvidence } from '../../inspectPage.js';
import { probeLocatorHits, diagnoseFailure } from './failureDiagnosis.js';
import { countRepoGrepBatch } from '../../repo.js';
import { computeCaseOverlay, type EffectiveStep } from './case-ops-tools.js';
import { judgeAssertionText } from './assertionJudge.js';
import { getLoginState, loginStateKey, saveLoginState } from './loginStateCache.js';
import { registerLiveView } from '../../../execute/liveView.js';
import { repoToolCwd } from './context.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

// AI 轮次慢于编译回放，watchdog 基础 300s；多步用例按步数缩放（每步 ~130s 预算，
// prod228 实测每步 AI 相 ~85-107s，130s/步留出机械回放/restore 余量）——固定 300s 装不下 10 步用例。
// 单步对话轮上限独立收紧（STEP_MAX_TURNS）；单步 AI 相另有秒级帽子 STEP_AI_TIMEOUT_MS：
// 某一步在慢 SUT 上拖到该帽子 → fail-stop 该步（StepTimedOut），而不是让整轮到全局预算耗尽才死。
// 帽子取 240s（初版 150s 偏紧）：prod228 实测「冷容器重建后全新一轮 = 登录 + 步1 AI 相」就要 183.7s
// （步内至多 maxTurns=5 轮，不同步冷启动+登录会到分钟级）——150s 会把这类合法慢步误杀成 StepTimedOut，
// 240s 在 183.7s 上留 ~30% 余量，同时仍能兜住 LLM 客户端挂起这类轮数计数不到的异常。
const VERIFY_TIMEOUT_BASE_MS = 300_000;
const VERIFY_TIME_PER_STEP_MS = 130_000;
const STEP_AI_TIMEOUT_MS = 240_000;
const STEP_MAX_TURNS = 5;

/** 全局看门狗预算 = max(基础 300s, 步数 × 每步 130s)。多步用例的慢是渐进累计的，预算必须随步数增长。 */
export function computeVerifyTimeoutMs(stepCount: number): number {
  return Math.max(VERIFY_TIMEOUT_BASE_MS, stepCount * VERIFY_TIME_PER_STEP_MS);
}
// 同一用例连续失败上限：prompt 建议 3 轮，但 prompt 建议不硬——agent 可无视。这里加硬约束：
// 第 N+1 轮若失败原因签名与前一轮相同（无进展）即强制停止并给出"环境/前置问题"提示，
// 避免在环境缺数据/页面持续不稳定的场景里空转烧 LLM 调用。
const VERIFY_MAX_STAGNANT_ROUNDS = 3;

/** 凭据占位符：提示词里只有字面量，valueSub 在动作执行时刻替换为真实值。
 *  协议常量随 execute 层定义（valueSub 语义所在地），此处转出口径不变。 */
export { USER_PH, PASSWORD_PH, SECRET_PH };

interface AiStepResult {
  order: number;
  status: 'passed' | 'failed';
  durationMs: number;
  warning?: string;
  screenshot?: string;
  error?: string;
  failureReason?: 'StepReportedFailed' | 'AiTaskAborted' | 'SecretMissing' | 'LocatorMismatch' | 'AmbiguousLocator' | 'StepTimedOut';
}

/** 按 thread×case 维度跟踪连续同因失败轮次（防空转硬约束用）。
 *  失败签名 = `${failureReason}:${stepOrder}`——签名相同视为无进展。
 *  只取两段（原因 + 失败步序）是刻意为之：错误首行会随 AI 每轮改选择器/改文案而变，
 *  把首行进签名会让「同因无进展」判定永不触发（每轮都像新原因），停滞护栏就失效了。
 *  线程/用例结束（passed 或强制停止）即清掉该条记录。 */
interface RoundState {
  lastSignature: string;
  consecutive: number;
}
const verifyRoundState = new Map<string, RoundState>();
const roundKey = (threadId: string, caseId: string) => `${threadId}::${caseId}`;
/** 从 verify_case 响应 data JSON 解析出"失败签名"；passed 或解析失败 → null（清计数）。 */
function failureSignatureFromData(data: string): string | null {
  try {
    const j = JSON.parse(data) as {
      result: 'passed' | 'failed';
      failure?: { failureReason?: string | null; stepOrder: number; error?: string | null; humanMessage?: string | null };
    };
    if (j.result === 'passed') return null;
    if (!j.failure) return 'unknown';
    const f = j.failure;
    return `${f.failureReason ?? 'Unknown'}:${f.stepOrder}`;
  } catch {
    return 'unparseable';
  }
}

/** 更新按 thread×case 的失败签名轮次：通过 → 清除；签名变更 → 重置计数；同签名 → 累加。 */
function updateRoundState(key: string, data: string): void {
  const sig = failureSignatureFromData(data);
  if (sig === null) {
    verifyRoundState.delete(key);
    return;
  }
  const prev = verifyRoundState.get(key);
  verifyRoundState.set(key, {
    lastSignature: sig,
    consecutive: prev && prev.lastSignature === sig ? prev.consecutive + 1 : 1,
  });
}

/**
 * 终态判定失败时探测「环境无前置数据」信号（Element-UI 空表 / 分页 0 条 / 通用空态文案）。
 * 用于把 VisionAssertionFailed 的失败反馈从「与预期不符」细化成「环境里根本没有可验证的数据」——
 * 2026-10-13 prod228 实测：AI 建的用例只做「进页面看列表」，而「自动处置」tab 恒为 0 条，
 * 终态判定必然落空。反馈若只说「不符」，AI 会靠稀释 expectedOutcome 蒙混过关（三轮才收敛）。
 * 命中即在 note 里点名：要么让用例先造出前置数据，要么如实汇报环境缺数据，不要改预期。
 * 用字符串表达式传 page.evaluate：tsx/esbuild keepNames 会注入 __name 辅助调用，
 * 浏览器端无此符号会 ReferenceError（与 inspectPage.ts 同因）。
 */
async function detectEmptyDataState(page: Page): Promise<string | null> {
  try {
    const hit = (await page.evaluate(`(() => {
      const texts = Array.from(document.querySelectorAll('.el-table__empty-text, .el-empty__description, [class*="empty"]'))
        .map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean);
      const body = document.body ? document.body.innerText : '';
      const zeroPage = /共\\s*0\\s*条|共\\s*0\\s*项/.test(body);
      const emptyText = texts.find((t) => /暂无|没有|无数据|为空|no data/i.test(t));
      return JSON.stringify({ emptyText: emptyText ?? null, zeroPage, texts: texts.slice(0, 3) });
    })()`)) as string;
    const parsed = JSON.parse(hit) as { emptyText: string | null; zeroPage: boolean; texts: string[] };
    if (parsed.emptyText) return parsed.emptyText;
    if (parsed.zeroPage) return parsed.texts[0] ?? '分页计数为 0';
    return null;
  } catch {
    return null;
  }
}

/** 收集 compiled 步骤里的全部 locator 候选（供静态定位预检 / 失败归因的形态无关探针复用）。 */
export function collectStepLocators(compiled: unknown): Locator[] {
  const actions = (Array.isArray(compiled) ? compiled : []) as Array<{ kind?: string; locator?: Locator[] }>;
  const out: Locator[] = [];
  for (const a of actions) {
    if (typeof a.kind !== 'string') continue;
    const locs = Array.isArray(a.locator) ? a.locator : [];
    for (const l of locs) {
      if (l && typeof l.value === 'string' && l.value && typeof l.strategy === 'string') out.push(l);
    }
  }
  return out;
}

/** 全视觉判定：全部步骤无 compiled（或纯 aiTask）→ 机械干跑无意义（无 compiled 可逐字派发）。
 *  full 模式据此跳过机械干跑；mechanical 模式据此直接拒绝（引导先 full 实测 / solidify 固化）。 */
function isAllVisualSteps(steps: EffectiveStep[]): boolean {
  return steps.every((s) => {
    const c = (s as { compiled?: unknown }).compiled;
    if (!Array.isArray(c) || c.length === 0) return true;
    return (c as Array<{ kind?: string }>).every((a) => a?.kind === 'aiTask');
  });
}

/** 前缀确认状态：AI 相跨轮续跑的依据（Problem 1）。
 *  key = threadId::caseId（与停滞护栏同 key、同进程内内存生命周期）。
 *  stepsHash 按步存：某步的 instruction/compiled/assertion/sensitive/delayMs 任一变化即使
 *  firstDiff 落在该步、前缀截断到它之前——判定缓存随步哈希自动失效。
 *  metaHash 刻意排除 expectedOutcome/title：最常改的 vision 修正不该让整个 AI 相白跑。
 */
interface VerifyConfirmState {
  stepsHash: string[];
  metaHash: string;
  /** 已确认条数 k：步骤 1..k 的 AI 相全过且未被后续改动击穿。 */
  confirmedThrough: number;
  /** stepId → 断言判定缓存（judgeAssertionText 的单轮 LLM 判定；跳过 judge 的前缀步据此复用）。 */
  assertionVerdicts: Map<string, { real: boolean; dropped?: string }>;
  /** 已确认前缀步骤的 AI 相通过结果（响应 steps 合并复用；截图路径跨轮仍可访问，无 TTL）。 */
  confirmedStepResults: AiStepResult[];
  /** 已确认步骤的 AI 动作轨迹（resume 轮合并完整轨迹用）：前缀步沿用上一轮条目，
   *  本轮 AI 相补齐改动步。没有它，resume 轮存不出完整轨迹 → 紧跟的 solidify 无从零执行
   *  （prod228 实测：改一步再验，resumeFrom=2 恰好撞上轨迹存不下的轮次）。 */
  confirmedTraces: Map<string, AiAction[]>;
}
const verifyConfirmCache = new Map<string, VerifyConfirmState>();

/** 机械回放敏感字段解密表：恢复续跑（restore）与结尾完整回放共用。 */
function buildReplaySecrets(steps: EffectiveStep[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of steps) {
    if (s.sensitive && s.secretCiphertext && s.secretIv && s.secretTag) {
      m.set(
        s.id,
        decrypt({
          ciphertext: Buffer.from(s.secretCiphertext, 'base64'),
          iv: Buffer.from(s.secretIv, 'base64'),
          tag: Buffer.from(s.secretTag, 'base64'),
        }),
      );
    }
  }
  return m;
}

/** compiled 保真校验：verify_case 的 AI 可以临场绕开坏 locator，但正式回放是逐字执行 compiled 的——
 *  校验不通过必须在验证阶段就判失败，逼 AI 用真实选择器修正，而不是"AI 能过=用例能跑"。
 *  时机：click/hover 在步骤前校验（元素此时就该在页面上）；断言类、fill、check、select、extract 在 AI 通过后校验
 *  （这些动作结束时元素理应仍在）。navigate/aiTask/waitFor 无从或不必校验，跳过。
 *  候选探测直接复用回放的 buildCandidates + count()：候选展开（纯 #id 提升、role 拆 name、testId 包
 *  data-testid）与探测顺序跟 tryFirstMatch 完全一致——verify 的「首命中候选」就是回放实际会采用的候选。
 *  两级判失败：
 *  1) 全部候选未命中 → LocatorMismatch（回放必挂）；
 *  2) 首命中候选命中多个元素（count>1）且动作是 click/fill/hover → AmbiguousLocator——这三类在回放里
 *     命中多元素会静默退到 .first() 操作 DOM 序第一个（check/select 是显式抛错，无静默风险），
 *     verify 只测 count>0 会放行"碰巧对"的选择器（目标恰好是第一个匹配），表单加字段/调序即静默错元素。
 *  探测窗口与回放对齐（LOCATOR_PROBE_ROUNDS 轮 × 250ms ≈3s，首轮立即）：SPA 深链挂载滞后可达秒级、
 *  networkidle 不可靠，verify 预检窗口若短于回放会误判回放能过的 locator。 */
async function checkCompiledLocators(
  page: import('playwright-core').Page,
  compiled: unknown,
  mode: 'pre' | 'post',
): Promise<{ reason: 'LocatorMismatch' | 'AmbiguousLocator'; message: string } | null> {
  const actions = (Array.isArray(compiled) ? compiled : []) as Array<{
    kind?: string;
    locator?: Array<{ strategy?: string; value?: string }>;
  }>;
  for (const a of actions) {
    if (!a.kind) continue;
    const timing = a.kind === 'click' || a.kind === 'hover' ? 'pre' : 'post';
    if (a.kind === 'navigate' || a.kind === 'aiTask' || a.kind === 'waitFor') continue;
    if (timing !== mode) continue;
    const locs = Array.isArray(a.locator) ? a.locator : [];
    if (locs.length === 0) continue;
    // 结构性错误与命中无关，直接判失败
    for (const l of locs) {
      if (l.strategy === 'accessibilityId' || l.strategy === 'label' || l.strategy === 'predicate') {
        return { reason: 'LocatorMismatch', message: `compiled 定位校验不通过: strategy '${l.strategy}' 为移动端专用，web 回放不支持` };
      }
      if (typeof l.value !== 'string' || !l.value) {
        return { reason: 'LocatorMismatch', message: `compiled 定位校验不通过: ${a.kind} 的 locator 缺少 value` };
      }
    }
    // 与回放同一候选构造 + count 探测：任一候选命中即停（回放同款短路）；全部落空才判 LocatorMismatch。
    const cands = buildCandidates(page, { locator: locs as unknown as Locator[] });
    if (cands.length > 0) {
      let hitCount = 0;
      let hitDesc = '';
      const misses: string[] = [];
      const missSeen = new Set<string>();
      poll: for (let round = 0; round < LOCATOR_PROBE_ROUNDS; round++) {
        if (round > 0) await page.waitForTimeout(LOCATOR_PROBE_INTERVAL_MS);
        for (const c of cands) {
          const desc = c.src ?? c.kind;
          const probe = c.loc as unknown as { count?: () => Promise<number> };
          if (!probe || typeof probe.count !== 'function') {
            // 没有 count() 的候选直接接受（与回放 tryFirstMatch 一致）
            hitCount = 1;
            hitDesc = `${c.kind} ${desc}`;
            break poll;
          }
          try {
            const n = await probe.count();
            if (n > 0) {
              hitCount = n;
              hitDesc = `${c.kind} ${desc}`;
              break poll;
            }
            const msg = `${c.kind}=${desc} 命中 0 个元素`;
            if (!missSeen.has(msg)) { missSeen.add(msg); misses.push(msg); }
          } catch (e) {
            // 探测异常（选择器不合法）按该候选落空处理——回放对 count 异常同样捕获后继续下一候选
            const msg = `${c.kind}=${desc} 探测异常: ${(e as Error).message.slice(0, 80)}`;
            if (!missSeen.has(msg)) { missSeen.add(msg); misses.push(msg); }
          }
        }
      }
      if (hitCount === 0) {
        return { reason: 'LocatorMismatch', message: `compiled 定位校验不通过（回放将失败）: ${a.kind} 全部 ${cands.length} 个候选均未命中 — ${misses.join('；')}` };
      }
      if ((a.kind === 'click' || a.kind === 'fill' || a.kind === 'hover') && hitCount > 1) {
        return {
          reason: 'AmbiguousLocator',
          message: `compiled 定位校验不通过（候选命中多个元素）: ${a.kind} 候选 ${hitDesc} 命中 ${hitCount} 个元素，回放将静默操作其中第一个——请给该候选加属性过滤（如 [placeholder=...]）或把唯一命中的候选提到首位后重验`,
        };
      }
    }
  }
  return null;
}

/** 单步执行指令：自然语言 + compiled 参考 + 占位符凭据段（仅配置了 login 时）+ 输出契约。
 *  solidify_case 复用同一提示词协议（AI 相执行 + 占位符凭据注入）。
 *  webManifest：环境可用 web 服务清单（renderWebResourceManifest 产出）——有命名 web 时注入，
 *  让模型知道每个服务各自的凭据占位符形态（@name），而不是只知道一个裸占位符。 */
export function buildStepInstruction(
  step: { order: number; instruction: string | null; compiled: unknown; assertion: unknown },
  total: number,
  sec: { hasLogin: boolean; hasSecret: boolean },
  droppedAssertion?: string | null,
  webManifest?: string,
): string {
  const lines: string[] = [];
  lines.push('你是网页测试执行器，在当前浏览器页面上完成下面这一步测试操作，完成后按输出契约结束。');
  lines.push('');
  lines.push(`## 步骤（第 ${step.order} 步 / 共 ${total} 步）`);
  lines.push(`- 自然语言：${step.instruction ?? '（无，以编译动作为准）'}`);
  lines.push('- 编译动作（compiled DSL，供参考；若页面实际与它不符，以实际页面为准自行调整）：');
  lines.push(JSON.stringify(step.compiled));
  if (droppedAssertion) {
    // 判定为描述性短语的断言已被丢弃：不写「预期结果」行，改为如实告知，
    // 免得 AI 自行完成操作后又去核实一个页面上根本不存在的文案。
    lines.push(`- 断言：已忽略（原预期「${droppedAssertion}」是描述状态的短语而非页面文案，页面上不会有这段文字）。仅完成上面的操作即可，不要为它编造失败理由。`);
  } else if (step.assertion != null) {
    lines.push(`- 断言（预期结果，完成后自行核实）：${JSON.stringify(step.assertion)}`);
  }
  if (sec.hasLogin) {
    lines.push('');
    lines.push('## 登录凭据');
    lines.push('若当前页面是登录页（由你根据页面内容自行判断），先用占位符完成登录再执行本步：');
    // 有命名 web 服务时逐服务点名占位符形态；否则退回裸占位符（走三级默认链）。
    if (webManifest) {
      lines.push('## 本次可用的 web 服务');
      lines.push(webManifest);
      lines.push(`- 用户名输入框 fill 的 value 用字面量 ${credentialPlaceholder('user', '<服务名>')}`);
      lines.push(`- 密码输入框 fill 的 value 用字面量 ${credentialPlaceholder('password', '<服务名>')}`);
      lines.push('- 「未配置凭据」的服务不要尝试登录（必然失败）；需要跨系统时用对应服务名做归属。');
    } else {
      lines.push(`- 用户名输入框 fill 的 value 用字面量 ${USER_PH}`);
      lines.push(`- 密码输入框 fill 的 value 用字面量 ${PASSWORD_PH}`);
    }
    lines.push('平台会把占位符替换为真实值；你不得猜测、拼接或输出真实凭据。');
    lines.push('登录后若出现强制改密/绑定等弹窗，按页面提示处理（能跳过则跳过）后继续本步。');
  }
  if (sec.hasSecret) {
    lines.push(`本步含加密敏感字段，填入时 value 一律用字面量 ${SECRET_PH}（平台替换为真实值，你不得猜测）。`);
  }
  lines.push('');
  lines.push('## 输出契约');
  lines.push('done.summary 必须是该 JSON 对象序列化后的文本：');
  lines.push('{"status":"passed"|"failed","reason":"<一句话中文>","login":"logged-in"|"not-needed"}');
  lines.push('- passed：本步操作（含触发的登录）已按页面实际状态完成；failed 写清原因。');
  lines.push('- login：本轮你实际执行了登录填表并提交 → 必须填 "logged-in"（即使登录发生在本步骤开头）；确实没有登录任何表单 → "not-needed"。');
  lines.push('中途无法继续时直接输出 {"fail":"原因"}。');
  return lines.join('\n');
}

export function buildVerifyCaseTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'verify_case',
    description:
      '在真实被测系统上逐步验证用例的 compiled 步骤可执行性。全 AI 驱动：模型看截图与元素清单自主操作浏览器，登录/验证码/弹窗由模型按页面实际状态自主处理，失败即停并返回失败步骤详情与失败页可交互元素清单。AI 步骤与终态判定全过后，还会用与正式回放同引擎的机械干跑逐字执行 compiled（failureReason=ReplayDivergence 表示 AI 能过但逐字回放分叉）。mode 决定验收形态：mode="full"（默认）= 全 AI 实测（AI 相 + 终态判定 + 机械干跑），实测通过时顺带缓存每步的 AI 动作轨迹（供 solidify_case 零执行复用）；mode="mechanical" = 固化后的机械验收（跳过 AI 相，只做机械干跑 + 终态判定，语义验证已由前一轮实测完成）。caseId 支持两种形态：落库用例 id，或本线程 stage_case 生成的 localId（纯草稿验证，全程不落库，save 时才正式建用例）。依据清单修正 locator 后可再次调用（同一用例建议最多 3 轮）。再次调用会复用上一轮已确认的前缀：以机械回放重建前缀 DOM 状态（代替重跑 AI 相，已确认步骤不再烧 LLM 轮次），AI 相从首个改动/失败步续跑，结尾仍保留与正式回放同引擎的完整机械干跑。验证会产生真实副作用（与正式执行一致，机械干跑会再执行一遍）。',
    parameters: Type.Object({
      caseId: Type.String({ minLength: 1 }),
      // full=全 AI 实测（默认，含机械干跑）；mechanical=固化后机械验收（跳过 AI 相，只干跑+终态判定）
      mode: Type.Optional(Type.Union([Type.Literal('full'), Type.Literal('mechanical')])),
    }),
    promptGuidelines: [
      'verify_case 有两种使用场景，按需选择：(a) 讨论期实测——草稿讨论中用户要求「跑一下看看」时，对 stage_case 暂存的自然语言草稿调用（mode 省略即 full），AI 相执行 + live view 视频流给用户看，失败据 failure 修正步骤后重发 stage_case 再验；(b) 编译后验收——solidify_case 把自然语言编译为机械 DSL 后，对固化结果调用 verify_case(mode="mechanical")，跳过 AI 相只做机械干跑 + 终态判定，失败由你按归因修复 compiled 后重跑，直到通过。',
      'verify_case 的 mode 决定验收形态，别乱选：mode="full"（默认）是全 AI 实测，用于语义验证（讨论期实测、或 mechanical 连续两轮同因失败/归因不明时升级到它），实测通过会顺带缓存 AI 动作轨迹；mode="mechanical" 是固化后的机械验收，只跑机械干跑 + 终态判定，不烧 AI 轮次——**固化完成后用 mode="mechanical" 验收，别再跑一遍 full**。',
      'mode="mechanical" 的两个限制要如实告知用户：(1) 全视觉用例（无 compiled）会被直接拒绝——此时先调 mode="full" 实测；(2) 机械模式没有 AI 相、不会自动登录，靠登录态缓存（30 分钟）注入，副本重启或缓存过期会落到登录页——失败页是登录页就改 mode="full" 重测（顺带刷新登录态与轨迹缓存）。',
      'verify_case 全 AI 驱动：登录、验证码、改密弹窗等场景由模型自主判断处理；凭据以 __ITEST_USERNAME__ 等占位符注入执行，不会出现在任何输出中。',
      'verify_case 失败时：读取 failure.page.elements，只能用清单中真实存在的选择器修正对应步骤的 locator/动作，禁止臆造；修正走 stage_case_op 暂存后，直接再次调用 verify_case —— 本线程暂存的修改会自动叠加生效（响应 basedOn=staged），验证循环全程不要落库；全部步骤通过后,确认验证通过后再引导用户在右侧暂存区勾选统一保存。',
      'stage_case 新建的纯草稿用例（未落库）也可直接 verify_case：caseId 传 stage_case 时声明的 localId；修正循环 = 同 localId 重发 stage_case（幂等覆盖）后再次 verify_case，全程不落库，通过后引导用户在暂存区勾选保存。注意：暂存草稿的 defaultEnvId 只能绑定已落库环境或留空走默认链（暂存环境不支持）。',
      'verify_case 会校验 compiled 选择器能真实命中页面（AI 临场绕开坏 locator 不算通过，回放逐字执行 compiled 会失败）:失败原因含"定位校验不通过"时,必须用 failure.page.elements 里的真实选择器替换原 locator(严禁留着坏 locator 只靠 AI 硬跑)。候选命中多个元素(AmbiguousLocator)同样判失败——回放会静默操作第一个匹配元素,必须给该候选加属性过滤(如 [placeholder=...])或把唯一命中的候选提到首位。verify_case 还会做用例级终态判定(失败原因含 VisionAssertionFailed):步骤都通过但最终页面不符 expectedOutcome 时,修正步骤行为或调整 expectedOutcome 后再验。',
      '终态判定失败(failureReason=VisionAssertionFailed)且 failure.note 含"空数据信号"时,说明被测环境里根本没有可供断言的数据——这是用例缺前置造数步骤,不是选择器写错。正确做法:给用例补上"先造出满足预期的数据"的步骤(如创建一条会触发自动处置的事件),或如实告诉用户环境缺数据。严禁弱化 expectedOutcome 把失败蒙成通过(例:把"自动启动处置成功"改成"页面正常加载"、删掉断言步骤)——那是把用例改得测不出东西,比失败更糟。',
      'result.staticAnalysis 与 failure.note 里的"源码无字面命中"只是排序参考,不是"这个选择器是假的"。选择器是否存在一律以 failure.page.elements 和运行时实测为准:框架运行时拼接的 id(如 Element-UI tab 的 #tab-autodo)源码里本就没有字面量,但运行时真实命中。sourceAnalysis 与运行时命中冲突时,信运行时。',
      'verify_case 最后一道关卡是与正式回放同引擎的 compiled 机械干跑(failureReason=ReplayDivergence):AI 临场能跑通但逐字派发 compiled 失败,典型如 click 落在组件 wrapper 上不触发实际行为、唯一名冲突导致二次执行必挂。修正方式:用 failure.page.elements 里的真实选择器把失败步 compiled 改成更精确的可操作目标(点组件内部真实接收点击的元素),或修正测试数据策略(时间戳命名)后重验。',
      'verify_case 失败反馈带 failure.evidence(可见浮层清单 overlays + 各 locator 候选实时命中数 probes)与 failure.note 里的「⚠ 归因:」段——归因由 LLM 依据形态无关证据判断,先按归因再动手,不要一律当选择器错:(1) 归因=「条件性浮层」:失败页有可见弹窗/抽屉/遮罩,属数据状态才弹的对话框(草稿恢复/权限确认),机械步骤处理不了「可能弹、可能不弹」的分支:在进该页步骤之后补 aiTask 条件兜底步骤(若页面出现浮层则按页面提示关闭或点『确定/继续』,没有则跳过),不要反复改选择器也不要弱化预期;(2) 归因=「位置/流程断裂」:该步全部候选命中 0 且失败页元素清单里也没有同类目标,说明界面根本没挂载,选择器无法命中不存在的元素:去核对导航/入口/向导步骤流程(草稿恢复把向导恢复到中间态即一例),修步骤顺序或补导航,不要改 locator;(3) 归因=「选择器/行为错」:页面状态到位仅该 locator 未命中,才用 failure.page.elements 里真实存在的选择器修正(可组多候选链);(4) 归因=「环境缺数据」:先让用例造出满足预期的数据,或如实汇报,严禁弱化 expectedOutcome。归因未产出(failure.note 无「⚠ 归因:」段)时按既有通用文案结合 failure.evidence 判断,必要时用 repo_grep 翻目标页面源码确认弹窗/向导条件,不要臆测固定文案。',
      '同一用例验证最多重试 3 轮；仍失败则保留用例，如实向用户说明失败步骤与原因，不要无限循环。',
      '环境未配置登录凭据(默认 web 服务未填用户名/密码)而验证卡在登录页时，引导用户到项目环境页配置，不要伪造登录步骤。',
    ],
    execute: async (input) => {
      const { caseId, mode } = input as { caseId: string; mode?: 'full' | 'mechanical' };
      // ── 空转硬约束：同一用例同因连续失败达上限即强制停止（prompt 指南对 agent 不硬,这里真正拦截）──
      // 失败签名未变即无进展：环境缺前导数据/被测页面持续不稳定这类前置问题重试再多轮也只重复烧 LLM,
      // 直接短路返回把结论交给 agent 如实汇报。触发后将计数回退到上限-1——下一次调用允许正常跑一轮：
      // 仍同因失败会再次触发停止（强制停止之间至多放行 1 次实测）,已修复则通过清除计数,不会永久死锁。
      const roundState = verifyRoundState.get(roundKey(ctx.threadId, caseId));
      if (roundState && roundState.consecutive >= VERIFY_MAX_STAGNANT_ROUNDS) {
        verifyRoundState.set(roundKey(ctx.threadId, caseId), {
          lastSignature: roundState.lastSignature,
          consecutive: VERIFY_MAX_STAGNANT_ROUNDS - 1,
        });
        return {
          ok: true,
          data: JSON.stringify({
            result: 'failed',
            caseId,
            failure: {
              stepOrder: -1,
              action: null,
              error: null,
              failureReason: 'StagnantRoundLimit',
              humanMessage: `同一失败原因已连续 ${VERIFY_MAX_STAGNANT_ROUNDS} 轮无任何进展，本次已强制停止验证。这通常是环境前置数据缺失、被测页面持续不稳定或用例存在前置依赖——重复实测无法解决。请停止继续 verify_case,把已验证步骤结果与失败原因如实汇报给用户,并引导检查环境数据 / 页面可用性;环境就绪后再验证会正常继续。`,
              note: 'verify_case 同因失败轮次上限触发强制停止,防止在无进展状态下空转消耗 LLM 调用。',
            },
          }),
        };
      }
      // 最外层兜底：db 查询 / chromium launch / resolveCaseUrl 等未预料异常一律转 ok:false
      // （ToolExecutor 契约：不向 agent 循环抛异常）
      try {
        // ── 前置校验（不启动浏览器）──
        // caseId 双形态：落库用例 id，或本线程 stage_case 的 localId（纯草稿——验证全程不落库，save 时才正式建 case/steps）
        const dbCase = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
        let stagedCase: typeof aiStageCases.$inferSelect | null = null;
        if (!dbCase) {
          stagedCase =
            (await db.select().from(aiStageCases)
              .where(and(eq(aiStageCases.threadId, ctx.threadId), eq(aiStageCases.localId, caseId))))[0] ?? null;
          if (!stagedCase) {
            return { ok: false, error: `用例不存在: ${caseId}（既非落库用例，也非本线程暂存草稿）` };
          }
        }
        if (dbCase?.platform === 'mobile') {
          return { ok: false, error: 'verify_case 暂不支持移动端用例（v1 仅支持 web）' };
        }
        // 执行所需元数据两种来源对齐到同一形状；草稿无 groupId（无分组默认 URL 链）、无 platform（暂存仅 web）
        // 注意不能用 dbCase?.x ?? stagedCase!.x 合并——dbCase 存在而字段为 null 时会落到 stagedCase!.x 空引用
        const caseMeta = dbCase
          ? {
              title: dbCase.title,
              url: dbCase.url,
              expectedOutcome: dbCase.expectedOutcome,
              defaultEnvId: dbCase.defaultEnvId,
              versionId: dbCase.versionId,
              // 用例绑定的 web 服务名：无 @ref 占位符的凭据归属（与执行层同一把尺）。
              webServiceRef: dbCase.webServiceRef ?? null,
            }
          : {
              title: stagedCase!.title,
              url: stagedCase!.url ?? null,
              expectedOutcome: stagedCase!.expectedOutcome ?? null,
              defaultEnvId: stagedCase!.defaultEnvId ?? null,
              versionId: stagedCase!.versionId,
              // 暂存表无 web_service_ref 列（stage_case 暂不涉及 web 绑定），草稿恒走默认链。
              webServiceRef: null,
            };
        const steps: EffectiveStep[] = dbCase
          ? await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order))
          : (stagedCase!.steps as Array<{ action?: unknown; assertion?: unknown; compiled?: unknown }>).map((s, i) => ({
              id: `staged-${i + 1}`,
              order: i + 1,
              instruction: typeof s.action === 'string' ? s.action : null,
              compiled: Array.isArray(s.compiled) ? s.compiled : null,
              assertion: typeof s.assertion === 'string' ? s.assertion : null,
              // 暂存步骤本无 sensitive/密文字段（save 映射也只带 instruction/assertion/compiled），与落库路径的虚拟插入步对齐
              sensitive: false,
              delayMs: null,
              secretCiphertext: null,
              secretIv: null,
              secretTag: null,
            }));
        if (steps.length === 0) return { ok: false, error: '用例没有可验证的步骤' };

        // ── 暂存叠加：本线程已暂存的 stage_case_op 虚拟应用到 DB 用例上,验证基于暂存状态继续——
        //    失败→暂存修正→直接重验的循环全程不落库,全部通过后用户在暂存区统一保存 ──
        //    （纯草稿没有 DB caseId 可供 op 挂载，修正循环 = 同 localId 重发 stage_case 覆盖后再验）
        let effectiveSteps = steps;
        const overlayPatches: { url?: string | null; defaultEnvId?: string | null } = {};
        let opsApplied = 0;
        if (dbCase) {
          const stagedOps = await db
            .select({ op: aiStageCaseOps.op, payload: aiStageCaseOps.payload })
            .from(aiStageCaseOps)
            .where(and(eq(aiStageCaseOps.threadId, ctx.threadId), eq(aiStageCaseOps.caseId, caseId)))
            .orderBy(asc(aiStageCaseOps.stagedAt));
          const overlay = computeCaseOverlay(steps, stagedOps);
          if (overlay.deleteStaged) {
            return { ok: false, error: '用例已暂存删除，请先在暂存区取消删除（或落库）后再验证' };
          }
          if (overlay.steps) effectiveSteps = overlay.steps;
          if (overlay.url !== undefined) overlayPatches.url = overlay.url;
          if (overlay.defaultEnvId !== undefined) overlayPatches.defaultEnvId = overlay.defaultEnvId;
          opsApplied = overlay.opsApplied;
        }
        if (effectiveSteps.length === 0) return { ok: false, error: '用例没有可验证的步骤' };
        const effectiveCase = { ...caseMeta, ...overlayPatches };
        // 全局看门狗预算随有效步数缩放：慢 SUT 上每步 AI 相渐进累计，固定预算装不下多步用例
        const verifyTimeoutMs = computeVerifyTimeoutMs(effectiveSteps.length);

        // ── 前缀确认决策（Problem 1：跨轮砍 AI 相前缀重跑，保留结尾完整机械回放）──
        // validPrefixLen>0 表示上轮已确认、且本步骤未变/环境未换的前缀条数。本轮用机械回放重建
        // 前缀 DOM 状态后，AI 相从该处续跑；restore 失败则收敛到失败步由 AI 接管。
        const ckey = roundKey(ctx.threadId, caseId);
        const curStepsHash = hashEffectiveSteps(effectiveSteps);
        const curMetaHash = hashVerifyMeta({
          url: effectiveCase.url,
          defaultEnvId: effectiveCase.defaultEnvId,
          versionId: effectiveCase.versionId,
        });
        // ── 机械验收模式（mode='mechanical'）：solidify 固化后的验收专用 ──
        // AI 相的语义验证已在实测轮完成，本模式只做 compiled 机械干跑 + 终态判定；
        // 无 compiled 的视觉用例无从逐字派发 → 拒绝并引导 full（实测轮顺带收集 solidify 轨迹）。
        if (mode === 'mechanical' && isAllVisualSteps(effectiveSteps)) {
          return {
            ok: false,
            error: 'mechanical 模式验收的是 compiled 的机械可回放性：当前用例全部步骤都是视觉模式（无 compiled）。请改调 verify_case(mode="full") 做全 AI 实测（通过后会顺带缓存可被 solidify_case 零执行复用的实测轨迹）。',
          };
        }
        const prevConfirm = verifyConfirmCache.get(ckey) ?? null;
        let validPrefixLen = 0;
        if (prevConfirm && mode !== 'mechanical') {
          if (prevConfirm.metaHash !== curMetaHash) {
            validPrefixLen = 0; // 换被测对象(SUT/环境/版本)，前缀全部失效
          } else {
            let d = -1;
            for (let i = 0; i < effectiveSteps.length; i++) {
              if (prevConfirm.stepsHash[i] !== curStepsHash[i]) { d = i; break; }
            }
            validPrefixLen = Math.min(prevConfirm.confirmedThrough, d === -1 ? effectiveSteps.length : d);
          }
        }
        const prefixConfirmedResults: AiStepResult[] = prevConfirm?.confirmedStepResults.slice(0, validPrefixLen) ?? [];

        // ── LLM 前置检查（全 AI 驱动的硬前提；未配置直接失败，用户去设置页配置）──
        let client: Awaited<ReturnType<typeof resolveLlmClient>>['client'];
        try {
          client = (await resolveLlmClient()).client;
        } catch (e) {
          return { ok: false, error: `LLM 未配置，无法执行 AI 验证: ${(e as Error).message}` };
        }

        // ── 环境解析（case defaultEnv > version link > 项目默认）──
        let envCtx: Awaited<ReturnType<typeof resolveEnv>>;
        try {
          envCtx = await resolveEnv(
            { caseEnvId: effectiveCase.defaultEnvId ?? null, versionId: effectiveCase.versionId ?? ctx.versionId },
            { expectedProjectId: ctx.projectId },
          );
        } catch (e) {
          const errName = e instanceof Error ? e.name : '';
          if (errName === 'EnvMissing') return { ok: false, error: '缺少环境配置，请到项目环境页配置默认环境' };
          if (errName === 'EnvProjectMismatch') return { ok: false, error: '环境所属项目与当前用例不匹配' };
          return { ok: false, error: `环境解析失败: ${(e as Error).message}` };
        }
        // 提示词里的 web 服务清单（只含 name/origin/有无凭据，绝不含真实值）——环境解析后才有，
        // 故在这里算一次，逐步骤复用。
        const webManifest = (() => {
          try { return renderWebResourceManifest({ envCtx }); } catch { return ''; }
        })();

        // ── L1 源码静态预检（advisory，不判死）──
        // 仓库就绪即自动尝试：全用例候选一次性批量查源码（单次 rg 遍历树），得到
        // unique/multiple/not-found/dynamic-suspect，进 verify_progress.staticNote +
        // result.staticAnalysis + 失败 note。
        // 「静态排行，运行时拍板」：静态事实不改变任何通过/失败判决，只做上下文；
        // repo 未配置/检出中/工具异常 → 静默降级为现行纯运行时行为，零回归。
        const staticByStep: StaticLocatorReport[][] = [];
        const staticAnalysis: Array<{ order: number; note: string }> = [];
        if (ctx.repo.cwd) {
          try {
            const cwd = repoToolCwd(ctx.repo);
            // 先把所有步骤的候选摊平，一次批量计数——跨步骤重复的 pattern（如多个 fill 共用
            // [placeholder="账号"]）只查一次；逐步骤查询则是每步都重扫一遍树。
            const stepLocs = effectiveSteps.map((s) => collectStepLocators(s.compiled));
            const flat = stepLocs.flat();
            const allReports = flat.length > 0
              ? await analyzeLocatorCandidatesBatch(flat, (patterns) => countRepoGrepBatch(cwd, patterns))
              : [];
            let cursor = 0;
            for (let i = 0; i < stepLocs.length; i++) {
              const reports = allReports.slice(cursor, cursor + stepLocs[i]!.length);
              cursor += stepLocs[i]!.length;
              staticByStep.push(reports);
              const note = summarizeStaticReports(reports);
              if (note) staticAnalysis.push({ order: effectiveSteps[i]!.order, note });
            }
          } catch {
            // 仓库工具异常表面化前静默降级：静态分析是增强，不是依赖
          }
        }
        const staticNote = staticAnalysis.length > 0
          ? `源码静态分析:${staticAnalysis.map((a) => `步骤#${a.order} ${a.note}`).join(' | ')}`
          : null;

        // ── 浏览器 + watchdog → 逐步骤 AI 驱动执行（fail-stop）──
        let browser: Browser | undefined;
        let live: ReturnType<typeof registerLiveView> | undefined;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (browser) void browser.close().catch(() => undefined);
        }, verifyTimeoutMs);
        try {
          // resolveCaseUrl 可能抛 WebServiceMissing(相对 url 但环境无 web 服务),放进本 try 让 finally
          // 的 envCtx.close 兜底(异常路径也不泄漏连接池)。
          // 草稿无分组，share null groupId:resolveCaseUrl 在传 envCtx 时只用 resolveWebOrigin 拼相对路径,
          // 相对 url(/开头)→默认 web 服务 origin + path;绝对直通;空 → 默认 origin(空 url 无服务则 null)。
          const resolvedUrl = await resolveCaseUrl(
            {
              url: effectiveCase.url,
              // 草稿无 DB 行:groupId 传 envCtx 时未被使用(仅 defaultEnvFallback 的 displayWebEnv 需要),填空串;
              // webServiceRef 草稿无法绑定命名服务 → null 走默认 web 服务。
              groupId: stagedCase ? '' : dbCase!.groupId,
              webServiceRef: stagedCase ? null : (dbCase!.webServiceRef ?? null),
            },
            { envCtx },
          );
          const targetUrl = resolvedUrl && /^https?:\/\//.test(resolvedUrl) ? resolvedUrl : undefined;
          browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
          // 命中登录态缓存则注入 context:同环境重试轮/后续用例免登录（过期自愈,见 loginStateCache）
          const loginKey = loginStateKey(envCtx.envId, envCtx.login?.user);
          const cachedState = getLoginState(loginKey);
          const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            viewport: { width: 1280, height: 800 },
            ...(cachedState ? { storageState: cachedState } : {}),
          });
          let page = await context.newPage();
          // playground 实时画面：注册页面源，start 事件把流地址带给前端进度卡；finally close 结束流
          live = registerLiveView();
          live.setPage(page);

          const reportId = `verify-${randomUUID()}`;
          // 断言判定缓存重建：resume 轮前缀步跳过 judge，但 restore/结尾完整回放都要用
          // droppedAssertions 把描述性短语断言排除在机械判定之外——从上一轮判定缓存恢复。
          const droppedAssertions = new Map<string, string>();
          if (prevConfirm) {
            if (mode === 'mechanical') {
              // 机械模式无 AI 相跑不了 judgeAssertionText：仅当环境与该步内容都与判定轮
              // 完全一致时才复用 dropped 判定；没复用到的断言按字面进机械回放（失败 note
              // 会提示改 full 复核）。
              if (prevConfirm.metaHash === curMetaHash) {
                effectiveSteps.forEach((s, i) => {
                  if (prevConfirm.stepsHash[i] !== curStepsHash[i]) return;
                  const v = prevConfirm.assertionVerdicts.get(s.id);
                  if (v && !v.real && v.dropped) droppedAssertions.set(s.id, v.dropped);
                });
              }
            } else {
              for (const [stepId, v] of prevConfirm.assertionVerdicts) {
                if (!v.real && v.dropped) droppedAssertions.set(stepId, v.dropped);
              }
            }
          }
          /** 机械回放步映射（restore 与结尾完整回放共用）：dropped 断言在回放里不参与判定。 */
          const mapForReplay = (s: EffectiveStep) => ({
            order: s.order,
            assertion: droppedAssertions.has(s.id) ? null : s.assertion,
            delayMs: s.delayMs,
            id: s.id,
            sensitive: s.sensitive,
            compiled: Array.isArray(s.compiled) ? s.compiled : null,
          });
          // 敏感字段解密表：restore 与结尾完整回放共用（解密失败会抛，与原有最终回放语义一致）
          const replaySecrets = buildReplaySecrets(effectiveSteps);

          // ── 前缀状态重建（resume）：机械回放已确认前缀，把浏览器恢复到第 validPrefixLen 步的 DOM 状态 ──
          // executeCaseInBrowser 内部自建 page 并 goto(targetUrl)，成功/失败都把它交还（onPageReady /
          // onFailurePage），后续 AI 相与证据采集继续用该 page。restore 失败 → 收敛到失败步由 AI 接管
          // （机械回放失败不判死：AI 临场可能自适应绕过）。
          let resumeIndex = validPrefixLen;
          if (validPrefixLen > 0) {
            let restoredPage: Page | null = null;
            const restoreSlice = effectiveSteps.slice(0, validPrefixLen);
            const restoreRes = await executeCaseInBrowser(
              caseId,
              restoreSlice.map(mapForReplay),
              {
                reportId: `${reportId}-restore`,
                envCtx,
                llmClient: client,
                liveView: live,
                // 不传 expectedOutcome：restore 只做前缀状态重建，vision 终态判定留给主流程
                ...(replaySecrets.size > 0
                  ? { secretResolver: async (stepId: string) => replaySecrets.get(stepId) ?? null }
                  : {}),
                onPageReady: (p) => { restoredPage = p; },
              },
              browser,
              context,
              targetUrl,
              undefined,
              undefined,
              undefined,
              // restore 失败现场即 AI 续跑起点（切片步下标 == 全局下标：切片自 0 起）
              async (p, j) => { restoredPage = p; resumeIndex = j; },
            );
            if (restoreRes.some((r) => r.status === 'failed')) {
              const j = restoreRes.findIndex((r) => r.status === 'failed');
              resumeIndex = j < 0 ? validPrefixLen : j;
            }
            if (restoredPage) page = restoredPage;
          }

          // 初始导航（仅非 resume：resume 时 restore 已完成导航；mechanical 跳过——干跑
          // executeCaseInBrowser 自带 goto，预导航只是多一次页面加载与副作用）
          if (mode !== 'mechanical' && validPrefixLen === 0 && targetUrl) {
            const firstCompiled = effectiveSteps[0]?.compiled;
            const firstAction = (Array.isArray(firstCompiled) && firstCompiled.length > 0
              ? firstCompiled[0]
              : undefined) as { kind?: string; url?: string } | undefined;
            const skipInit = firstAction?.kind === 'navigate' && firstAction.url === targetUrl;
            if (!skipInit) {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
            }
          }

          // 占位符 → 真实值。凭据替换复用执行层唯一实现（@ref 归属 / 缺凭据 fail-fast
          // 语义与回放完全一致——两处各写一套字面量精确匹配正是 2026-10-21 prod228 的分叉根因）。
          let stepSecret: string | undefined;
          // 每次取值都重新构造源：stepSecret 逐步骤解密后才赋值，构造时快照会把敏感值冻在 undefined。
          const valueSub = (v: string): string =>
            makeCredentialValueSub(
              buildCredentialSource({ envCtx, caseWebServiceRef: effectiveCase.webServiceRef }, stepSecret),
            )(v);

          const stepResults: AiStepResult[] = [];
          /** 本轮 AI 相收集的可固化步骤动作轨迹（solidify_case 零执行复用的数据源）。
           *  前缀步（[0, validPrefixLen)）本轮由机械恢复执行、无 AI 动作，其轨迹从上一轮
           *  确认缓存携带（validPrefixLen 的判定已保证这些步内容未变，旧轨迹仍有效）；
           *  本轮 AI 相实际执行的步就地覆盖。合并后整轮全过即得完整轨迹。 */
          const collectedTrace = new Map<string, AiAction[]>();
          if (prevConfirm && validPrefixLen > 0) {
            for (let i = 0; i < validPrefixLen; i++) {
              const id = effectiveSteps[i]!.id;
              const carried = prevConfirm.confirmedTraces.get(id);
              if (carried) collectedTrace.set(id, carried);
            }
          }
          /** 本轮 AI 相产生的断言判定（写回上一轮缓存，续跑前逐步复用）。 */
          const verdictsThisRound = new Map<string, { real: boolean; dropped?: string }>();
          // 全局看门狗超时收尾（步骤中断 / 机械回放中断共用）：把本地已完成前缀写回缓存——
          // 否则下轮从头重跑，已确认步骤全丢（Problem 1 续跑设计被架空）。错误带完成步数，
          // 下轮 resume 从中断步续跑而非从第 1 步重来。stepResults 局部下标自 resumeIndex 起，
          // 完成条数 = resumeIndex（沿用上轮确认的前缀） + stepResults.length（本轮实走）。
          const commitTimeoutPrefix = (where: string): { ok: false; error: string } => {
            // 机械模式没有 AI 相，无可续跑前缀可写（也不覆盖上一轮 full 的判定缓存）
            if (mode === 'mechanical') {
              return { ok: false, error: `验证超时（${verifyTimeoutMs / 1000}s）已终止：${where}（mechanical 模式无 AI 相前缀，下轮从头上）` };
            }
            const merged = new Map<string, { real: boolean; dropped?: string }>(prevConfirm?.assertionVerdicts ?? []);
            for (const [id, v] of verdictsThisRound) merged.set(id, v);
            const completed: AiStepResult[] = [...prefixConfirmedResults.slice(0, resumeIndex), ...stepResults];
            verifyConfirmCache.set(ckey, {
              stepsHash: curStepsHash,
              metaHash: curMetaHash,
              confirmedThrough: completed.length,
              assertionVerdicts: merged,
              confirmedStepResults: completed,
              confirmedTraces: collectedTrace,
            });
            return { ok: false, error: `验证超时（${verifyTimeoutMs / 1000}s）已终止：已完成 ${completed.length}/${effectiveSteps.length} 步（${where}），后续轮次将从中断步 resume 续跑` };
          };
          let failedIndex = -1;
          let login: 'logged-in' | 'not-needed' = 'not-needed';
          // SSE 实时进度：验证全程可达数分钟，前端凭这些事件渲染逐步进度卡（spaceEventsStore.verify_progress）。
          // loginCache/loginUser：登录态缓存命中与凭据用户直显对话框，无需翻服务端日志即可确认复用生效。
          ctx.emit({
            type: 'verify_progress', phase: 'start', caseId, total: effectiveSteps.length, targetUrl: targetUrl ?? null,
            resumeFrom: validPrefixLen,
            ...(mode === 'mechanical' ? { mode: 'mechanical' as const } : {}),
            loginCache: cachedState ? ('hit' as const) : ('miss' as const),
            loginUser: envCtx.login?.user ?? null,
            stagedOps: opsApplied,
            ...(staticNote ? { staticNote } : {}),
            liveUrl: `/api/assistant/threads/${ctx.threadId}/live/${live.key}`,
          });
          // mechanical 模式跳过整个 AI 相（循环下标直接置越界，语义验证已由实测轮完成）
          for (let i = mode === 'mechanical' ? effectiveSteps.length : resumeIndex; i < effectiveSteps.length; i++) {
            const s = effectiveSteps[i]!;
            const started = Date.now();
            // 轨迹收集目标：视觉模式且非敏感的步骤（与 solidify_case 的固化候选同口径）
            const solidifiable = isVisualStep(s) && !s.sensitive;
            let stepActions: AiAction[] = [];

            // 敏感步骤先解密：密文缺失/解密失败直接判该步失败，不让 LLM 乱填
            stepSecret = undefined;
            if (s.sensitive) {
              if (!s.secretCiphertext || !s.secretIv || !s.secretTag) {
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: 'sensitive 步骤缺少密文（secret-missing）', failureReason: 'SecretMissing',
                });
                ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: 'sensitive 步骤缺少密文' });
                failedIndex = i;
                break;
              }
              try {
                stepSecret = decrypt({
                  ciphertext: Buffer.from(s.secretCiphertext, 'base64'),
                  iv: Buffer.from(s.secretIv, 'base64'),
                  tag: Buffer.from(s.secretTag, 'base64'),
                });
              } catch {
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: '敏感字段解密失败（secret-decrypt）', failureReason: 'SecretMissing',
                });
                ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: '敏感字段解密失败' });
                failedIndex = i;
                break;
              }
            }

            if (s.delayMs) await page.waitForTimeout(s.delayMs);
            // 断言文本体检：描述性短语（「登录表单正常展示」）页面上永远匹配不到，
            // 在真实页面上判一次，判为描述性就本轮不带它进指令，也不进机械回放。
            let assertionForRun: unknown = s.assertion;
            let droppedAssertion: string | null = null;
            if (typeof s.assertion === 'string' && s.assertion.trim()) {
              const pageText = await page
                .evaluate(() => document.body?.innerText ?? '')
                .catch(() => '');
              const verdict = await judgeAssertionText(s.assertion, pageText, client, ctx.lang);
              // 判定写回本轮缓存：续跑轮的前缀步按上一轮判定复用（mechanical restore 不再逐轮 judge）
              verdictsThisRound.set(s.id, { real: verdict.real, ...(verdict.real ? {} : { dropped: s.assertion }) });
              if (verdict.real) {
                // 上一轮判定为描述性短语、本轮改判为真实页面文案：清除老旧 dropped 记录，
                // 否则机械回放会沿用 null 掉该断言（本轮 AI 相照常带它，回放却跳过——不一致）。
                droppedAssertions.delete(s.id);
              } else {
                assertionForRun = null;
                droppedAssertion = s.assertion;
                droppedAssertions.set(s.id, s.assertion);
              }
            }
            const instruction = buildStepInstruction(
              { order: s.order, instruction: s.instruction, compiled: s.compiled, assertion: assertionForRun },
              effectiveSteps.length,
              { hasLogin: !!envCtx.login, hasSecret: stepSecret !== undefined },
              droppedAssertion,
              webManifest,
            );
            ctx.emit({
              type: 'verify_progress', phase: 'step_start', order: s.order,
              brief: (s.instruction ?? JSON.stringify(s.compiled) ?? '').slice(0, 120),
            });
            // compiled 保真前置校验：click/hover 的目标元素此刻就该在页面上，解析不到直接判失败（不烧 AI 轮次）
            const preErr = await checkCompiledLocators(page, s.compiled, 'pre');
            if (preErr) {
              stepResults.push({
                order: s.order, status: 'failed', durationMs: Date.now() - started,
                error: preErr.message, failureReason: preErr.reason,
                screenshot: await writeStepScreenshot(reportId, i + 1, page),
              });
              ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: preErr.message.slice(0, 120) });
              failedIndex = i;
              break;
            }
            let aiRun: Promise<string> | undefined;
            let guardTimer: NodeJS.Timeout | undefined;
            try {
              // 单步 AI 相秒级帽子：runAiTask 只按轮数受限（STEP_MAX_TURNS）无墙钟上限，慢 SUT 上一轮
              // 拖到分钟级就会吃光整个全局预算。帽子触发 → fail-stop 该步（StepTimedOut），在途 aiRun 放弃
              // （catch 里吞掉其 rejection，浏览器最终收尾关闭）。
              aiRun = runAiTask(page, instruction, client, false, {
                maxTurns: STEP_MAX_TURNS,
                valueSub,
                lang: ctx.lang,
                // 成功动作按执行顺序收集（占位符替换前的原始参数，同 solidify_case 口径）
                onAction: (action, ok) => {
                  if (solidifiable && ok) stepActions.push(action);
                },
              });
              const stepGuard = new Promise<never>((_, reject) => {
                guardTimer = setTimeout(() => reject(new Error(`STEP_TIMEOUT:${s.order}`)), STEP_AI_TIMEOUT_MS);
              });
              const summary = await Promise.race([aiRun, stepGuard]);
              clearTimeout(guardTimer);
              const parsed = tryParseJson(summary);
              if (parsed && parsed.status === 'failed') {
                // LLM 自报失败：fail-stop，原因直达反馈
                const reason = typeof parsed.reason === 'string' ? parsed.reason : summary.slice(0, 200);
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: reason, failureReason: 'StepReportedFailed',
                  screenshot: await writeStepScreenshot(reportId, i + 1, page),
                });
                ctx.emit({
                  type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: reason.slice(0, 120),
                  ...(typeof parsed?.login === 'string' ? { login: parsed.login } : {}),
                });
                failedIndex = i;
                break;
              }
              if (parsed?.login === 'logged-in') login = 'logged-in';
              // compiled 保真后置校验：assert*/fill/check/select/extract 结束时元素理应仍在；
              // AI 可以临场绕开坏 locator，但回放逐字执行 compiled——此刻校验不过，回放必挂
              const postErr = await checkCompiledLocators(page, s.compiled, 'post');
              if (postErr) {
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: postErr.message, failureReason: postErr.reason,
                  screenshot: await writeStepScreenshot(reportId, i + 1, page),
                });
                ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: postErr.message.slice(0, 120) });
                failedIndex = i;
                break;
              }
              // 该步全过（含 post-locator 校验）才把轨迹入册：空数组也入（solidify 侧映射为
              // kept-aiTask「无可映射动作」，与真跑路径结果一致）
              if (solidifiable) collectedTrace.set(s.id, stepActions);
              stepResults.push({
                order: s.order, status: 'passed', durationMs: Date.now() - started,
                screenshot: await writeStepScreenshot(reportId, i + 1, page),
                // 契约漂移兜底：summary 非 JSON 也算通过，但原文带出 warning 供人工核查
                ...(parsed ? {} : { warning: summary.slice(0, 200) }),
              });
              ctx.emit({
                type: 'verify_progress', phase: 'step_done', order: s.order, status: 'passed',
                durationMs: Date.now() - started,
                // 逐步登录行为以 LLM 当轮自报为准（含契约漂移,如实展示）
                ...(typeof parsed?.login === 'string' ? { login: parsed.login } : {}),
                ...(parsed ? {} : { reason: summary.slice(0, 120) }),
              });
            } catch (e) {
              clearTimeout(guardTimer);
              // watchdog 强关浏览器会让在途 runAiTask 抛错——此时真实原因是超时而非步骤失败
              if (timedOut) {
                // 全局超时:前缀写缓存 + 带完成步数,下轮 resume 续跑(见 commitTimeoutPrefix)
                return commitTimeoutPrefix('步骤执行中');
              }
              const eMsg = (e as Error).message ?? '';
              if (eMsg.startsWith('STEP_TIMEOUT:')) {
                // 单步 AI 相超过 STEP_AI_TIMEOUT_MS：fail-stop 该步而非整轮超时（在途 aiRun 放弃）
                void aiRun?.catch(() => undefined);
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: `步骤 ${s.order} AI 执行超过 ${STEP_AI_TIMEOUT_MS / 1000}s`, failureReason: 'StepTimedOut',
                  screenshot: await writeStepScreenshot(reportId, i + 1, page),
                });
                ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: `步骤 ${s.order} AI 执行超过 ${STEP_AI_TIMEOUT_MS / 1000}s` });
                failedIndex = i;
                break;
              }
              stepResults.push({
                order: s.order, status: 'failed', durationMs: Date.now() - started,
                error: eMsg.slice(0, 300), failureReason: 'AiTaskAborted',
                screenshot: await writeStepScreenshot(reportId, i + 1, page),
              });
              ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: eMsg.slice(0, 120) });
              failedIndex = i;
              break;
            }
          }

          // ── 前缀确认写回（D2）──
          // confirmedThrough = 本轮 AI 相真正确认过的连续条数：restore 失败时 resumeIndex 已在
          // onFailurePage 收敛到全局失败点 j，AI 从 j 续跑——只有 j 之前的步是确认过的（restore 机
          // 械回放重建），因此 recordedThrough 取 failedIndex（AI 循环首个失败下标）即可覆盖两种路径：
          // 全过 → len；restore 失败后 AI 又在 k 失败 → k（= 前缀确认条数）。confirmedStepResults 对齐
          // 全局下标：before-resume 段直接沿用上一轮的确认结果，resume 段取本轮 stepResults，
          // 二者在 restore 失败（j<validPrefixLen）时恰好无缝衔接、不重复。
          // 机械模式不写回前缀确认：没有 AI 相就没有新确认的步骤（保留上一轮 full 的判定缓存）
          if (mode !== 'mechanical') {
            const mergedVerdicts = new Map<string, { real: boolean; dropped?: string }>(prevConfirm?.assertionVerdicts ?? []);
            for (const [id, v] of verdictsThisRound) mergedVerdicts.set(id, v);
            verifyConfirmCache.set(ckey, {
              stepsHash: curStepsHash,
              metaHash: curMetaHash,
              confirmedThrough: failedIndex < 0 ? effectiveSteps.length : failedIndex,
              assertionVerdicts: mergedVerdicts,
              confirmedStepResults: [...prefixConfirmedResults.slice(0, resumeIndex), ...stepResults],
              confirmedTraces: collectedTrace,
            });
          }

          // ── 轨迹缓存写回（solidify_case 零执行复用）──
          // 整轮全过且「必需视觉步全部在册」才保存：前缀步的轨迹由确认缓存携带（见
          // collectedTrace 初始化），本轮 AI 相补齐改动步——resume 轮因此也能存出完整轨迹。
          // 覆盖不完整（如旧格式缓存无轨迹可携带）宁缺毋滥：takeFreshTrace 的 required
          // 检查本可挡住部分轨迹，主动不写保持"在册即可用"的语义干净。
          // vision 失败不阻断（步骤已过、expectedOutcome 不参与哈希，改预期不需要重跑实测）。
          // 任一步骤失败 → 清缓存（旧轨迹对应旧步骤内容，留着只会误导新鲜度判定——哈希本可挡，
          // 主动清是双保险，也让 getVerifiedTrace 的语义干净）。
          // 机械模式不动轨迹缓存：本轮没有 AI 相，既无可存轨迹，也不能清掉实测轮存的
          // （清了会让后续 solidify 无谓回退真跑）。
          const tkey = traceKey(ctx.threadId, caseId);
          let traceSavedNow = false;
          if (mode !== 'mechanical') {
            if (failedIndex < 0) {
              const solidifiableIds = effectiveSteps.filter((s) => isVisualStep(s) && !s.sensitive).map((s) => s.id);
              if (solidifiableIds.every((id) => collectedTrace.has(id))) {
                saveVerifiedTrace(tkey, curStepsHash, curMetaHash, collectedTrace);
                traceSavedNow = true;
              }
            } else {
              clearVerifiedTrace(tkey);
            }
          }

          // 用例级终态判定：与正式回放同一 vision 断言（cdp.ts runCaseVisionAssert），
          // 全部步骤通过后再判 expectedOutcome——verify_case 不能只保证"步骤能执行"，还得保证"终态符合预期"。
          // 机械模式的终态判定移到机械干跑之后（在干跑终态页上判，见 replay 段之后）。
          let visionFailure: { error?: string | null; humanMessage?: string | null; screenshot?: string | null; failureReason?: string | null } | null = null;
          if (mode !== 'mechanical' && failedIndex < 0 && typeof effectiveCase.expectedOutcome === 'string' && effectiveCase.expectedOutcome.trim()) {
            const va = await runCaseVisionAssert({
              page,
              reportId,
              caseTitle: effectiveCase.title,
              caseUrl: targetUrl ?? null,
              expectedOutcome: effectiveCase.expectedOutcome,
              vars: {},
              sensitiveVarKeys: [],
              llmClient: client,
            });
            if (va?.failureStep) {
              visionFailure = va.failureStep;
              ctx.emit({
                type: 'verify_progress', phase: 'step_done', order: -1, status: 'failed',
                reason: (va.failureStep.error ?? '终态与用例预期不符').slice(0, 120),
              });
            }
          }

          // 登录态回写：不依赖 LLM 自报的 login 字段（实测存在漏报契约漂移），配了登录就无条件存当前会话——
          // 未登录时存的是匿名会话，下轮注入后 AI 照样识别登录页重新登录并覆盖（自愈）。
          // watchdog 超时路径在循环内提前 return，不会走到这里。
          const savedState = await context.storageState().catch(() => null);
          if (savedState) saveLoginState(loginKey, savedState);

          // ── compiled 机械回放干跑：AI 相全过（步骤 + 终态判定）才跑，最终裁决门 ──
          // 正式回放逐字派发 compiled；AI 临场执行可自适应修正，两者分叉（如 click 落在
          // 组件 wrapper 中心不触发行为）只有真机回放能暴露。复用 executeCaseInBrowser：
          // 同 context（登录态随 cookie 携带）新开 page、不写 DB 报告；截图落 -replay
          // 目录，避免与 AI 相同名 step-N.png 互相覆盖。副作用与正式执行一致（二次执行
          // 恰好暴露唯一名冲突等回放脆弱性，属有意语义）。
          //
          // 讨论期实测场景：草稿步骤是纯自然语言（无 compiled）或纯 aiTask（视觉模式）时
          // 跳过机械干跑——没有可逐字派发的 compiled,跑了也只会以 compile-missing 报"未知错误",
          // 反而误导用户以为用例有问题。solidify 固化后再跑 verify 时 compiled 已就位,
          // 机械干跑自然恢复生效。
          const allVisual = isAllVisualSteps(effectiveSteps);
          let replayFailure: ExecStepResult | null = null;
          let replaySteps: ExecStepResult[] = [];
          let replayPage: Page | null = null;
          let replayStartedAt = 0;
          if (failedIndex < 0 && !visionFailure && !allVisual) {
            ctx.emit({ type: 'verify_progress', phase: 'replay_start' });
            replayStartedAt = Date.now();
            try {
              // 敏感字段注入复用顶部 buildReplaySecrets（restore 与结尾完整回放共用一套解密表）
              replaySteps = await executeCaseInBrowser(
                caseId,
                effectiveSteps.map(mapForReplay),
                {
                  reportId: `${reportId}-replay`,
                  envCtx,
                  llmClient: client,
                  liveView: live,
                  ...(replaySecrets.size > 0
                    ? { secretResolver: async (stepId: string) => replaySecrets.get(stepId) ?? null }
                    : {}),
                  caseTitle: effectiveCase.title,
                  caseUrl: targetUrl ?? null,
                  // onPageReady 无条件触发（成功也拿得到终态页）：机械模式的终态判定/证据
                  // 采集落在干跑页上；full 模式下 onFailurePage 触发时会覆盖为分叉现场页。
                  onPageReady: (p: Page) => { replayPage = p; },
                },
                browser,
                context,
                targetUrl,
                undefined,
                undefined,
                undefined,
                async (p) => {
                  // onFailurePage 仅在分叉失败时触发；正常路径的页面切换由 runStepsInContext 的
                  // ctx.liveView.setPage 在 page 创建时完成（replay ExecContext 已带 liveView）。
                  replayPage = p;
                },
              );
              replayFailure = replaySteps.find((r) => r.status === 'failed') ?? null;
            } catch (e) {
              if (timedOut) return commitTimeoutPrefix('机械回放中');
              throw e;
            }
            if (timedOut) return commitTimeoutPrefix('机械回放中');
            ctx.emit({
              type: 'verify_progress',
              phase: 'replay_done',
              status: replayFailure ? ('failed' as const) : ('passed' as const),
              ...(replayFailure
                ? { reason: (replayFailure.humanMessage ?? replayFailure.error ?? 'compiled 机械回放分叉').slice(0, 120) }
                : {}),
            });
          }

          // ── 机械模式终态判定：干跑成功后在干跑终态页上判 expectedOutcome ──
          // （full 模式的 vision 已在上方 AI 相之后完成；replayPage 由 onPageReady 无条件交还）
          if (mode === 'mechanical' && !replayFailure && !visionFailure
            && typeof effectiveCase.expectedOutcome === 'string' && effectiveCase.expectedOutcome.trim()) {
            const va = await runCaseVisionAssert({
              page: replayPage ?? page,
              reportId,
              caseTitle: effectiveCase.title,
              caseUrl: targetUrl ?? null,
              expectedOutcome: effectiveCase.expectedOutcome,
              vars: {},
              sensitiveVarKeys: [],
              llmClient: client,
            });
            if (va?.failureStep) {
              visionFailure = va.failureStep;
              ctx.emit({
                type: 'verify_progress', phase: 'step_done', order: -1, status: 'failed',
                reason: (va.failureStep.error ?? '终态与用例预期不符').slice(0, 120),
              });
            }
          }
          // 终态/证据采集页：机械模式在干跑页（AI 相没跑过，初始 page 是 about:blank）；full 模式在 AI 相页面
          const visionPage = mode === 'mechanical' ? (replayPage ?? page) : page;

          // ── 失败收尾：失败页元素清单（供 agent 修正 locator）──
          let failurePage: Awaited<ReturnType<typeof extractPageElements>> | null = null;
          if (replayFailure) {
            // 回放分叉时优先取干跑自己的 page（分叉现场）；AI 旧 page 状态已漂移
            failurePage = await extractPageElements(replayPage ?? page).catch(() => null);
          } else if (failedIndex >= 0 || visionFailure) {
            failurePage = await extractPageElements(visionPage).catch(() => null);
          }

          // 终态判定失败时补测「环境无前置数据」信号：空表/0 条时 note 直接点名数据缺失，
          // 避免 AI 用稀释 expectedOutcome 的方式把失败蒙成通过
          const emptyDataHint = visionFailure ? await detectEmptyDataState(visionPage) : null;

          // ── 结果组装（成功精简、失败信息密集）──
          // 响应的 steps 按全局步序合并：resume 前缀步沿用上一轮的确认结果（截图路径跨轮可访问），
          // 本轮 AI 相实际执行的步取 stepResults；restore 失败截断到 j 时两段恰好无缝衔接。
          const stepsSummary = [...prefixConfirmedResults.slice(0, resumeIndex), ...stepResults].map((r) => ({
            order: r.order,
            status: r.status,
            durationMs: r.durationMs,
            ...(r.warning ? { warning: r.warning } : {}),
            ...(r.screenshot ? { screenshot: r.screenshot } : {}),
            ...(r.error ? { error: r.error } : {}),
            ...(r.failureReason ? { failureReason: r.failureReason } : {}),
          }));
          const replaySummary = replaySteps.map((r) => ({
            order: r.order,
            status: r.status,
            durationMs: r.durationMs,
            ...(r.error ? { error: r.error } : {}),
            ...(r.failureReason ? { failureReason: r.failureReason } : {}),
            ...(r.screenshot ? { screenshot: r.screenshot } : {}),
            ...(r.hitLocator ? { hitLocator: r.hitLocator } : {}),
          }));
          // 体检丢弃的断言原样回传：LLM 据此把「描述性短语」改写成页面上真实存在的
          // UI 文案（或干脆删掉），而不是靠弱化断言蒙混过关。
          const droppedNotes = [...droppedAssertions.entries()].map(([id, text]) => ({
            order: effectiveSteps.find((s) => s.id === id)?.order ?? 0,
            assertion: text,
          }));
          const droppedField = droppedNotes.length > 0 ? { droppedAssertions: droppedNotes } : {};
          if (failedIndex < 0 && !visionFailure && !replayFailure) {
            // cacheSaved: 正常收尾均无条件回写（watchdog 超时路径在循环内提前 return,无 end 事件）
            ctx.emit({ type: 'verify_progress', phase: 'end', result: 'passed', cacheSaved: true });
            const rdata = JSON.stringify({
              result: 'passed',
              caseId,
              envId: envCtx.envId,
              targetUrl: targetUrl ?? null,
              // 机械模式无 AI 相：没有 login 自报、也没有新轨迹可存
              ...(mode === 'mechanical'
                ? { mode: 'mechanical' as const }
                : {
                    login,
                    // 轨迹已缓存 → 紧接着的 solidify_case 可零执行秒级固化（agent 据此引导用户）
                    traceSaved: traceSavedNow,
                  }),
              resumeFrom: validPrefixLen,
              basedOn: stagedCase || opsApplied > 0 ? ('staged' as const) : ('db' as const),
              stagedOpsApplied: opsApplied,
              ...(staticAnalysis.length > 0 ? { staticAnalysis } : {}),
              steps: stepsSummary,
              ...droppedField,
              replay: { result: 'passed' as const, durationMs: Date.now() - replayStartedAt },
            });
            updateRoundState(roundKey(ctx.threadId, caseId), rdata);
            return { ok: true, data: rdata };
          }
          if (visionFailure) {
            ctx.emit({ type: 'verify_progress', phase: 'end', result: 'failed', cacheSaved: true });
            // 归因全交 LLM（failureDiagnosis）：形态无关证据 = 最后一步各 locator 候选实时命中数
            // + 可见浮层清单 + 失败页可交互元素清单，外加空数据信号作 extraHint。
            const visionStep = effectiveSteps[effectiveSteps.length - 1] ?? null;
            const visionProbes = await probeLocatorHits(visionPage, collectStepLocators(visionStep?.compiled));
            const visionOverlays = (await extractPageEvidence(visionPage)).overlays;
            const visionEvidenceField =
              visionProbes.length > 0 || visionOverlays.length > 0
                ? { evidence: { overlays: visionOverlays, probes: visionProbes } }
                : {};
            const visionDiag = failurePage
              ? await diagnoseFailure({
                  client,
                  step: visionStep,
                  assertion: visionStep?.assertion ?? null,
                  probes: visionProbes,
                  overlays: visionOverlays,
                  elements: failurePage,
                  lang: ctx.lang,
                  ...(emptyDataHint ? { extraHint: `失败页检出空数据信号「${emptyDataHint}」` } : {}),
                })
              : null;
            const rdata = JSON.stringify({
              result: 'failed',
              caseId,
              envId: envCtx.envId,
              targetUrl: targetUrl ?? null,
              ...(mode === 'mechanical' ? { mode: 'mechanical' as const } : { login }),
              resumeFrom: validPrefixLen,
              basedOn: stagedCase || opsApplied > 0 ? ('staged' as const) : ('db' as const),
              stagedOpsApplied: opsApplied,
              ...(staticAnalysis.length > 0 ? { staticAnalysis } : {}),
              steps: stepsSummary,
              ...droppedField,
              failure: {
                stepOrder: -1,
                action: null,
                error: visionFailure.error ?? '最终页面与用例预期不符',
                failureReason: visionFailure.failureReason ?? 'VisionAssertionFailed',
                humanMessage: visionFailure.humanMessage ?? '最终页面与用例预期不符',
                screenshot: visionFailure.screenshot ?? null,
                page: failurePage,
                ...visionEvidenceField,
                note: `vision 终态判定失败：${mode === 'mechanical' ? '机械步骤全部执行通过后' : '全部步骤执行通过后'}，最终页面仍不符合 expectedOutcome。请核对最后几步的实际业务效果，修正步骤或 expectedOutcome 后重验。${mode === 'mechanical' ? '（机械验收模式：步骤语义未经 AI 相复核、描述性断言按上一轮判定或字面处理——修正后重跑 mechanical，拿不准改 mode=full 复核。）' : ''}${emptyDataHint ? ` ⚠ 失败页检出空数据信号「${emptyDataHint}」：被测环境当前没有可供断言的数据，这通常是环境前置数据缺失，而非选择器/步骤写错。正确做法是让用例先创建出满足 expectedOutcome 的数据（例如造一条会自动触发处置的事件），或如实向用户汇报环境缺数据——严禁通过弱化 expectedOutcome（如把"自动启动处置成功"改成"页面正常加载"）把失败蒙成通过。` : ''}${visionDiag ? ` ⚠ 归因:${visionDiag.note}` : ''}`,
              },
            });
            updateRoundState(roundKey(ctx.threadId, caseId), rdata);
            return { ok: true, data: rdata };
          }
          if (replayFailure) {
            const failedReplayStep = effectiveSteps.find((s) => s.order === replayFailure!.order) ?? null;
            const replayIdx = failedReplayStep ? effectiveSteps.indexOf(failedReplayStep) : -1;
            const replayHint = replayIdx >= 0 ? summarizeStaticReports(staticByStep[replayIdx] ?? []) : null;
            // 归因全交 LLM：分叉现场页（回放自己的 page）的候选命中 + 浮层 + 元素清单
            const replayPageForDiag = replayPage ?? page;
            const replayProbes = await probeLocatorHits(replayPageForDiag, collectStepLocators(failedReplayStep?.compiled));
            const replayOverlays = (await extractPageEvidence(replayPageForDiag)).overlays;
            const replayEvidenceField =
              replayProbes.length > 0 || replayOverlays.length > 0
                ? { evidence: { overlays: replayOverlays, probes: replayProbes } }
                : {};
            const replayDiag = failurePage
              ? await diagnoseFailure({
                  client,
                  step: failedReplayStep,
                  assertion: failedReplayStep?.assertion ?? null,
                  probes: replayProbes,
                  overlays: replayOverlays,
                  elements: failurePage,
                  lang: ctx.lang,
                })
              : null;
            ctx.emit({ type: 'verify_progress', phase: 'end', result: 'failed', cacheSaved: true });
            const rdata = JSON.stringify({
              result: 'failed',
              caseId,
              envId: envCtx.envId,
              targetUrl: targetUrl ?? null,
              ...(mode === 'mechanical' ? { mode: 'mechanical' as const } : { login }),
              resumeFrom: validPrefixLen,
              basedOn: stagedCase || opsApplied > 0 ? ('staged' as const) : ('db' as const),
              stagedOpsApplied: opsApplied,
              ...(staticAnalysis.length > 0 ? { staticAnalysis } : {}),
              steps: stepsSummary,
              ...droppedField,
              replay: replaySummary,
              failure: {
                stepOrder: replayFailure.order,
                action: failedReplayStep?.compiled ?? null,
                error: replayFailure.error ?? null,
                failureReason: 'ReplayDivergence',
                humanMessage: replayFailure.humanMessage ?? replayFailure.error ?? null,
                screenshot: replayFailure.screenshot ?? null,
                page: failurePage,
                ...replayEvidenceField,
                note: `${mode === 'mechanical' ? '机械验收模式（无 AI 相对照）下 compiled 机械逐字执行失败' : 'AI 临场执行能通过，但与正式回放同引擎的 compiled 机械逐字执行失败（回放分叉）'}——典型如 click 落在组件 wrapper 上不触发实际行为、唯一名冲突二次执行必挂。请用 failure.page.elements 中真实存在的选择器把该步 compiled 改成更精确的可操作目标（组件内部真实接收点击/输入的元素），或修正测试数据策略（时间戳命名）后重验。${mode === 'mechanical' ? '（机械模式无自动登录：若失败页是登录页，多为登录态缓存失效/副本重启——改 mode=full 重新实测登录即可；同因连续两轮失败或归因不明也建议改 full 复核。）' : ''}${replayDiag ? ` ⚠ 归因:${replayDiag.note}` : ''}${replayHint ? ` 源码静态提示:${replayHint}` : ''}`,
              },
            });
            updateRoundState(roundKey(ctx.threadId, caseId), rdata);
            return { ok: true, data: rdata };
          }
          // resume 轮 stepResults 只从 resumeIndex 起收集（局部下标），failedIndex 是全局步序，
          // 二者差一个 resumeIndex 偏移——直接取 stepResults[failedIndex] 会是 undefined（
          // "Cannot read properties of undefined (reading 'order')"）
          const failed = stepResults[failedIndex - resumeIndex]!;
          const failedStep = effectiveSteps[failedIndex]!;
          const failedHint = summarizeStaticReports(staticByStep[failedIndex] ?? []);
          // 归因全交 LLM：失败页候选命中 + 浮层 + 元素清单
          const stepProbes = await probeLocatorHits(page, collectStepLocators(failedStep.compiled));
          const stepOverlays = (await extractPageEvidence(page)).overlays;
          const stepEvidenceField =
            stepProbes.length > 0 || stepOverlays.length > 0
              ? { evidence: { overlays: stepOverlays, probes: stepProbes } }
              : {};
          const stepDiag = failurePage
            ? await diagnoseFailure({
                client,
                step: failedStep,
                assertion: failedStep.assertion,
                probes: stepProbes,
                overlays: stepOverlays,
                elements: failurePage,
                lang: ctx.lang,
              })
            : null;
          ctx.emit({ type: 'verify_progress', phase: 'end', result: 'failed', cacheSaved: true });
          const rdata = JSON.stringify({
            result: 'failed',
            caseId,
            envId: envCtx.envId,
            targetUrl: targetUrl ?? null,
            login,
            resumeFrom: validPrefixLen,
            basedOn: stagedCase || opsApplied > 0 ? ('staged' as const) : ('db' as const),
            stagedOpsApplied: opsApplied,
            ...(staticAnalysis.length > 0 ? { staticAnalysis } : {}),
            steps: stepsSummary,
            failure: {
              stepOrder: failed.order,
              action: failedStep.compiled ?? null,
              error: failed.error ?? null,
              failureReason: failed.failureReason ?? null,
              humanMessage: failed.error ?? null,
              screenshot: failed.screenshot ?? null,
              page: failurePage,
              ...stepEvidenceField,
              note: `page.elements 为失败页当前可见的可交互元素；修正 locator 只能使用其中真实存在的选择器。快照不含操作后才出现的元素。${failedHint ? ` 源码静态提示:${failedHint}` : ''}${stepDiag ? ` ⚠ 归因:${stepDiag.note}` : ''}`,
            },
          });
          updateRoundState(roundKey(ctx.threadId, caseId), rdata);
          return { ok: true, data: rdata };
        } finally {
          clearTimeout(timer);
          live?.close();
          if (browser) await browser.close().catch(() => undefined);
          await envCtx.close().catch(() => undefined);
        }
      } catch (e) {
        return { ok: false, error: `验证失败: ${(e as Error).message}` };
      }
    },
  };
}
