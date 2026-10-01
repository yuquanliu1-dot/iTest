import { describe, it, expect } from 'vitest';
import { migrateAction } from '../src/lib/step-migration.js';

describe('migrateAction — assertText', () => {
  it('adds target=specifiedElement + match=equals to legacy assertText', () => {
    const legacy = { kind: 'assertText', locator: [{ strategy: 'css', value: '.msg' }], equals: 'ok' };
    const out = migrateAction(legacy);
    expect(out).toEqual({
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      intentLocator: undefined,
      target: 'specifiedElement',
      match: 'equals',
      equals: 'ok',
    });
  });

  it('does not overwrite explicit target/match', () => {
    const current = {
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      target: 'page',
      match: 'regex',
      equals: '^ok',
    };
    const out = migrateAction(current);
    expect(out.target).toBe('page');
    expect(out.match).toBe('regex');
  });
});

describe('migrateAction — locator-bearing kinds', () => {
  it('adds intentLocator=undefined to legacy click', () => {
    const legacy = { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] };
    const out = migrateAction(legacy) as { intentLocator?: unknown };
    expect(out.intentLocator).toBeUndefined();
  });

  it('does not touch known kinds lacking intentLocator (fill/hover/waitFor/check/select/extract)', () => {
    const kinds = ['fill', 'hover', 'waitFor', 'check', 'select', 'extract'];
    for (const k of kinds) {
      const legacy = { kind: k, locator: [{ strategy: 'css', value: '#x' }], ...(k === 'fill' || k === 'select' ? { value: 'x' } : {}) };
      const out = migrateAction(legacy) as { intentLocator?: unknown };
      expect(out.intentLocator).toBeUndefined();
    }
  });
});

describe('migrateAction — idempotency', () => {
  it('is a no-op on already migrated actions', () => {
    const migrated = {
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      intentLocator: { semanticRole: 'msg' },
      target: 'specifiedElement' as const,
      match: 'contains' as const,
      equals: 'ok',
    };
    expect(migrateAction(migrated)).toEqual(migrated);
  });
});

describe('migrateAction — defensive', () => {
  it('returns unknown kinds unchanged', () => {
    const alien = { kind: 'bogus', locator: [{ strategy: 'css', value: '#x' }] };
    expect(migrateAction(alien)).toEqual(alien);
  });
});
