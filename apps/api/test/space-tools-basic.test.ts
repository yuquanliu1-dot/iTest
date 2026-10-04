import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildSpaceTools, type SpaceToolsContext } from '../src/pi/space/tools/index.js';

function makeCtx(over: Partial<SpaceToolsContext> = {}): { ctx: SpaceToolsContext; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const ctx: SpaceToolsContext = {
    threadId: randomUUID(),
    versionId: randomUUID(),
    projectId: randomUUID(),
    cwd: null,
    repoAvailable: false,
    emit: (e) => events.push(e),
    ...over,
  };
  return { ctx, events };
}

describe('buildSpaceTools(骨架)', () => {
  it('repo 不可用时不注入 repo 工具;注入 announce_plan 与 inspect_page', () => {
    const { ctx } = makeCtx();
    const names = buildSpaceTools(ctx).map((t) => t.name);
    expect(names).toContain('announce_plan');
    expect(names).toContain('inspect_page');
    expect(names.filter((n) => n.startsWith('repo_'))).toEqual([]);
  });

  it('repo 可用时注入 repo 沙箱工具', () => {
    const { ctx } = makeCtx({ repoAvailable: true, cwd: '/tmp' });
    const names = buildSpaceTools(ctx).map((t) => t.name);
    expect(names.some((n) => n.startsWith('repo_'))).toBe(true);
  });

  it('announce_plan 广播 announce 事件(summary/total/steps)并回 ok', async () => {
    const { ctx, events } = makeCtx();
    const tool = buildSpaceTools(ctx).find((t) => t.name === 'announce_plan')!;
    const r = await tool.execute({ summary: '配置登录模块', steps: ['建分组', '建用例A', '建用例B'] });
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'announce', summary: '配置登录模块', total: 3 });
    expect((events[0] as { steps: string[] }).steps).toEqual(['建分组', '建用例A', '建用例B']);
  });
});
