import { upsertScenario } from '../src/pi/workspace.ts';
import { db } from '../src/db/client.ts';
import { aiWorkspaceState, aiScenarios, aiCases } from '../src/db/schema.ts';
import { eq } from 'drizzle-orm';

const REQ_ID = '4f88438b-acdb-4c76-93b6-f27dc4159dba';
// 清空旧 staging
await db.delete(aiWorkspaceState).where(eq(aiWorkspaceState.requirementId, REQ_ID));
await db.delete(aiScenarios).where(eq(aiScenarios.requirementId, REQ_ID));
await db.delete(aiCases).where(eq(aiCases.requirementId, REQ_ID));

await upsertScenario(REQ_ID, {
  id: 's1',
  title: '登录表单验证',
  description: null,
  cases: [
    {
      id: 'c1',
      title: '用户名为空时点击登录',
      description: '用户名输入框留空，密码框输入合法密码，点登录应提示用户名不能为空',
      priority: 'P0',
      steps: [
        { name: '进入登录页', action: '打开登录页', assertion: '看到登录表单' },
        {
          name: '用户名留空',
          action: '保持用户名输入框为空',
          assertion: '断言用户名输入框可见且值为空',
        },
        {
          name: '密码填写',
          action: '在密码输入框输入合法密码',
          assertion: '断言密码框已填充',
        },
        { name: '点击登录', action: '点击「登录」按钮', assertion: '页面上出现错误提示' },
      ],
    },
    {
      id: 'c2',
      title: '用户名密码均合法',
      description: '填入合法用户名与密码，点登录应进入工作台',
      priority: 'P1',
      steps: [
        { name: '进入登录页', action: '打开登录页', assertion: null },
        { name: '填写用户名', action: '在用户名输入框填入 admin', assertion: null },
        { name: '填写密码', action: '在密码输入框填入合法密码', assertion: null },
        { name: '点击登录', action: '点击「登录」按钮', assertion: '页面跳转' },
      ],
    },
  ],
});
console.log('staged scenario');
await db.$client.end();