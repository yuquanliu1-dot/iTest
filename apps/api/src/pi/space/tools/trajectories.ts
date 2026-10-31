/**
 * 轨迹检索工具：建用例前取同线成功轨迹 exemplar 做 few-shot（R2 读路径）。
 * 返回脚注硬约束锚点/URL 禁照抄——线内事实以当前应用实测为准。
 */
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { resolveProductLineId } from '../memories.js';
import { searchTrajectoriesByQuery, SEARCH_TOP_K } from '../trajectories.js';

export function buildSearchTrajectoryTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'search_trajectories',
    description: '检索当前产品线的成功用例生成轨迹（exemplar）。开始设计/编写任何用例前，用任务关键词（如「登录 失败 提示」「列表 导出」）先检索：返回 top-' + `${SEARCH_TOP_K}` + ' 条相似轨迹的蒸馏件（任务指纹/环境事实/关键决策/最终用例形态/verify 证据），作为 few-shot 参考其决策思路与用例形态。注意：轨迹中的锚点、URL、账号等线内事实必须以当前应用实测为准，禁止照抄。',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200, description: '任务关键词，空格分隔多个词' }),
    }),
    execute: async (input) => {
      const { query } = input as { query: string };
      const lineId = await resolveProductLineId(ctx.projectId);
      if (!lineId) return { ok: false, error: `无法解析当前项目的产品线（projectId=${ctx.projectId}）` };
      const { hits, all } = await searchTrajectoriesByQuery(lineId, query.trim());
      if (hits.length === 0) {
        const titles = all.map((t) => t.taskTitle).join('、') || '（无）';
        return { ok: false, error: `没有匹配「${query}」的成功轨迹。可用轨迹：${titles}` };
      }
      return {
        ok: true,
        data: JSON.stringify({
          trajectories: hits.map((h) => ({
            task_title: h.taskTitle,
            task_keywords: h.taskKeywords,
            digest: h.digest,
            case_title: h.caseTitle,
          })),
          note: '参考决策思路与用例形态；锚点/URL/账号等事实以当前应用实测为准，禁止照抄。',
        }),
      };
    },
  };
}

export function buildTrajectoryTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [buildSearchTrajectoryTool(ctx)];
}
