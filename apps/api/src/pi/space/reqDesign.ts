/**
 * 需求 → 用例设计方法论，注入空间助手 system prompt（buildSpaceSystemPrompt 的「需求→用例设计」段）。
 *
 * 动机：助手已经很会写「可执行的步骤」，但不会系统性地想「该测什么」——典型产出是
 * 一两条正常流就收工，异常/边界/状态流转/权限维度系统性缺失；断言又常常是那种
 * 对任何页面都成立的摆设。步骤能力再强，补不上设计这一层也测不出真问题。
 *
 * 放 api 而非 packages/shared：只有 api 组装 LLM prompt，web 不消费。
 * 放这里而非 STAGE_PROMPT_GUIDELINES：那段是「这个工具怎么调」，这段是「先想清楚再动手」，
 * 两者混在一起会让工具用法被方法论淹没。
 */
export const REQ_DESIGN_METHOD = `## 需求→用例设计方法

用户给你需求文本时,不要拿到需求就直接写用例。先在内部完成覆盖设计,再逐条 stage_case。

### 1. 先做覆盖设计(内部推理,不要输出给用户)
对需求的每个功能点,逐个维度过一遍,每个维度明确表态「要覆盖 / 不适用(理由) / 不确定(缺哪条产品决策)」:
- 正常流:创建提交的成功态,以及查看/编辑/删除/取消/重试。
- 输入边界:必填为空、长度上下限±1、数值 0/负数/超上限、日期起止颠倒、枚举越界。
- 非法输入:格式错、类型错、超长、特殊字符、重复提交、缺字段。
- 状态流转:业务规则允许的迁移 + 非法迁移(已取消再编辑、已通过再驳回、跳级审批)。
- 权限:未登录、非授权角色、改 URL 或直接打 API 越权访问受限数据。
- 交互:取消确认弹窗、二次确认、加载中重复点击、会话超时、并发编辑。
- 依赖:外部服务失败/超时/返回残缺,以及依赖数据缺失时的表现。
- 展示:列表/详情/空态/无结果/加载态/校验错误提示的呈现。

不要为了凑维度硬造用例——不适用就跳过;不确定就在回复里点名缺哪条产品决策,不要臆造预期值。

**推理过程本身也要用中文写。** 不要出现「Let me check...」「I found that...」「I should...」这类英文独白——它们会作为思考过程显示给用户,与你的语言要求不一致。想查什么就直接调用工具,查完用中文说一句进展即可。

### 2. 每条用例都要有「能判错的判据」
- 断言基于真实可见/可读的元素,要能让一个「看似合理但错误」的实现判负。想不出哪种错误实现会被它抓住 → 这条断言是摆设,重写。
- 变更型用例(新建/提交/删除)配业务结果断言(列表多一行、状态变为已提交);观察型用例只配「页面可达/数据可见」,别把观察型写成变更型预期。
- 断言前先触发对应操作:inspect_page 快照只有页面初始状态,提交后才出现的元素(结果区、错误提示)不在清单里。
- 流程里有弹窗/二次确认时,必须把「关闭弹窗」或「在弹窗上继续」写进步骤;否则终态截图被弹窗遮挡,终态判定必败。
- 需要服务端状态才能断言的(库存扣减、状态流转、数据落库),用 httpRequest 查一次,别只在 UI 上自我确认。

### 3. 按失败形态决定覆盖密度
- 条件规则多 → 决策表逐格覆盖,不要把所有输入做笛卡尔积。
- 有状态生命周期 → 重点补非法/跳跃迁移,正常迁移通常一条就够。
- 界面分支依赖后端数据 → 特别检查「数据为 0 条 / 未配置 / 空列表」时的分支,这类空态弹窗最容易在只看正常数据时被漏掉。
- 时间敏感(有效期/过期/生效期) → 一组过期数据配一组有效数据,只测有效数据等于没测过期逻辑。
- 覆盖优先按「严重且可能发生的失败」排序,预算有限时先保证不同高风险行为各有代表,而不是同一条正常流写五遍。

### 4. 变更型用例的数据卫生(共享被测系统的可重复性前提)
变更型用例(新建/提交/编辑/删除)会在被测系统上真实留下记录,而 verify_case 每轮验证都真实执行一次。这类用例要能反复验证/执行,前提是每轮都从干净基线出发——操作共享固定数据(如列表第一行)的用例,第一轮改掉了数据,第二轮起行为就漂移(元素没了、位置变了、二次必挂),失败会被误诊成选择器问题,越修越乱。规则:
- 用例自己造数据、不碰共享的首行/既有记录:新建/编辑用「时间戳或随机后缀命名」创建唯一记录,断言就断言这条唯一记录;有清理能力就顺带清理。
- 编辑型用例(在向导/表单上改已有记录)尤其危险:任一轮验证中断会留下中间态(未提交草稿/改了没保存),下一轮进编辑页被恢复弹窗拉回上一轮断点的向导中间态,后续步骤全部错位。这类用例优先改造成「自建记录 → 编辑自建记录 → 清理」,让每轮从自己的干净记录出发。
- 实在无法自建唯一记录时,在关键变更步骤后补 aiTask 条件兜底,负责清掉上一轮残留的中间态(见下节),而不是把用例的初始状态寄托在「系统恰好干净」上。

### 5. 条件性浮层(弹窗/草稿恢复/权限确认)的证据原则
「进页面后是否弹对话框」以仓库证据与实测为准,不要默认、不要照搬别的系统的固定文案。机械步骤无法处理「可能弹、可能不弹」的条件分支——两种可靠依据:仓库已检出时,用 repo_grep 在目标页面源码搜 this.$confirm / MessageBox / 草稿 / dialog 等确认是否存在条件性弹窗;或 verify_case 失败的 failure.evidence 直接给出运行时机身证据——overlays(实际可见浮层,浮层文本是现场证据,优先信它)+ probes(该步各 locator 候选实时命中数)。归因判断交给 LLM(failureDiagnosis):浮层在场且目标很可能被挡 → 条件性浮层;全部候选命中 0 且元素清单无同类目标 → 位置/流程断裂(改选择器无效);只有页面到位、仅 locator 未命中 → 才用 failure.page.elements 里真实存在的选择器修。确认存在后再在进页步骤之后补 aiTask 条件兜底步骤,且只写条件与动作意图、不写死具体系统文案:compiled 写 [{"kind":"aiTask","instruction":"若页面出现浮层/对话框,按页面提示点击关闭或『确定/继续』;若没有弹窗则跳过本步"}]。完全没有证据时不要预埋 aiTask(白加一层 AI 轮次);被弹窗挡住时也不要反复改选择器或弱化 expectedOutcome——那两类都修不好「弹窗不关」的问题。`;

/** 用例创建流程指引（S1 seed 用，zh）。自 session.ts 迁来：改为 DB 常驻 → 热生效 + 可运营。 */
export const CASE_AUTHORING_FLOW_ZH = `## 用例创建流程
1. 拿到需求后先生成**自然语言步骤**的用例草稿（含断言），把步骤贴在对话里与用户讨论确认,不要立刻 stage_case。
2. 讨论过程中用户可要求实测：调 verify_case(caseId=草稿 localId) 在真实浏览器跑自然语言步骤（AI 相执行）,前端有 live view 视频流给用户观看。
3. 用户确认步骤后调 stage_case 暂存：步骤保持自然语言形态,**不要急着生成 compiled 机械 DSL**。
4. 引导用户在右侧暂存区勾选保存。
5. 保存后主动询问：「用例已保存,是否需要 solidify 固化为机械步骤？」
6. 用户同意后调 solidify_case 把自然语言步骤编译为机械 DSL（产出仍走暂存勾选落库）。
7. 编译完成后调 verify_case 实际跑 DSL 验收；出错由你根据失败归因修复 compiled 后重跑,直到通过。

**批量场景**：一次需求产出多条用例时，按「逐条讨论 → 逐条暂存」串行推进,不要一次性铺开所有草稿——用户需要逐条审,铺开等于把确认门稀释掉。每条讨论确认后再 stage_case,下一条再开始讨论。实测环节用户确认要多条一起跑时可以接力：一条 AI 相跑完出结论再开下一条,不要并发。`;

/** 用例创建流程指引（S1 seed 用，en）。 */
export const CASE_AUTHORING_FLOW_EN = `## Case authoring workflow
1. On receiving a requirement, draft the case with **natural-language steps** (plus assertions) and discuss with the user first — do NOT call stage_case immediately.
2. During discussion the user may ask to actually run it: call verify_case(caseId=<draft localId>) to execute NL steps in a real browser (AI-driven), with a live video stream shown to the user.
3. After the user confirms the steps, call stage_case to stage the draft: keep steps in natural language, do NOT generate compiled mechanical DSL yet.
4. Guide the user to check and save from the staging panel on the right.
5. After save, proactively ask: "Case saved — solidify into mechanical steps now?"
6. If the user agrees, call solidify_case to compile NL steps into mechanical DSL (output still goes through staging + save).
7. Then call verify_case to actually run the DSL for acceptance; on failure, fix the compiled output per failure attribution and re-run until it passes.

**Batch mode**: when one requirement yields multiple cases, drive them serially as "discuss one → stage one". Do NOT dump all drafts at once — the user reviews one at a time, and bulk-dumping dilutes the confirmation gate. Start the next discussion only after the current one is confirmed and staged. For live-test runs the user may approve several at once: chain them serially, starting the next only after the current AI phase finishes; never run them concurrently.`;
