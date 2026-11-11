import { describe, it, expect } from 'vitest';
import { composeExplorationInstruction, coerceFindings, trailToSteps, trailToCaseSteps, mergeExplorationTrails, EXPLORATION_MAX_FINDINGS, EXPLORATION_MAX_SQL_PROBES } from './explorationPrompt.js';
import { EXPLORATION_SYSTEM_PROMPT_BASE } from './explorationPrompt.js';
import { EXPLORATION_PERSONA_KEYS } from '@itest/shared';

describe('EXPLORATION_SYSTEM_PROMPT_BASE - 协议与安全规则', () => {
  it('动作协议与 runAiTask 解析器一致（坐标主通道 + 允许的五种动作类型）', () => {
    for (const t of ['"click"', '"fill"', '"press"', '"wait"', '"navigate"', '"screenshot"']) {
      expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain(t);
    }
  });

  it('findings 契约齐全（当轮报告 + severity 判级 + 不重报）', () => {
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('"findings"');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('reproSteps');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('同一缺陷只报一次');
  });

  it('findings 字段名写死（description 不许改名 + severity 只 P0-P3）', () => {
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('不能写成 evidence/detail/desc');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('不能写「高/中/低」');
  });

  it('安全底线在提示词层（不可逆操作禁止 + 二次确认弹窗一律取消）', () => {
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('一律不执行');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('二次确认弹窗一律取消');
  });

  it('范围约束（不离开被测站点）与探索导向（主动找茬）并存', () => {
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('不得离开被测站点');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('主动找茬');
  });

  it('反馈协议说明（页面消息=一手证据 + 无观测变化=点击无效换目标）', () => {
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('页面消息');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('页面无观测变化');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('不成为漏报理由');
  });

  it('范围约束写明机械拒收 + 起点不可达输出 fail（2026-11-10 越界写数据实证）', () => {
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('机械拒收');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('直接输出 fail 如实说明，不要改去任何其它站点');
  });

  it('数据库取证协议：sql 动作形状 + 只读约束 + 行数上限', () => {
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('"sql"');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('"query"');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('只读');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('写语句会被平台机械拒收');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('一次最多回 20 行');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('不要写进 findings');
  });

  it('子目标清单（plan）协议在探索基底里也在（执行基底有、探索基底曾漏）', () => {
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('"plan"');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('子目标清单');
  });

  // 2026-11-11 prod 实录：excluded 形状原先排在「actions 元素类型」列表里，
  // 模型把它当成一种 action → 整场探索零申报，账本恒空。必须显式声明为顶层字段。
  it('负面结果账本：excluded 是顶层字段（与 actions/findings 同级，不在 actions 里）', () => {
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('顶层字段 "excluded"');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('与 actions / findings 同级');
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).toContain('"excluded": [...]');
    // 不得再以 actions 元素类型的形态出现（那是模型误读的根源）
    expect(EXPLORATION_SYSTEM_PROMPT_BASE).not.toContain('- {"excluded"');
  });

  it('取证配额常量与 findings 配额并列（成本双保险）', () => {
    expect(EXPLORATION_MAX_SQL_PROBES).toBeGreaterThan(0);
    expect(EXPLORATION_MAX_SQL_PROBES).toBeLessThanOrEqual(EXPLORATION_MAX_FINDINGS);
  });
});

describe('composeExplorationInstruction', () => {
  const base = { startUrl: 'https://sut.example.com/app', charter: '探索用户管理页面，报告所有异常行为。', personaKey: 'qa' };

  it('含章程/视角指令/起点', () => {
    const s = composeExplorationInstruction(base);
    expect(s).toContain('探索用户管理页面');
    expect(s).toContain('https://sut.example.com/app');
    expect(s).toContain('通用测试员视角');
  });

  it('needsLoginPreamble=false → 无登录段；true → 含占位符', () => {
    const no = composeExplorationInstruction(base);
    expect(no).not.toContain('登录准备');
    const yes = composeExplorationInstruction({
      ...base,
      needsLoginPreamble: true,
      loginPlaceholders: { user: '__ITEST_USERNAME@web__', password: '__ITEST_PASSWORD@web__' },
    });
    expect(yes).toContain('登录准备');
    expect(yes).toContain('__ITEST_USERNAME@web__');
    expect(yes).toContain('__ITEST_PASSWORD@web__');
  });

  it('manifest 非空时携带', () => {
    const s = composeExplorationInstruction({ ...base, manifest: '- web（默认） https://x 已配置凭据' });
    expect(s).toContain('可选 web 服务');
    expect(s).toContain('已配置凭据');
  });

  it('未知 persona key 回落 qa 不抛错', () => {
    const s = composeExplorationInstruction({ ...base, personaKey: 'nope' });
    expect(s).toContain('通用测试员视角');
    expect(EXPLORATION_PERSONA_KEYS).toContain('qa');
  });

  it('dbs 非空 → 含「## 数据库取证」段（库名/方言 + 只读约束 + 默认库约定）', () => {
    const s = composeExplorationInstruction({
      ...base,
      dbs: [{ label: 'SIEM数据库', dialect: 'mysql' }],
    });
    expect(s).toContain('## 数据库取证');
    expect(s).toContain('SIEM数据库（mysql）');
    expect(s).toContain('只允许 SELECT / WITH 开头的只读查询');
    expect(s).toContain('不写 db 就查环境默认库');
    expect(s).toContain('information_schema.tables');
  });

  it('dbs 缺省/空数组 → 无「## 数据库取证」段（通道不存在就不在提示词里露头）', () => {
    expect(composeExplorationInstruction(base)).not.toContain('## 数据库取证');
    expect(composeExplorationInstruction({ ...base, dbs: [] })).not.toContain('## 数据库取证');
  });
});

describe('trailToSteps - 动作留痕转复现步骤', () => {
  it('查库动作 → 「查库 <query>」+ expected 摘要（评审界面直接可见取证内容）', () => {
    const steps = trailToSteps([
      { type: 'click', target: '#submit' },
      { type: 'sql', target: 'SELECT id,name FROM assets', detail: '2 行｜首行：id=1 | name=资产A' },
    ]);
    expect(steps).toEqual([
      { action: '点击 #submit' },
      { action: '查库 SELECT id,name FROM assets', expected: '2 行｜首行：id=1 | name=资产A' },
    ]);
  });

  it('查库动作无 detail（失败/未回填）→ 只有 action，不带空 expected', () => {
    const steps = trailToSteps([{ type: 'sql', target: 'SELECT 1' }]);
    expect(steps).toEqual([{ action: '查库 SELECT 1' }]);
  });
});

describe('coerceFindings', () => {
  const ok = { title: '删除按钮无二次确认', description: '点击删除直接生效', severity: 'P1', reproSteps: [{ action: '点击删除' }] };

  it('合法条目通过；severity 缺失/脏值 → P2 兜底', () => {
    const r = coerceFindings([ok, { title: 'B', description: 'b', severity: '未知' }, { title: 'C', description: 'c' }]);
    expect(r.accepted.map((f) => f.severity)).toEqual(['P1', 'P2', 'P2']);
    expect(r.dropped).toBe(0);
    expect(r.invalid).toBe(0);
  });

  it('空标题/空描述判非法丢弃；字段超长截断不丢条', () => {
    const r = coerceFindings([{ title: '', description: 'x' }, { title: '  ', description: 'x' }, { title: 'T', description: 'd'.repeat(5000) }]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.description).toHaveLength(4000);
    expect(r.dropped).toBe(2);
    expect(r.invalid).toBe(2);
  });

  it('超配额截断：保留前 max 条，余者计 dropped', () => {
    const many = Array.from({ length: EXPLORATION_MAX_FINDINGS + 3 }, (_, i) => ({ title: `T${i}`, description: 'd' }));
    const r = coerceFindings(many);
    expect(r.accepted).toHaveLength(EXPLORATION_MAX_FINDINGS);
    expect(r.dropped).toBe(3);
  });

  it('max 覆盖 + 批内去重 + 跨轮去重（existingTitles 归一化后比对）', () => {
    const r1 = coerceFindings([ok, { ...ok }], { max: 5 });
    expect(r1.accepted).toHaveLength(1);
    // 尾随空格 + 大小写差异在 normalizeTitle 后视为同一条
    const r2 = coerceFindings([ok], { existingTitles: ['删除按钮无二次确认 '] });
    expect(r2.accepted).toHaveLength(0);
    expect(r2.dropped).toBe(1);
  });

  it('reproSteps 超 10 条截断；非法非对象条目丢弃（字符串一句话条目除外）', () => {
    const steps = Array.from({ length: 15 }, (_, i) => ({ action: `步骤${i}` }));
    const r = coerceFindings([{ title: 'T', description: 'd', reproSteps: steps }, 42, null]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.reproSteps).toHaveLength(10);
    expect(r.dropped).toBe(2);
    expect(r.invalid).toBe(2);
  });

  // 2026-11-10 prod 实录：模型输出 {title,severity:"中",location,evidence}，
  // 旧实现只认 description → 全员静默丢弃（摘要说 5 条、库里 0 条）。
  it('字段别名容错：description ← evidence/detail/desc，location 并入描述', () => {
    const r = coerceFindings([
      { title: '责任人显示 undefined', severity: '中', location: '列表第2行「责任人」列', evidence: '单元格渲染为 undefined' },
      { title: 'IP 未校验', detail: '非法 IP 被接受' },
      { title: '名称未校验', desc: '空名称可提交' },
    ]);
    expect(r.accepted).toHaveLength(3);
    expect(r.accepted[0]!.description).toContain('渲染为 undefined');
    expect(r.accepted[0]!.description).toContain('列表第2行');
    expect(r.dropped).toBe(0);
  });

  it('中文判级映射：高→P1 / 中→P2 / 低→P3 / 致命→P0', () => {
    const r = coerceFindings([
      { title: 'A', description: 'a', severity: '高' },
      { title: 'B', description: 'b', severity: '中' },
      { title: 'C', description: 'c', severity: '低' },
      { title: 'D', description: 'd', severity: '致命' },
    ]);
    expect(r.accepted.map((f) => f.severity)).toEqual(['P1', 'P2', 'P3', 'P0']);
  });

  it('步骤别名容错：steps/repro 数组 + 字符串步骤', () => {
    const r = coerceFindings([
      { title: 'A', description: 'a', steps: ['打开列表', '点击新增'] },
      { title: 'B', description: 'b', repro: [{ step: '填非法 IP', expect: '应提示格式错误' }] },
    ]);
    expect(r.accepted[0]!.reproSteps).toEqual([{ action: '打开列表' }, { action: '点击新增' }]);
    expect(r.accepted[1]!.reproSteps).toEqual([{ action: '填非法 IP', expected: '应提示格式错误' }]);
  });

  it('标题与描述双缺才算废条目（invalid 计数与 dropped 分开）', () => {
    const r = coerceFindings([{ severity: 'P1' }, { title: 'T' }, { description: 'd' }]);
    expect(r.accepted).toHaveLength(0);
    expect(r.invalid).toBe(3);
    expect(r.dropped).toBe(3);
  });
});

// 2026-11-10 prod 实录：一次探索落了 7 条 ≈ 3 个真缺陷（标题逐字去重挡不住近义重报）。
describe('coerceFindings 近义标题合并', () => {
  const f = (title: string) => ({ title, description: 'd' });
  /** prod 实录的 7 条标题，期望聚成 3 组。 */
  const PROD7 = [
    '资产表格出现 undefined 与 NaN 展示',
    '资产列表出现 undefined / NaN 展示',
    '页面中文全部渲染为方框（字体缺失）',
    '页面所有中文渲染为方框（字体缺失）',
    '名称已填合法值时保存仍显示错误提示（疑似误报/提示未清除）',
    '页面全部中文渲染为方框（字体加载失败）',
    '名称填入合法值后保存，错误提示仍残留（疑似校验误报/提示未清除）',
  ];

  it('prod 7 条近义标题合并成 3 条', () => {
    const r = coerceFindings(PROD7.map(f));
    expect(r.accepted).toHaveLength(3);
    expect(r.dropped).toBe(4);
    expect(r.invalid).toBe(0);
    // 保留的是每组首条
    expect(r.accepted.map((x) => x.title)).toEqual([PROD7[0]!, PROD7[2]!, PROD7[4]!]);
  });

  it('跨轮近义重报也合并（existingTitles 命中）', () => {
    const r = coerceFindings([f('资产列表出现 undefined / NaN 展示')], {
      existingTitles: ['资产表格出现 undefined 与 NaN 展示'],
    });
    expect(r.accepted).toHaveLength(0);
    expect(r.dropped).toBe(1);
    expect(r.invalid).toBe(0);
  });

  it('指代不同对象的相似标题必须分开（行号/输入值/按钮/字段/校验项）', () => {
    const mustSplit: [string, string][] = [
      ['资产列表第2行责任人显示 undefined', '资产列表第3行责任人显示 undefined'],
      ['填写 999.999.999.999 后提示格式错误', '填写 192.168.1.1 后仍提示格式错误'],
      ['保存按钮点击后无响应', '删除按钮点击后无响应'],
      ['登录页用户名为空时也能提交', '登录页密码为空时也能提交'],
      ['金额输入负数后校验通过', '金额输入超大值后校验通过'],
      ['名称必填校验缺失', '名称长度上限未校验'],
    ];
    for (const [a, b] of mustSplit) {
      const r = coerceFindings([f(a), f(b)]);
      expect(r.accepted, `${a} || ${b}`).toHaveLength(2);
    }
  });

  it('措辞差异较大的同缺陷仍合并（点击无响应 vs 点了没反应）', () => {
    const r = coerceFindings([f('列表页分页控件点击无响应'), f('列表页分页控件点了没反应')]);
    expect(r.accepted).toHaveLength(1);
    expect(r.dropped).toBe(1);
  });
});

// 2026-11-10 prod 实录（会话 988ef20c）：模型输出 {type,描述,证据} 三轮共 8 条全 invalid
// （type 不在 title 别名表、证据不在 description 别名表）→ 库 0 行、摘要说 3 条。
describe('coerceFindings 再容错之三：{type,描述,证据} 形状', () => {
  it('type 当标题兼分类词；描述为主描述、证据并作补充段', () => {
    const r = coerceFindings([
      { type: '表格数据展示异常', 描述: '金额列显示 undefined', 证据: '第2行金额单元格文本为 undefined' },
    ]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.title).toBe('表格数据展示异常');
    expect(r.accepted[0]!.description).toContain('金额列显示 undefined');
    expect(r.accepted[0]!.description).toContain('证据：第2行金额单元格文本为 undefined');
    expect(r.invalid).toBe(0);
  });

  it('只有 type+证据（无描述）也能成条：证据升格为主描述且不重复拼接', () => {
    const r = coerceFindings([{ type: '校验缺失', 证据: '名称留空点击保存直接提交成功' }]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.title).toBe('校验缺失');
    expect(r.accepted[0]!.description).toBe('名称留空点击保存直接提交成功');
  });

  it('既有 title 与 type 并存时 title 优先（type 不抢位）', () => {
    const r = coerceFindings([{ title: '金额列显示 undefined', type: '数据展示', 描述: '第2行金额为 undefined' }]);
    expect(r.accepted[0]!.title).toBe('金额列显示 undefined');
  });
});

describe('coerceFindings 再容错（11-10 prod 二次形状漂移：6 条全 invalid）', () => {
  it('字符串条目也收：一句话当标题兼描述', () => {
    const r = coerceFindings(['表格第2行金额列显示 undefined', '  ', '保存后提示不消失']);
    expect(r.accepted).toHaveLength(2);
    expect(r.accepted[0]!.title).toBe('表格第2行金额列显示 undefined');
    expect(r.accepted[0]!.description).toBe('表格第2行金额列显示 undefined');
    expect(r.accepted[0]!.severity).toBe('P2');
    expect(r.dropped).toBe(1);
    expect(r.invalid).toBe(1);
  });

  it('中文字段名容错：标题/描述/严重程度/复现步骤', () => {
    const r = coerceFindings([
      {
        标题: '资产列表金额列显示 NaN',
        描述: '第3行金额列渲染为 NaN',
        严重程度: '高',
        位置: '资产列表第3行',
        复现步骤: [{ 操作: '打开列表', 预期: '金额为数字' }],
      },
    ]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.title).toBe('资产列表金额列显示 NaN');
    expect(r.accepted[0]!.description).toContain('第3行金额列');
    expect(r.accepted[0]!.description).toContain('位置：资产列表第3行');
    expect(r.accepted[0]!.severity).toBe('P1');
    expect(r.accepted[0]!.reproSteps).toEqual([{ action: '打开列表', expected: '金额为数字' }]);
  });

  it('被拒条目返回形状指纹（keys:/string:/array:）供日志归因', () => {
    const r = coerceFindings([{ 别名: 'x' }, ['a', 'b'], { title: '', description: 'd' }]);
    expect(r.accepted).toHaveLength(0);
    expect(r.invalid).toBe(3);
    expect(r.invalidShapes).toEqual(['keys:别名', 'array:2', 'keys:title,description']);
  });
});

describe('mergeExplorationTrails - 老会话回落合并', () => {
  it('按 finding 顺序拼接各片段，保留 detail', () => {
    const steps = mergeExplorationTrails([
      { actionsTrail: [{ type: 'click', target: '#save', ok: true }, { type: 'sql', target: 'SELECT 1', ok: true, detail: '1 行' }] },
      { actionsTrail: [{ type: 'navigate', target: 'http://x/', ok: false }] },
    ]);
    expect(steps.map((s) => s.type)).toEqual(['click', 'sql', 'navigate']);
    expect(steps[1]!.detail).toBe('1 行');
    expect(steps[2]!.ok).toBe(false);
  });

  it('脏留痕兜底：缺字段补默认值，空片段跳过', () => {
    const steps = mergeExplorationTrails([
      { actionsTrail: null },
      { actionsTrail: [{ type: 'sql' } as never] },
      { actionsTrail: [] },
    ]);
    expect(steps).toEqual([{ type: 'sql', target: '', ok: false }]);
  });
});

// 升格用例的 best-effort 机械映射（2026-11-11 口径）：平台留痕 → {instruction, compiled|null}[]。
describe('trailToCaseSteps - 留痕升格用例步骤', () => {
  it('click/fill/navigate 映射机械 DSL；instruction 与 trailToSteps 同口径', () => {
    const steps = trailToCaseSteps([
      { type: 'navigate', target: 'https://sut.example.com/app', ok: true },
      { type: 'fill', target: 'input[name="username"]', value: '测试数据', ok: true },
      { type: 'click', target: 'button.el-button--primary', ok: true },
    ]);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({
      instruction: '访问 https://sut.example.com/app',
      compiled: [{ kind: 'navigate', url: 'https://sut.example.com/app' }],
    });
    expect(steps[1]!.compiled).toEqual([
      { kind: 'fill', locator: [{ strategy: 'css', value: 'input[name="username"]' }], value: '测试数据' },
    ]);
    expect(steps[1]!.instruction).toBe('在 input[name="username"] 输入内容');
    expect(steps[2]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: 'button.el-button--primary' }] }]);
  });

  it('text= 形态 selector 映射为 text 策略 locator', () => {
    const steps = trailToCaseSteps([{ type: 'click', target: 'text=查询', ok: true }]);
    expect(steps[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'text', value: '查询' }] }]);
  });

  it('坐标形态 target / fill 缺 value（老会话数据）→ 该步回落 NL', () => {
    const steps = trailToCaseSteps([
      { type: 'click', target: '(320,180)', ok: true },
      { type: 'fill', target: 'input[name="q"]', ok: true },
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.compiled).toBeNull();
    expect(steps[1]!.compiled).toBeNull();
  });

  it('固化防线逐条生效：凭据占位符 / 激活态 class / 裸标签 / Playwright 专有语法 → 回落 NL', () => {
    const steps = trailToCaseSteps([
      { type: 'fill', target: 'input[name="user"]', value: '__ITEST_USERNAME@web__', ok: true },
      { type: 'click', target: 'a.router-link-active', ok: true },
      { type: 'click', target: 'button', ok: true },
      { type: 'click', target: 'div:has-text("查询") span', ok: true },
    ]);
    expect(steps).toHaveLength(4);
    for (const s of steps) expect(s.compiled).toBeNull();
  });

  it('press 回落 NL（页面级键盘无对应 DSL）；instruction 带真实键名', () => {
    const steps = trailToCaseSteps([{ type: 'press', target: 'Enter', key: 'Enter', ok: true }]);
    expect(steps).toEqual([{ instruction: '按键 Enter', compiled: null }]);
  });

  it('wait 折进前一步 compiled 尾部（waitFor 空 locator）；无前步时回落 NL', () => {
    const folded = trailToCaseSteps([
      { type: 'click', target: '#submit', ok: true },
      { type: 'wait', target: '1500', ms: 1500, ok: true },
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.compiled).toEqual([
      { kind: 'click', locator: [{ strategy: 'css', value: '#submit' }] },
      { kind: 'waitFor', locator: [], timeoutMs: 1500 },
    ]);
    const orphan = trailToCaseSteps([{ type: 'wait', target: '500', ms: 500, ok: true }]);
    expect(orphan).toEqual([{ instruction: '等待 500 毫秒', compiled: null }]);
  });

  it('失败动作 / sql / repo / screenshot 取证观察动作被滤掉（不进用例步骤）', () => {
    const steps = trailToCaseSteps([
      { type: 'click', target: '#wrong', ok: false },
      { type: 'click', target: '#save', ok: true },
      { type: 'sql', target: 'SELECT 1', ok: true, detail: '1 行' },
      { type: 'repo', target: 'src/a.ts', ok: true },
      { type: 'screenshot', target: '@100,200', ok: true },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.instruction).toBe('点击 #save');
  });

  it('脏形状兜底：空数组 / 非对象条目 / 缺 type 全滤；全滤后返回空（路由据此回落模型步骤）', () => {
    expect(trailToCaseSteps([])).toEqual([]);
    expect(trailToCaseSteps([null as never, 42 as never, { target: '#x', ok: true }, { type: '', target: '#x', ok: true }])).toEqual([]);
  });
});
