/**
 * 探索会话的预算口径（纯计算，不碰 DB）。
 *
 * 独立成模块的原因：explorationShared 拖着 db/client（模块加载时读 DATABASE_URL），
 * 预算口径必须能在不起库的情况下单测——静态 import explorationShared 会把 pool
 * 绑到默认库，导致用例假红（2026-11-12 踩过的坑）。
 *
 * 为什么墙钟由轮次物化：固定墙钟会让「轮次预算」旋钮空转——配到 60 轮也撞
 * 15 分钟墙钟先停（轮次成了摆设）。轮次是深度的唯一旋钮，墙钟只是它的物化 + 兜底；
 * 单轮挂死另由空闲看门狗兜（EXPLORATION_IDLE_TIMEOUT_MS），不混在墙钟里。
 */

/** 轮次预算默认值（用户可在创建会话时覆盖，4~240；null=用这里）：超界优雅收尾
 *  （已发现的 findings 全保留）。runAiTask 硬闸 = 预算 +16 仅 runaway 兜底——硬闸随预算放大，
 *  否则用户配大轮次会被固定硬闸先拦，可配置形同虚设。 */
export const EXPLORATION_MAX_TURNS = 24;
/** 每轮预估耗时（一次 LLM 调用 + 浏览器动作 + 查库等待）——会话墙钟由轮次物化。 */
export const EXPLORATION_MS_PER_TURN = 60_000;
/** 会话墙钟下限（预算很小时也给的最小跑动时间）。 */
export const EXPLORATION_WALL_CLOCK_MIN_MS = 15 * 60_000;
/** 会话墙钟上限（预算很大时也不无限跑）。须 ≥ 轮次上限 × 每轮预估——否则大轮次被
 *  墙钟先拦，「轮次是唯一旋钮」形同虚设（240 轮 × 60s/轮 = 240 分钟）。 */
export const EXPLORATION_WALL_CLOCK_MAX_MS = 240 * 60_000;
/** 单次调用静默上限：这么久没有任何 pi 事件（message_update/tool_*）= 模型调用挂死。
 *  墙钟放大后必须由它兜挂死——否则一次挂死的 LLM 调用能占住整场会话。
 *  5 分钟而非更短：推理型网关可能在思考阶段长时间不出首字节，阈值太小会误杀正常调用。 */
export const EXPLORATION_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * 会话墙钟 = 轮次预算物化（钳在上下限之间）。
 * 轮次是深度的唯一旋钮；墙钟只是它的物化 + 兜底，不再是独立硬闸。
 */
export function explorationWallClockMs(maxTurns: number): number {
  const raw = maxTurns * EXPLORATION_MS_PER_TURN;
  return Math.min(EXPLORATION_WALL_CLOCK_MAX_MS, Math.max(EXPLORATION_WALL_CLOCK_MIN_MS, raw));
}
