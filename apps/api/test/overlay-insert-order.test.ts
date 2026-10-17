import { describe, it, expect, beforeAll } from 'vitest';

/**
 * computeCaseOverlay(verify_case 用的暂存虚拟叠加)与 insertCaseStep(真实落库)
 * 对 insert_step 的定位语义一致性测试。
 *
 * 背景:prod228 实测发现——同一份 stage_case_op(insert_step, afterOrder=1),
 * verify_case 用 computeCaseOverlay 拼出的步骤顺序,与用户点「保存」后
 * insertCaseStep 落库的真实顺序,新步骤落位差一位。后果:verify 验证的
 * 步骤顺序 ≠ 落库后执行顺序,verify 绿灯不可信。
 *
 * 本测试不碰 DB:直接调纯函数 computeCaseOverlay;落库侧不复连库,而是
 * 复刻 services/cases.service.ts insertCaseStep 的位置公式(纯逻辑),
 * 只比较「新步骤落在第几位」这一个量。当前实现下该断言失败。
 */

let computeCaseOverlay: typeof import('../src/pi/space/tools/case-ops-tools.js').computeCaseOverlay;

beforeAll(async () => {
  ({ computeCaseOverlay } = await import('../src/pi/space/tools/case-ops-tools.js'));
});

/** 与 computeCaseOverlay 的 EffectiveStep 入参对齐的最小步骤工厂。 */
function step(id: string, order: number) {
  return {
    id, order, instruction: `step-${id}`, compiled: null, assertion: null, sensitive: false,
    delayMs: null, secretCiphertext: null, secretIv: null, secretTag: null,
  };
}

/** computeCaseOverlay 叠加后,新暂存步骤落在的 0-based 位置。
 *  overlay 新增步的 id 形如 `staged:<opIndex>`,据此定位。 */
function overlayNewStepIndex(existing: ReturnType<typeof step>[], ops: Array<{ payload: unknown }>): number {
  const overlay = computeCaseOverlay(existing, ops);
  const steps = overlay.steps!;
  return steps.findIndex((s) => s.id.startsWith('staged:'));
}

/** 复刻 insertCaseStep(case-ops 真实落库路径)的定位语义,返回新步最终 order:
 *  新步 order = afterOrder !== undefined ? afterOrder + 1 : maxOrder + 1。
 *  再换算成"新步排在原第几个 0-based index 之后"的 0-based 位置。纯逻辑,不查库。
 *  (services/cases.service.ts:263-290)
 *  原 order 为 0..n-1 连续紧凑时,新步 order 值 == 它在最终序列里的 0-based 位置。 */
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

  // 回归:move_step 打乱顺序后 insert,落位仍须与落库对齐。
  // move 后 list 顺序 == 落库当前 DB 顺序,afterOrder 参照 move 后的 0-based order。
  it('move_step 后 insert:落位对齐(afterOrder 参照 move 后顺序)', () => {
    const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const existing4 = [step(A, 0), step(B, 1), step(C, 2), step(D, 3)];
    // move:把 C 提到首位 → [C,A,B,D];insert afterOrder=1(=在 move 后 order==1 的 A 之后)
    const ops = [
      { payload: { action: 'move_step', caseId: CASE_ID, stepIds: [C, A, B, D] } },
      { payload: { action: 'insert_step', caseId: CASE_ID, instruction: 's', afterOrder: 1, compiled: [] } },
    ];
    const overlay = computeCaseOverlay(existing4, ops);
    const ids = overlay.steps!.map((s) => s.id);
    // 期望 [C,A,staged,B,D]:staged 在 A(move 后 order 1)之后
    const stagedIdx = ids.findIndex((s) => s.startsWith('staged:'));
    expect(ids[stagedIdx - 1]).toBe(A);
    expect(ids[stagedIdx + 1]).toBe(B);
  });

  it('delete_step 后 insert:落位对齐', () => {
    const DEL_ID = '99999999-9999-4999-8999-999999999999';
    const existing4 = [step('a', 0), step(DEL_ID, 1), step('c', 2), step('d', 3)];
    // delete b 后 list=[a,c,d](order 0,1,2);insert afterOrder=1(=c 之后)
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
