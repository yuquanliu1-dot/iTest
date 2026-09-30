import { z } from 'zod';

export const LocatorStrategy = z.enum(['role', 'text', 'testId', 'css', 'xpath']);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const Locator = z.object({
  strategy: LocatorStrategy,
  value: z.string().min(1),
});
export type Locator = z.infer<typeof Locator>;

export const NavigateAction = z.object({ kind: z.literal('navigate'), url: z.string().url() });
export const ClickAction = z.object({ kind: z.literal('click'), locator: z.array(Locator).min(1) });
export const ValueGenerator = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('randomString'), length: z.number().int().min(1).max(200).default(12) }),
    z.object({ mode: z.literal('randomNumber'), min: z.number().int().default(0), max: z.number().int().default(999999) }),
    z.object({ mode: z.literal('timestamp') }),
    z.object({ mode: z.literal('prefixTimestamp'), prefix: z.string().min(1).max(100) }),
  ])
  .refine((d) => d.mode !== 'randomNumber' || d.max >= d.min, { message: 'max must be >= min' });
export type ValueGenerator = z.infer<typeof ValueGenerator>;

export const FillValue = z.union([z.string(), ValueGenerator]);
export type FillValue = z.infer<typeof FillValue>;

export const FillAction = z.object({
  kind: z.literal('fill'),
  locator: z.array(Locator).min(1),
  value: FillValue,
});
export const HoverAction = z.object({ kind: z.literal('hover'), locator: z.array(Locator).min(1) });
export const WaitForAction = z.object({
  kind: z.literal('waitFor'),
  locator: z.array(Locator).min(1),
  timeoutMs: z.number().int().positive().optional(),
});
export const AssertTextAction = z.object({
  kind: z.literal('assertText'),
  locator: z.array(Locator).min(1),
  equals: z.string(),
});
export const AssertVisibleAction = z.object({
  kind: z.literal('assertVisible'),
  locator: z.array(Locator).min(1),
});
export const ScreenshotAction = z.object({ kind: z.literal('screenshot'), name: z.string() });

export const CheckAction = z.object({
  kind: z.literal('check'),
  locator: z.array(Locator).min(1),
  checked: z.boolean(),
});
export const SelectAction = z.object({
  kind: z.literal('select'),
  locator: z.array(Locator).min(1),
  value: z.string().min(1),
});
export const UploadAction = z.object({
  kind: z.literal('upload'),
  locator: z.array(Locator).min(1),
  fileName: z.string().optional(),
});
export const AssertJsonAction = z.object({
  kind: z.literal('assertJson'),
  locator: z.array(Locator).min(1),
  equals: z.unknown(),
});
export const ExtractAction = z.object({
  kind: z.literal('extract'),
  locator: z.array(Locator).min(1),
  varName: z.string().min(1).max(100),
});

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
  AssertJsonAction,
  ExtractAction,
  z.object({
    kind: z.literal('aiStep'),
    instruction: z.string().min(1),
    compiled: z.array(z.lazy(() => StepAction)).nullable(),
  }),
]) as z.ZodType<StepAction>;