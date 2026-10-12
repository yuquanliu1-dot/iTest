-- 0035: aiTask 视觉步骤运行时动作缓存（"自动挡固化"）
-- 设计：apps/api/src/execute/aiTaskCache.ts + cdp.ts aiTask 分支
-- 语义：首次回放成功后把 AI 实际执行的动作序列缓存（key = step_id + instruction 精确匹配）；
--   后续回放先机械执行缓存动作，失败静默回退 AI 重做并覆写缓存（自愈协议，借鉴 midscene cache）。
--   与 solidify_case 互补：缓存对用例定义零侵入（test_steps.compiled 不变）。
-- 生命周期：步骤删除级联清缓存；指令一改即过期（读时精确匹配）。
CREATE TABLE step_action_cache (
  step_id     uuid PRIMARY KEY REFERENCES test_steps(id) ON DELETE CASCADE,
  instruction text NOT NULL,
  actions     jsonb NOT NULL,
  hits        integer NOT NULL DEFAULT 0,
  created_at  timestamp NOT NULL DEFAULT now(),
  updated_at  timestamp NOT NULL DEFAULT now()
);
