/**
 * Budget semantics of exploration sessions (pure computation, never touches the DB).
 *
 * Why this is a standalone module: explorationShared drags in db/client (which reads DATABASE_URL at module load),
 * and budget semantics must be unit-testable without standing up a database — a static import of explorationShared binds
 * the pool to the default database, making cases false-red (a gotcha hit on 2026-11-12).
 *
 * Why the wall clock is materialized from turns: a fixed wall clock would leave the "turn budget" knob spinning idle —
 * even a 60-turn config stops at the 15-minute wall clock first (turns become decoration). Turns are the only depth knob; the wall clock is just its materialization + fallback;
 * a single hung turn is caught separately by the idle watchdog (EXPLORATION_IDLE_TIMEOUT_MS), not mixed into the wall clock.
 */

/** Default turn budget (user-overridable at session creation, 4~240; null = use this): an out-of-budget exit wraps up gracefully
 *  (all discovered findings are kept). The runAiTask hard gate = budget +16, purely a runaway fallback — the hard gate scales with the budget,
 *  otherwise a user's large turn config would be blocked first by the fixed hard gate, making configurability moot. */
export const EXPLORATION_MAX_TURNS = 60;
/** Estimated per-turn duration (one LLM call + browser actions + DB waits) — the session wall clock is materialized from turns. */
export const EXPLORATION_MS_PER_TURN = 60_000;
/** Session wall-clock floor (a minimum run time granted even for tiny budgets). */
export const EXPLORATION_WALL_CLOCK_MIN_MS = 15 * 60_000;
/** Session wall-clock ceiling (no unbounded runs even for huge budgets). Must be ≥ turn ceiling × per-turn estimate — otherwise large turn budgets get
 *  blocked by the wall clock first, making "turns are the only knob" moot (240 turns × 60s/turn = 240 minutes). */
export const EXPLORATION_WALL_CLOCK_MAX_MS = 240 * 60_000;
/** Per-call silence ceiling: this long with no pi events (message_update/tool_*) = the model call is hung.
 *  After the wall clock was enlarged, this must be the hang catcher — otherwise a single hung LLM call can occupy the whole session.
 *  5 minutes rather than shorter: reasoning-type gateways may go a long time without a first byte during the thinking phase; too small a threshold would false-kill normal calls. */
export const EXPLORATION_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * Session wall clock = turn budget materialized (clamped between floor and ceiling).
 * Turns are the only depth knob; the wall clock is just its materialization + fallback, no longer an independent hard gate.
 */
export function explorationWallClockMs(maxTurns: number): number {
  const raw = maxTurns * EXPLORATION_MS_PER_TURN;
  return Math.min(EXPLORATION_WALL_CLOCK_MAX_MS, Math.max(EXPLORATION_WALL_CLOCK_MIN_MS, raw));
}
