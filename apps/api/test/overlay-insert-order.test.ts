import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Positional-semantics consistency test for insert_step between
 * computeCaseOverlay (the staged virtual overlay used by verify_case) and insertCaseStep (the real persistence path).
 *
 * Background: found live in prod228 — with the same stage_case_op (insert_step, afterOrder=1),
 * the step order verify_case assembled via computeCaseOverlay and the real order insertCaseStep
 * persisted after the user clicked "save" placed the new step one slot apart. Consequence: the step
 * order verify validated ≠ the persisted execution order, so a green verify is not trustworthy.
 *
 * This test never touches the DB: it calls the pure function computeCaseOverlay directly; the persistence
 * side does not reconnect to a database either — it replicates the position formula of
 * services/cases.service.ts insertCaseStep (pure logic),
 * comparing only one quantity: which slot the new step lands in. Under the current implementation this assertion fails.
 */

let computeCaseOverlay: typeof import('../src/pi/space/tools/case-ops-tools.js').computeCaseOverlay;

beforeAll(async () => {
  ({ computeCaseOverlay } = await import('../src/pi/space/tools/case-ops-tools.js'));
});

/** Minimal step factory aligned with computeCaseOverlay's EffectiveStep input. */
function step(id: string, order: number) {
  return {
    id, order, instruction: `step-${id}`, compiled: null, assertion: null, sensitive: false,
    delayMs: null, secretCiphertext: null, secretIv: null, secretTag: null,
  };
}

/** The 0-based position where the newly staged step lands after computeCaseOverlay's overlay.
 *  Overlay-added steps have ids shaped `staged:<opIndex>`; locate them by that. */
function overlayNewStepIndex(existing: ReturnType<typeof step>[], ops: Array<{ payload: unknown }>): number {
  const overlay = computeCaseOverlay(existing, ops);
  const steps = overlay.steps!;
  return steps.findIndex((s) => s.id.startsWith('staged:'));
}

/** Replicates the positioning semantics of insertCaseStep (the real case-ops persistence path); returns the new step's final order:
 *  new order = afterOrder !== undefined ? afterOrder + 1 : maxOrder + 1.
 *  Then converts to the 0-based position of "which original 0-based index the new step lands after". Pure logic, no DB queries.
 *  (services/cases.service.ts:263-290)
 *  When the original orders are contiguous 0..n-1, the new order value == its 0-based position in the final sequence. */
function realInsertPosition(existingOrders: number[], afterOrder: number | undefined): number {
  const maxOrder = existingOrders.length > 0 ? Math.max(...existingOrders) : 0;
  const targetOrder = afterOrder !== undefined ? afterOrder + 1 : maxOrder + 1;
  return targetOrder;
}

const CASE_ID = '00000000-0000-4000-8000-000000000000';

describe('computeCaseOverlay insert_step 定位 vs insertCaseStep 落库定位', () => {
  const existing = [step('a', 0), step('b', 1), step('c', 2)];

  it('afterOrder=1:新步落位应与真实落库一致', () => {
    const ops = [{ payload: { action: 'insert_step', caseId: CASE_ID, instruction: 's', afterOrder: 1, compiled: [] } }];
    const overlayPos = overlayNewStepIndex(existing, ops);
    const realPos = realInsertPosition([0, 1, 2], 1);
    expect(overlayPos).toBe(realPos);
  });

  it('afterOrder=2(末尾之后):落位一致', () => {
    const ops = [{ payload: { action: 'insert_step', caseId: CASE_ID, instruction: 's', afterOrder: 2, compiled: [] } }];
    const overlayPos = overlayNewStepIndex(existing, ops);
    const realPos = realInsertPosition([0, 1, 2], 2);
    expect(overlayPos).toBe(realPos);
  });

  it('afterOrder 未给:追加到末尾,落位一致', () => {
    const ops = [{ payload: { action: 'insert_step', caseId: CASE_ID, instruction: 's', compiled: [] } }];
    const overlayPos = overlayNewStepIndex(existing, ops);
    const realPos = realInsertPosition([0, 1, 2], undefined);
    expect(overlayPos).toBe(realPos);
  });

  // Regression: insert after move_step scrambles the order — the landing position must still align with persistence.
  // After move, the list order == the current DB order as persisted; afterOrder refers to the post-move 0-based order.
  it('move_step 后 insert:落位对齐(afterOrder 参照 move 后顺序)', () => {
    const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const existing4 = [step(A, 0), step(B, 1), step(C, 2), step(D, 3)];
    // move: promote C to the head → [C,A,B,D]; insert afterOrder=1 (= after A, whose post-move order is 1)
    const ops = [
      { payload: { action: 'move_step', caseId: CASE_ID, stepIds: [C, A, B, D] } },
      { payload: { action: 'insert_step', caseId: CASE_ID, instruction: 's', afterOrder: 1, compiled: [] } },
    ];
    const overlay = computeCaseOverlay(existing4, ops);
    const ids = overlay.steps!.map((s) => s.id);
    // Expect [C,A,staged,B,D]: staged right after A (post-move order 1)
    const stagedIdx = ids.findIndex((s) => s.startsWith('staged:'));
    expect(ids[stagedIdx - 1]).toBe(A);
    expect(ids[stagedIdx + 1]).toBe(B);
  });

  it('delete_step 后 insert:落位对齐', () => {
    const DEL_ID = '99999999-9999-4999-8999-999999999999';
    const existing4 = [step('a', 0), step(DEL_ID, 1), step('c', 2), step('d', 3)];
    // After deleting b the list is [a,c,d] (orders 0,1,2); insert afterOrder=1 (= after c)
    const ops = [
      { payload: { action: 'delete_step', stepId: DEL_ID, caseId: CASE_ID } },
      { payload: { action: 'insert_step', caseId: CASE_ID, instruction: 's', afterOrder: 1, compiled: [] } },
    ];
    const overlay = computeCaseOverlay(existing4, ops);
    const ids = overlay.steps!.map((s) => s.id);
    const stagedIdx = ids.findIndex((s) => s.startsWith('staged:'));
    expect(ids[stagedIdx - 1]).toBe('c');
    expect(ids[stagedIdx + 1]).toBe('d');
  });
});
