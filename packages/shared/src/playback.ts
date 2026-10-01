import { z } from 'zod';

export const WindowStrategy = z.enum(['maximize', 'current', 'custom']);
export type WindowStrategy = z.infer<typeof WindowStrategy>;

export const FailureReason = z.enum([
  'URLUnreachable',
  'NotLoggedIn',
  'SlowLoad',
  'ElementOccluded',
  'PageStructureChanged',
  'TestDataMissing',
  'AssertionMismatch',
  'FixedValueConflict',
  'TabMissing',
  'AttachmentMissing',
  'SecretMissing',
  'DisabledTimeout',
  'LoadingTimeout',
  'OverlayTimeout',
  'LocatorAllFailed',
  'CDPUnavailable',
  'Unknown',
]);
export type FailureReason = z.infer<typeof FailureReason>;

export interface HitLocator {
  kind: string;
  value: string;
}

export interface PreflightReport {
  urlReachable: boolean;
  urlNote?: string;
  loggedIn: boolean;
  sourceOrigin?: string;
  currentOrigin?: string;
  originMismatch?: boolean;
  tabsObserved?: number[];
  durationMs: number;
}
