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
export const FillAction = z.object({
  kind: z.literal('fill'),
  locator: z.array(Locator).min(1),
  value: z.string(),
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

export const StepAction = z.discriminatedUnion('kind', [
  NavigateAction,
  ClickAction,
  FillAction,
  HoverAction,
  WaitForAction,
  AssertTextAction,
  AssertVisibleAction,
  ScreenshotAction,
]);
export type StepAction = z.infer<typeof StepAction>;