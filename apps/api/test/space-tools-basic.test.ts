import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildSpaceTools, type SpaceToolsContext } from '../src/pi/space/tools/index.js';
import { diffText } from '../src/pi/space/tools/diff.js';

function makeCtx(over: Partial<SpaceToolsContext> = {}): { ctx: SpaceToolsContext; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const ctx: SpaceToolsContext = {
    threadId: randomUUID(),
    versionId: randomUUID(),
    projectId: randomUUID(),
    repo: { cwd: null, issue: null, noRepo: false },
    emit: (e) => events.push(e),
    ...over,
  };
  return { ctx, events };
}

describe('buildSpaceTools(骨架)', () => {
  it('repo 未就绪时恒注入 repo 工具(cwd 动态解析);注入 announce_plan 与 inspect_page', () => {
    const { ctx } = makeCtx();
    const names = buildSpaceTools(ctx).map((t) => t.name);
    expect(names).toContain('announce_plan');
    expect(names).toContain('inspect_page');
    // repo 工具恒注册,运行时再解析 cwd;未就绪时调用报「仓库尚未就绪」
    expect(names.filter((n) => n.startsWith('repo_'))).toEqual(['repo_ls', 'repo_read', 'repo_grep', 'repo_run']);
  });

  it('repo 就绪(cwd 已有)时同样注入 repo 沙箱工具', () => {
    const { ctx } = makeCtx({ repo: { cwd: '/tmp', issue: null, noRepo: false } });
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

  it('装配完整:四个领域工具全部注入', () => {
    const { ctx } = makeCtx();
    const names = buildSpaceTools(ctx).map((t) => t.name);
    for (const n of ['announce_plan', 'inspect_page', 'manage_cases', 'manage_scenarios', 'manage_environments', 'manage_plans']) {
      expect(names).toContain(n);
    }
    // 顺序约定:repo_*(若有)在最前,领域工具其后(与 session.ts 注入顺序一致)
    expect(names.indexOf('manage_cases')).toBeLessThan(names.indexOf('manage_plans'));
  });
});

describe('diffText', () => {
  it('标量变化输出 k: before → after;updatedAt 跳过', () => {
    const d = diffText(
      { title: '旧名', priority: 'P1', updatedAt: new Date(0) },
      { title: '新名', priority: 'P1', updatedAt: new Date(1) },
    );
    expect(d).toBe('title: 旧名 → 新名');
  });

  it('对象/数组值跳过;无变化返回 undefined', () => {
    expect(diffText({ a: { x: 1 } }, { a: { x: 2 } })).toBeUndefined();
    expect(diffText({ b: [1] }, { b: [2] })).toBeUndefined();
    expect(diffText({ k: 1, m: 'x' }, { k: 1, m: 'x' })).toBeUndefined();
  });
});
