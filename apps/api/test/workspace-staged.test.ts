import { describe, it, expect } from 'vitest';
import type { StagedStep } from '../src/pi/workspace.js';

describe('StagedStep shape', () => {
  it('accepts compiled = StepAction[] in addition to action', () => {
    const step: StagedStep = {
      name: 'step1',
      action: 'click submit',
      assertion: null,
      compiled: [{ kind: 'click', locator: [{ strategy: 'text', value: 'submit' }] }],
    };
    expect(step.compiled).toHaveLength(1);
  });

  it('compiled is optional in shape (backward compat with old staged data)', () => {
    const oldShape: Partial<StagedStep> = {
      name: 'step1',
      action: 'click submit',
      assertion: null,
    };
    expect(oldShape.compiled).toBeUndefined();
  });
});