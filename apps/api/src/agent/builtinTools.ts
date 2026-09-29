export interface AgentTool {
  name: string;
  description: string;
  handler: (input: unknown) => Promise<unknown>;
}

export function createSaveCaseTool(opts: { requirementId?: string }): AgentTool {
  return {
    name: 'saveCase',
    description: '保存生成的测试用例到数据库',
    handler: async () => ({ ok: true, requirementId: opts.requirementId }),
  };
}

export function createSaveStepsTool(): AgentTool {
  return { name: 'saveSteps', description: '保存生成的步骤', handler: async (input) => ({ ok: true, input }) };
}

export function createSaveReportTool(): AgentTool {
  return { name: 'saveReport', description: '保存执行报告', handler: async (input) => ({ ok: true, input }) };
}

export function createGetCaseTool(): AgentTool {
  return { name: 'getCase', description: '获取用例当前步骤', handler: async () => ({ ok: true }) };
}
