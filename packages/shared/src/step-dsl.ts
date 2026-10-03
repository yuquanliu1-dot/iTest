import { z } from 'zod';

export const LocatorStrategy = z.enum(['role', 'text', 'testId', 'css', 'xpath']);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const Locator = z.object({
  strategy: LocatorStrategy,
  value: z.string().min(1),
});
export type Locator = z.infer<typeof Locator>;

export const NavigateAction = z.object({ kind: z.literal('navigate'), url: z.string().url() });

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
  locator: z.array(Locator).min(1),
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
  | z.infer<typeof AssertJsonAction>
  | z.infer<typeof ExtractAction>
  | { kind: 'aiStep'; instruction: string; compiled: StepAction[] | null };

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
  AssertJsonAction,
  ExtractAction,
  z.object({
    kind: z.literal('aiStep'),
    instruction: z.string().max(2000),
    /**
     * LLM 编译出的 DSL 步骤；缺省 = 未生成（保存时由 compileAiStepsInPlace 兜底）；
     * null = AI 已尝试但放弃（短路不再重试）。optional 让两者语义可区分。
     */
    compiled: z.array(z.lazy(() => StepAction)).nullable().optional(),
    /** 可选断言描述；保存到 test_steps.assertion（assertText 形态）。可空。 */
    assertion: z.string().max(2000).nullable().optional(),
  }),
]) as z.ZodType<StepAction>;