/**
 * RCA worker 占位：Task 5 将整体重写为真实编排（线程查重 → 建 AI 线程 → 跑 save_rca_result）。
 * 当前只提供类型与「未实现」兜底，让 rcaQueue 的动态 import 类型成立、测试可 vi.mock。
 */
import type { RcaJob } from './rcaQueue.js';

export type { RcaJob };

export async function processRcaJob(_job: RcaJob): Promise<void> {
  throw new Error('rcaWorker not implemented yet');
}
