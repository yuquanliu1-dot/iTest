/**
 * R3 渲染红线：DB 零版本数据时 system prompt 与迁移前逐字节一致。
 * 三个常量是 session.ts 改造前(:650-652) 原文的硬拷贝——独立锚点，禁止 import 被测常量。
 * Task 3 会在此文件追加覆盖生效/DB 集成用例。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL } from './helpers/db.js';

const ZH_STYLE = '## 输出风格\n- 用户使用简体中文提问,全部回复一律用简体中文(代码、命令、英文术语可保留原文)。这条约束覆盖**每一条**用户可见文本,包括最终答复、调用工具前的过程说明、以及思考/推理独白——不要出现「Let me check」「I found that」「I should」这类英文句子,想查什么直接调工具即可。\n- 不要使用 emoji;强调用 markdown 加粗,列举用列表/表格。\n- 以资深测试专家的标准要求自己:简洁专业、结论先行。默认每条回复不超过 5 行(汇报步骤结果时用短列表);不复述工具动作过程、不复述页面结构、不把元素清单原文贴给用户、不输出超过 4 行的大表格——用一句话概括。\n- 杜绝胡编乱造:对被测系统的任何断言(页面上有哪些控件/筛选项/按钮、系统行为如何)必须有证据——verify_case 返回的实测元素清单(page/failure.page)、执行结果、或用户告知;清单里没有的控件一律当作不存在,不得提议、不得写进步骤。不确定就明说并询问用户。';
const EN_STYLE = '## Output style\n- The user writes in English. All replies MUST be in English (code, commands, and English terms may stay). This constraint covers every piece of user-visible text, including final replies, process explanations before tool calls, and reasoning monologues — do not write Chinese sentences like 「让我检查一下」, if you need to check something just call a tool.\n- Do not use emoji; emphasize with markdown bold, and enumerate with lists/tables.\n- Be a senior test expert: concise and professional. Lead with the conclusion; default to ≤5 lines per reply (a short list is fine when reporting step results). Do not narrate tool actions, do not restate page structure or paste element inventories back to the user, and do not dump tables longer than 4 rows — summarize instead.\n- Never fabricate. Claims about the system under test (which controls/filters/buttons a page has, how it behaves) must come from verify_case evidence (page / failure.page element lists), execution results, or the user — never from assumption. If you are not sure, say so and ask.';
const WORKSPACE = '## 工作空间\n- 当前目录是版本专属工作空间，项目仓库已检出到 ./repo 子目录。\n- repo_ls / repo_read / repo_grep 仅在用户明确要求看代码或分析仓库时使用；用例创建与实测过程不要用它们做侦察——元素与页面问题以 verify_case 实测反馈为证据。';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
}, 60_000);

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_prompt_module_versions`);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('R3 渲染红线：零覆盖 = 现状逐字节', () => {
  it('zh：prompt 含原文风格段与工作空间段', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const p = buildSpaceSystemPrompt('版本摘要', 'zh-CN', [], '', '');
    expect(p).toContain(ZH_STYLE);
    expect(p).toContain(WORKSPACE);
    expect(p.endsWith('## 版本空间上下文\n版本摘要')).toBe(true);
  });

  it('en：prompt 含原文英文风格段', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const p = buildSpaceSystemPrompt('summary', 'en-US', [], '', '');
    expect(p).toContain(EN_STYLE);
    expect(p).toContain(WORKSPACE);
    expect(p.endsWith('## 版本空间上下文\nsummary')).toBe(true);
  });

  it('默认参数与显式空覆盖逐字节一致（红线第二锚点）', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    expect(buildSpaceSystemPrompt('s', 'zh-CN', [], '', ''))
      .toBe(buildSpaceSystemPrompt('s', 'zh-CN', [], '', '', {}));
  });

  it('style 覆盖生效：注入值替换原文风格段', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const p = buildSpaceSystemPrompt('s', 'zh-CN', [], '', '', { style: '## 新风格\n- 简洁' });
    expect(p).toContain('## 新风格\n- 简洁');
    expect(p).not.toContain(ZH_STYLE);
    expect(p).toContain(WORKSPACE); // workspace 未覆盖仍为默认
  });

  it('workspace 覆盖生效', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const p = buildSpaceSystemPrompt('s', 'zh-CN', [], '', '', { workspace: '## 新工作台' });
    expect(p).toContain('## 新工作台');
    expect(p).not.toContain(WORKSPACE);
    expect(p).toContain(ZH_STYLE);
  });

  it('DB 覆盖链路：插 style 行后 loadPromptModuleOverridesSafe → textOverrideOf 命中', async () => {
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', '## DB风格', 'manual_edit')`);
    const { loadPromptModuleOverridesSafe, textOverrideOf } = await import('../src/pi/space/promptModules.js');
    const ov = await loadPromptModuleOverridesSafe();
    expect(textOverrideOf(ov, 'space.style.zh')).toBe('## DB风格');
    // 组装即注入：覆盖值进 buildSpaceSystemPrompt 后原文风格段被替换
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const p = buildSpaceSystemPrompt('s', 'zh-CN', [], '', '', { style: textOverrideOf(ov, 'space.style.zh') });
    expect(p).toContain('## DB风格');
    expect(p).not.toContain(ZH_STYLE);
  });
});
