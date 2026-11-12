/**
 * 探索预算口径：会话墙钟由轮次物化。
 *
 * 背景（2026-11-12 走查）：固定 15 分钟墙钟不随轮次预算放大 ⇒ 用户把「轮次预算」
 * 配到 60 也没用，跑不满 15 分钟就被墙钟停掉，旋钮形同虚设。轮次是深度的唯一旋钮，
 * 墙钟只是它的物化 + 兜底；单轮挂死另由空闲看门狗兜（不混在墙钟里）。
 *
 * 本文件是纯计算用例——静态 import explorationBudget 不拖 db（预算口径要能不起库单测）。
 */
import { describe, it, expect } from 'vitest';
import {
  explorationWallClockMs,
  EXPLORATION_MAX_TURNS,
  EXPLORATION_WALL_CLOCK_MIN_MS,
  EXPLORATION_WALL_CLOCK_MAX_MS,
  EXPLORATION_IDLE_TIMEOUT_MS,
} from '../src/execute/explorationBudget.js';

describe('探索预算口径', () => {
  it('墙钟随轮次放大：24 轮 = 24 分钟（不再被固定 15 分钟墙钟先拦）', () => {
    expect(explorationWallClockMs(24)).toBe(24 * 60_000);
    expect(explorationWallClockMs(60)).toBe(60 * 60_000);
    expect(explorationWallClockMs(120)).toBe(120 * 60_000);
  });

  it('小预算给下限、大预算给上限（不无限跑）', () => {
    expect(explorationWallClockMs(4)).toBe(EXPLORATION_WALL_CLOCK_MIN_MS);
    expect(explorationWallClockMs(0)).toBe(EXPLORATION_WALL_CLOCK_MIN_MS);
    expect(explorationWallClockMs(300)).toBe(EXPLORATION_WALL_CLOCK_MAX_MS);
  });

  it('单调递增；默认预算与看门狗阈值都在墙钟之内', () => {
    expect(explorationWallClockMs(30)).toBeGreaterThan(explorationWallClockMs(20));
    expect(explorationWallClockMs(EXPLORATION_MAX_TURNS)).toBeLessThan(EXPLORATION_WALL_CLOCK_MAX_MS);
    // 挂死看门狗必须比墙钟先响，否则墙钟到了也没人能判挂死。
    expect(EXPLORATION_IDLE_TIMEOUT_MS).toBeLessThan(EXPLORATION_WALL_CLOCK_MIN_MS);
  });
});
