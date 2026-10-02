# 用例步骤编辑优化设计

日期：2026-10-02
状态：已确认（用户逐节审阅通过）

## 背景与问题

CaseDetail 页面的步骤列表当前存在以下体验问题：

- 步骤正文直接渲染 `JSON.stringify(s.action)` 原文（CaseDetail.tsx:680-682），可读性差
- 编辑弹窗 `StepEditModal.tsx`（748 行、420px 宽）只能改 name/delayMs/部分值，**locator 完全不可编辑**，定位错了只能重录
- 排序只有上移/下移一格，无拖拽
- 无单步复制；多选粘贴只能追加到末尾
- 前端无 zod 校验，错误要等保存时后端返回 422 才暴露
- 类型切换白名单（SWITCHABLE）过窄

## 目标（按优先级）

1. 步骤可读性 + 完整编辑：列表显示中文摘要；右侧抽屉结构化表单，全部 15 种操作类型的 locator/类型/值完整可编辑
2. 拖拽排序 + 批量操作：dnd-kit 拖拽重排、单步复制、粘贴插入到选中位置之后
3. 校验前置：保存前前端 zod 校验，字段级错误标红

## 明确不做

- 内联快捷编辑（列表里直接改）
- 重做 redo（现有 20 层撤销 Cmd+Z 保持不变）
- 后端任何改动（现有 `PUT /cases/:id/steps`、`PUT /steps/reorder`、`api.attachments.upload` 全部够用）

## 方案总览

| 决策点 | 选择 | 备选与否决理由 |
|---|---|---|
| 编辑形态 | 右侧抽屉（520px，基于 @radix-ui/react-dialog 侧边样式） | 居中大弹窗：多屏下视线跳跃；行内展开：行长变化大、实现复杂 |
| 表单覆盖 | 组件化全覆盖 15 种；assertJson 的 equals 降级为 JSON 文本域 + 校验；aiStep 维持 instruction 编辑 | 只做常用 8 种：体验不一致；zod 自动表单：union/中文文案适配成本高于收益 |
| 拖拽 | @dnd-kit/core + @dnd-kit/sortable（新依赖 ~13KB gzip） | 原生 HTML5 DnD：无自动滚动；sortablejs：命令式需包装层 |

## 组件 1：列表可读性 — `stepSummary`

新建 `apps/web/src/lib/stepSummary.ts`：

```ts
stepSummary(action: unknown): string
```

按 kind 生成中文摘要：

| kind | 摘要示例 |
|---|---|
| navigate | `打开 https://example.com`（超长 CSS 截断） |
| click / hover / check / waitFor / assertVisible | `点击 登录按钮`——文案优先取 intentLocator.contextText，否则首个 locator 的 `strategy=value` |
| fill | `填写 用户名 = abc***`（sensitive 时值脱敏为 `***`） |
| select | `选择 值` |
| assertText | `断言文本 包含「登录成功」`（按 match 取 包含/等于/不包含/正则） |
| extract | `抽取 → {{varName}}` |
| switchTab | `切换标签 {tabRef}` |
| upload / screenshot | `上传文件` / `截图 {name}` |
| assertJson | `断言 JSON` |
| aiStep | `AI：instruction 前 40 字` |

列表行布局改为 `中文标签（stepKindLabel，已有）· 摘要` 两段式；摘要 CSS 截断、hover `title` 显示全文；extract 变量徽标、aiStep 重编按钮保留不动。

## 组件 2：拖拽排序 + 批量操作

**拖拽**
- 新依赖：`@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`
- 列表外包 `DndContext` + `SortableContext`（verticalListSortingStrategy）
- 每行加拖拽手柄（grip 图标）；**仅手柄可触发拖拽**，避免与复选框/行内按钮冲突
- `onDragEnd` → 本地重排 → 现有 `PUT /steps/reorder`；顺序变更走 `mutateSteps`，自动进现有 20 层撤销栈
- 录制中（recorder.status === 'recording'）禁用拖拽；上移/下移按钮保留
- 列表行的类型切换下拉**移除**（能力挪进抽屉）

**批量操作**
- 单步复制：每行复制按钮 = 复制该步 + 立即粘贴到它后面，复用现有 `stepClipboard` 跨用例粘贴路径（id 处理、敏感值逻辑不重写）
- 粘贴到指定位置：有选中步骤时，粘贴插入到最后一个选中步骤之后；无选中维持现状追加末尾；工具栏文案标明插入位置

## 组件 3：编辑抽屉 `StepEditDrawer`

新建 `apps/web/src/components/StepEditDrawer.tsx`，替换并删除 `StepEditModal.tsx`（其中 upload 附件上传/选择逻辑 StepEditModal.tsx:646-716 整体迁入）。

- 容器：@radix-ui/react-dialog，Content fixed right、520px 宽、200ms 滑入；打开时列表对应行高亮；保存/取消后关闭

**表单四分区：**

1. 通用区：操作类型 select（全部 15 种可切换；切换走扩展后的 `webSwitchAction`（现定义于 CaseDetail.tsx，随本次重构迁到 `step-form/` 下）——locator 数组、intentLocator 等兼容字段保留，不兼容字段丢弃）、name、delayMs
2. 定位区（13 种有 locator 的类型）：`LocatorArrayEditor`——locator 是有序候选数组，每行 = strategy 下拉（role/text/testId/css/xpath）+ value 输入 + 删除；「添加候选」按钮；候选间上移/下移调优先级
3. 动作专属区（按 kind 分发，`ActionFields.tsx`）：

| kind | 字段 |
|---|---|
| navigate | url |
| fill | `FillValueEditor` 三模式：固定文本 / 生成器（randomString、randomNumber、timestamp、prefixTimestamp 子表单）/ 复合片段（fixed/date/randomNumber/randomString/timestamp 片段列表增删改）；sensitive 开关 |
| select | value |
| check | checked 开关 |
| waitFor | timeoutMs |
| assertText | target 下拉 + match 下拉 + equals 文本 |
| upload | 附件上传 + 已有附件选择（迁移现有实现） |
| switchTab | tabRef |
| screenshot | name |
| extract | varName + mode 下拉；regex 模式显 pattern + group；smartExtract 显 description |
| assertJson | equals JSON 文本域 + JSON.parse 校验 |
| aiStep | instruction 文本域（维持现状，compiled 只读展示） |

4. 保存：zod 校验全过 → `mutateSteps` + 现有全量保存接口（进撤销栈）→ 关闭抽屉；失败 → 错误字段标红 + 行内中文文案 + 焦点跳第一个错误

**落位：** `apps/web/src/components/step-form/` 目录：`LocatorArrayEditor.tsx`、`FillValueEditor.tsx`、`ActionFields.tsx`。

## 组件 4：校验前置 `stepValidation`

新建 `apps/web/src/lib/stepValidation.ts`：

```ts
validateStepEdit(input): { errors: Record<fieldPath, string> }
```

- 用 shared 包现成 `StepAction` zod schema parse，`flatten()` 后把字段路径映射中文文案（路径→文案映射表，如 `locator.0.value` →「候选 1 的值不能为空」）
- 附加前端独有校验：name ≤ 200 字、delayMs 为 0–60000 整数（与后端 routes/steps.ts:126-127 一致）、assertJson equals 必须是合法 JSON
- 触发时机：字段失焦单字段即时校验；保存全量校验，失败禁止提交
- 后端 422 保持为最终兜底

## 数据流

- 抽屉编辑本地 draft state → 保存时 zod 校验 → `mutateSteps` + `PUT /cases/:id/steps`（复用现有 CaseDetail 保存路径与撤销栈）
- 拖拽 `onDragEnd` → 本地重排 → `PUT /steps/reorder` → 失败时 react-query 回滚列表
- 单步复制/粘贴 → `stepClipboard` store（zustand）→ 粘贴插入路径走现有 mutateSteps

## 错误处理

- 拖拽 reorder 失败：toast + react-query invalidation 回滚
- 抽屉保存失败（网络/422）：抽屉保持打开、保留 draft，错误映射到字段或 toast
- 校验文案全部中文，与现有 UI 一致

## 测试策略

单元测试（vitest 已配置，`--passWithNoTests` 现状改为有针对性用例）：

- `stepSummary.test.ts`：15 种 kind 各一条 + sensitive 脱敏 + 长文本截断
- `stepValidation.test.ts`：locator 空值、fill 值缺失、CompositeValue 总长超 1024、assertJson 非法 JSON、delayMs 越界
- `webSwitchAction` 扩展：代表性 8 组切换，断言 locator/name 保留

组件测试：不为本次新增基建（YAGNI）；靠 `tsc typecheck` + 浏览器手动 QA（dev server 5173：编辑、拖拽、切换类型、校验报错、撤销、录制回归）。

回归点：录制流程入口禁用状态与现状一致；多选复制跨用例粘贴不受影响；AI 重编译按钮不受影响。
