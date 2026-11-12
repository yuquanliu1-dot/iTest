/**
 * Exploration budget accounting: the session wall clock is materialized from turns.
 *
 * Background (2026-11-12 walkthrough): the fixed 15-minute wall clock doesn't scale with the turn budget => even if the user
 * sets "turn budget" to 60, it's useless -- the session is stopped by the wall clock before reaching 15 minutes, rendering the knob decorative.
 * Turns are the only depth knob, and the wall clock is just its materialization + fallback; a single hung round is handled
 * separately by the idle watchdog (not mixed into the wall clock).
 *
 * This file contains pure-computation cases -- statically importing explorationBudget doesn't drag in db (the budget
 * accounting must be unit-testable without a database).
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
    // the hung-round watchdog must fire before the wall clock, otherwise nobody can call a hang when the wall clock expires.
    expect(EXPLORATION_IDLE_TIMEOUT_MS).toBeLessThan(EXPLORATION_WALL_CLOCK_MIN_MS);
  });
});
