/**
 * 浏览器动作类工具（pi 链路）。P2 只挂 navigate（含探索范围闸）——
 * 只读观察工具集没有它，模型会被困在空白页上；不带闸发 navigate 则是安全回归。
 * click/fill/press/select/scroll/back/wait 随 P3 落地（破坏性闸 + 凭据替换同批移植）。
 *
 * 范围闸（语义与 legacy aiTask 逐字一致，见 execute/gates.ts scopeViolationReason）：
 * 白名单 = 起点 origin 唯一，刻意不含环境 loginUrl origin——2026-11-10 prod 实证
 * 把它加进白名单等于重开「导航到真实系统 + 真凭据登录 + 写数据」路径。
 * 起点 origin 不可解析 → 白名单为空数组 = navigate 全拒（保守收口）。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { scopeViolationReason } from '../../../execute/gates.js';
import type { ToolDeps } from './index.js';

/** navigate：origin 白名单闸 → goto（domcontentloaded 20s）→ networkidle 短等（SPA hydrate）。 */
export function createNavigateTool(deps: ToolDeps) {
  return defineTool({
    name: 'navigate',
    label: 'navigate',
    description: '导航到指定 URL。仅接受 http/https 绝对地址，且不得离开被测站点的起点域名——越界会被平台拒收。',
    promptGuidelines: ['起点页面打不开时如实结束并说明，不要改去任何其它站点或凭记忆换地址'],
    parameters: Type.Object({ url: Type.String({ description: '绝对地址，如 https://host/path' }) }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const url = params.url.trim();
      if (!/^https?:\/\//.test(url)) {
        return {
          content: [{ type: 'text', text: `navigate ${url}: error 仅接受 http/https 绝对地址。` }],
          details: undefined,
          isError: true,
        };
      }
      const reason = scopeViolationReason(url, deps.scopeOrigins);
      if (reason) {
        return {
          content: [
            {
              type: 'text',
              text: `navigate ${url}: error 探索范围被拒（${reason}）。只能在起点站点的域名内探索；若起点页面打不开，如实结束并说明，不要改去其它站点。`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
      try {
        await deps.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        // 与 legacy init-goto 对齐：等 SPA hydrate，长连接页面 5s 兜底不阻塞。
        await deps.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
        return {
          content: [{ type: 'text', text: `navigate ${url}: ok（当前 URL：${deps.page.url()}）。下一步调用 observe 获取页面截图与元素清单。` }],
          details: undefined,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: 'text',
              text: `navigate ${url}: error ${msg.slice(0, 200)}。起点页面打不开/不可达时如实结束并说明，不要改去其它站点。`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
    },
  });
}
