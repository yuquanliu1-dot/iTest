import { z } from 'zod';

// xpath 仍保留在 schema(历史数据兼容),但录制端和新生成的 AI 用例不应再产。
export const LocatorStrategy = z.enum(['role', 'text', 'testId', 'css', 'xpath', 'accessibilityId', 'label', 'predicate']);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const Locator = z.object({
  strategy: LocatorStrategy,
  value: z.string().min(1),
});
export type Locator = z.infer<typeof Locator>;

/** navigate.url 三形态:绝对 http(s)(外链)/ 相对(以 / 开头,执行时拼用例绑定的 web 服务)/
 *  {{变量}} 打头(如 {{web_backend}}/api/x,替换后再按前两形态判断)。 */
const navigateUrl = z.string().refine(
  (u) => /^https?:\/\//i.test(u) || u.startsWith('/') || u.startsWith('{{'),
  { message: 'url 必须是绝对 http(s) 地址、以 / 开头的相对路径,或 {{变量}} 打头' },
);
export const NavigateAction = z.object({ kind: z.literal('navigate'), url: navigateUrl });

export const IntentLocator = z.object({
  /** 录制阶段确定的语义角色（data-testid / name 等），回放时作为补充候选。 */
  semanticRole: z.string().min(1).max(64),
  /** 业务文案，回放时参与文本兜底。 */
  contextText: z.string().max(500).optional(),
});
export type IntentLocator = z.infer<typeof IntentLocator>;

export const ValueGenerator = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('randomString'), length: z.number().int().min(1).max(200).default(12) }),
    z.object({ mode: z.literal('randomNumber'), min: z.number().int().default(0), max: z.number().int().default(999999) }),
    z.object({ mode: z.literal('timestamp') }),
    z.object({ mode: z.literal('prefixTimestamp'), prefix: z.string().min(1).max(100) }),
  ])
  .refine((d) => d.mode !== 'randomNumber' || d.max >= d.min, { message: 'max must be >= min' });
export type ValueGenerator = z.infer<typeof ValueGenerator>;

export const ClickAction = z.object({
  kind: z.literal('click'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
});

/** 单段 CompositeValue 的可能形态；按顺序拼接生成最终输入。 */
export const ValueFragment = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), value: z.string().max(500) }),
  z.object({ mode: z.literal('date'), format: z.enum(['YYYYMMDD', 'YYYY-MM-DD', 'YYYY/MM/DD']) }),
  z.object({
    mode: z.literal('randomNumber'),
    min: z.number().int().min(0).default(0),
    max: z.number().int().default(999999),
    /** 固定位数；存在则左补零到该长度。 */
    length: z.number().int().min(1).max(128).optional(),
  }),
  z.object({ mode: z.literal('randomString'), length: z.number().int().min(1).max(1024).default(12) }),
  z.object({ mode: z.literal('timestamp') }),
]);
export type ValueFragment = z.infer<typeof ValueFragment>;

/** 估算最大长度（供 refine + 前端 builder 复用）。 */
export function estimateMaxLen(input: { fragments: ValueFragment[] }): number {
  let total = 0;
  for (const f of input.fragments) {
    switch (f.mode) {
      case 'fixed': total += f.value.length; break;
      case 'date': total += f.format.length; break;
      case 'randomNumber': total += f.length ?? String(f.max).length; break;
      case 'randomString': total += f.length; break;
      case 'timestamp': total += 13; break;
    }
  }
  return total;
}

export const CompositeValue = z
  .object({
    mode: z.literal('composite'),
    fragments: z.array(ValueFragment).min(1).max(20),
  })
  .refine((v) => estimateMaxLen(v) <= 1024, {
    message: 'CompositeValue 总长度超过 1024 上限',
    path: ['fragments'],
  });
export type CompositeValue = z.infer<typeof CompositeValue>;

export const FillValue = z.union([z.string(), ValueGenerator, CompositeValue]);
export type FillValue = z.infer<typeof FillValue>;

export const FillAction = z.object({
  kind: z.literal('fill'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  value: FillValue,
  sensitive: z.boolean().optional(),
});
export const HoverAction = z.object({ kind: z.literal('hover'), locator: z.array(Locator).min(1) });
export const WaitForAction = z.object({
  kind: z.literal('waitFor'),
  /** 空数组 = 固定时长等待（不等待具体元素），睡 timeoutMs（默认 5000）。 */
  locator: z.array(Locator),
  intentLocator: IntentLocator.optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export const AssertTextAction = z.object({
  kind: z.literal('assertText'),
  locator: z.array(Locator),
  intentLocator: IntentLocator.optional(),
  target: z.enum(['specifiedElement', 'page', 'errorMessage', 'url']).default('specifiedElement'),
  match: z.enum(['equals', 'contains', 'notContains', 'regex']).default('equals'),
  equals: z.string(),
});
export const AssertVisibleAction = z.object({
  kind: z.literal('assertVisible'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
});
export const ScreenshotAction = z.object({ kind: z.literal('screenshot'), name: z.string() });

export const CheckAction = z.object({
  kind: z.literal('check'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  checked: z.boolean(),
});
export const SelectAction = z.object({
  kind: z.literal('select'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  value: z.string().min(1),
});
export const UploadAction = z.object({
  kind: z.literal('upload'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  fileId: z.string().min(1),
});
export const SwitchTabAction = z.object({
  kind: z.literal('switchTab'),
  tabRef: z.string().min(1).max(64),
});
/** 智能任务：回放时由 LLM 多轮驱动执行的自然语言步骤（不预编译，运行时看截图决策）。
 * 适用于验证码识别、动态/不稳定页面交互等难以固化为 DSL 的场景。 */
export const AiTaskAction = z.object({
  kind: z.literal('aiTask'),
  instruction: z.string().min(1).max(2000),
  intentLocator: IntentLocator.optional(),
});
export const AssertJsonAction = z.object({
  kind: z.literal('assertJson'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  equals: z.unknown(),
});
export const ExtractMode = z.enum(['completeValue', 'smartExtract', 'regex']);
export type ExtractMode = z.infer<typeof ExtractMode>;

export const ExtractAction = z.object({
  kind: z.literal('extract'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  varName: z.string().min(1).max(64),
  mode: ExtractMode.default('completeValue'),
  /** regex 模式必填；smartExtract 模式由后端一次编译后写入。 */
  pattern: z.string().min(1).max(500).optional(),
  /** regex 模式下的捕获组 1-based；0 表示整个 match。 */
  group: z.number().int().min(0).max(10).optional(),
  /** smartExtract 模式用户输入的自然语言描述，仅 UI 展示。 */
  description: z.string().max(500).optional(),
});
export type ExtractAction = z.infer<typeof ExtractAction>;

export const DbAssertionMatch = z.enum(['equals', 'contains', 'regex']);
export type DbAssertionMatch = z.infer<typeof DbAssertionMatch>;

export const QueryDbAction = z.object({
  kind: z.literal('queryDb'),
  table: z.enum([
    'projects', 'groups', 'users', 'test_cases', 'test_steps',
    'reports', 'execution_plans', 'plan_runs', 'plan_run_cases', 'test_attachments',
  ]),
  where: z.array(z.object({
    column: z.string().min(1).max(64),
    equals: z.union([z.string().max(500), z.number(), z.boolean()]),
  })).max(10).default([]),
  columns: z.array(z.string().min(1).max(64)).max(40).default([]),
  limit: z.number().int().min(1).max(200).default(50),
  assertion: z.object({
    match: DbAssertionMatch.default('contains'),
    expected: z.string().max(2000),
    column: z.string().max(64).optional(),
  }).optional(),
});
export type QueryDbAction = z.infer<typeof QueryDbAction>;

export const ObserveLogAction = z.object({
  kind: z.literal('observeLog'),
  windowMs: z.number().int().min(1000).max(600000).default(60000),
  keywords: z.array(z.string().min(1).max(200)).max(10).default([]),
  fromLine: z.number().int().min(1).max(10000).default(200),
  assertion: z.object({
    match: DbAssertionMatch.default('contains'),
    expected: z.string().max(2000),
  }).optional(),
});
export type ObserveLogAction = z.infer<typeof ObserveLogAction>;

export const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export type HttpMethod = z.infer<typeof HttpMethod>;

export const HttpRequestAction = z.object({
  kind: z.literal('httpRequest'),
  method: HttpMethod.default('GET'),
  /** 支持 {{var}} 替换。 */
  url: z.string().min(1).max(2000),
  headers: z.array(z.object({
    key: z.string().min(1).max(128),
    /** 支持 {{var}} 替换。 */
    value: z.string().max(2000),
  })).max(20).default([]),
  /** 原文请求体，支持 {{var}} 替换。 */
  body: z.string().max(65536).optional(),
  timeoutMs: z.number().int().min(1000).max(30000).default(10000),
  /** true 时把浏览器登录态 Cookie 按 URL host 转发给请求（不覆盖手填 Cookie 头）。 */
  carryLoginState: z.boolean().optional(),
  /** 响应值提取为变量，供后续步骤 {{var}} 消费。 */
  saveAs: z.object({
    varName: z.string().min(1).max(64),
    from: z.enum(['body', 'status']),
    /** 简化 dot-path（如 data.items[0].id），仅 from='body' 时生效；缺省取完整 body 文本。 */
    path: z.string().max(200).optional(),
  }).optional(),
  /** status 与 body 二者可选，都设置则都须通过。 */
  assertion: z.object({
    status: z.number().int().min(100).max(599).optional(),
    match: DbAssertionMatch.default('contains'),
    /** 作用于响应 body 文本的匹配期望值。 */
    expected: z.string().max(2000).optional(),
  }).optional(),
});
export type HttpRequestAction = z.infer<typeof HttpRequestAction>;

/** 2026-10-07: 移动端测试 step DSL 增量（Task 1 of iTest mobile-testing plan）。 */
export const TapAction = z.object({
  kind: z.literal('tap'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  doubleTap: z.boolean().optional(),
  longPressMs: z.number().int().min(100).max(5000).optional(),
});
export const SwipeAction = z.object({
  kind: z.literal('swipe'),
  from: z.array(Locator).min(1),
  to: z.array(Locator).min(1),
  durationMs: z.number().int().min(50).max(3000).default(300),
});
export const SetAppearanceAction = z.object({
  kind: z.literal('setAppearance'),
  mode: z.enum(['light', 'dark']),
});
export const SetNetworkAction = z.object({
  kind: z.literal('setNetwork'),
  state: z.enum(['online', 'offline', 'airplane']),
});
export const SetLocationAction = z.object({
  kind: z.literal('setLocation'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export const AppOpenAction = z.object({
  kind: z.literal('appOpen'),
  bundleId: z.string().min(1).optional(),
});
export const AppBackAction = z.object({ kind: z.literal('appBack') });
export const AppRestartAction = z.object({ kind: z.literal('appRestart') });
export const HomeAction = z.object({ kind: z.literal('home') });

export type StepAction =
  | z.infer<typeof NavigateAction>
  | z.infer<typeof ClickAction>
  | z.infer<typeof FillAction>
  | z.infer<typeof HoverAction>
  | z.infer<typeof WaitForAction>
  | z.infer<typeof AssertTextAction>
  | z.infer<typeof AssertVisibleAction>
  | z.infer<typeof ScreenshotAction>
  | z.infer<typeof CheckAction>
  | z.infer<typeof SelectAction>
  | z.infer<typeof UploadAction>
  | z.infer<typeof SwitchTabAction>
  | z.infer<typeof AiTaskAction>
  | z.infer<typeof AssertJsonAction>
  | z.infer<typeof ExtractAction>
  | z.infer<typeof QueryDbAction>
  | z.infer<typeof ObserveLogAction>
  | z.infer<typeof HttpRequestAction>
  | z.infer<typeof TapAction>
  | z.infer<typeof SwipeAction>
  | z.infer<typeof SetAppearanceAction>
  | z.infer<typeof SetNetworkAction>
  | z.infer<typeof SetLocationAction>
  | z.infer<typeof AppOpenAction>
  | z.infer<typeof AppBackAction>
  | z.infer<typeof AppRestartAction>
  | z.infer<typeof HomeAction>;

export const StepAction: z.ZodType<StepAction> = z.discriminatedUnion('kind', [
  NavigateAction,
  ClickAction,
  FillAction,
  HoverAction,
  WaitForAction,
  AssertTextAction,
  AssertVisibleAction,
  ScreenshotAction,
  CheckAction,
  SelectAction,
  UploadAction,
  SwitchTabAction,
  AiTaskAction,
  AssertJsonAction,
  ExtractAction,
  QueryDbAction,
  ObserveLogAction,
  HttpRequestAction,
  TapAction,
  SwipeAction,
  SetAppearanceAction,
  SetNetworkAction,
  SetLocationAction,
  AppOpenAction,
  AppBackAction,
  AppRestartAction,
  HomeAction,
]) as z.ZodType<StepAction>;
