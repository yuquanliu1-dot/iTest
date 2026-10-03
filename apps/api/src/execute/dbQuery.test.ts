import { describe, it, expect } from 'vitest';
import { QueryDbError, QueryDbColumnNotAllowed, QueryDbTableNotAllowed, assertColumnsAllowed, ALLOWED_QUERY_COLUMNS } from './dbQuery.js';

describe('assertColumnsAllowed', () => {
  it('accepts known columns', () => {
    expect(() => assertColumnsAllowed('reports', ['id', 'status'])).not.toThrow();
  });
  it('rejects unknown column', () => {
    expect(() => assertColumnsAllowed('reports', ['secret_password'])).toThrow(QueryDbColumnNotAllowed);
  });
  it('rejects unknown table', () => {
    expect(() => assertColumnsAllowed('payments', ['id'])).toThrow(QueryDbTableNotAllowed);
  });
});

describe('ALLOWED_QUERY_COLUMNS', () => {
  it('never includes password / secret columns', () => {
    for (const cols of Object.values(ALLOWED_QUERY_COLUMNS)) {
      for (const c of cols) {
        expect(c).not.toMatch(/password|secret|token/i);
      }
    }
  });
});

describe('runQueryDb (integration placeholder)', () => {
  it('placeholder', () => { expect(QueryDbError).toBeDefined(); });
});