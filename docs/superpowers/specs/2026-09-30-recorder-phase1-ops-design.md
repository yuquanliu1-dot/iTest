# 录制增强一期：操作类型全覆盖 + 步骤维护

日期：2026-09-30
状态：已获批
上游参考：CueCast 录制功能文档（用户提供的完整功能说明）

## 背景与目标

录制是平台的核心入口，录制质量直接决定回放稳定性。当前 MVP 录制只支持 click / fill / hover 三种操作，断言步骤只能来自 AI 生成。本设计把录制操作类型补齐到文档要求的全集，并把步骤维护能力（随机值、复制粘贴、撤销）一并落地。

### 五期路线图（全景，本期只做 P1）

| 期 | 内容 | 前置 |
|---|---|---|
| **P1（本期）** | 操作类型全覆盖 + 步骤维护 | — |
| P2 | 录制模式：全新/追加/从这里开始（含前置回放）、无痕模式、面板辅助完善 | P1 |
| P3 | 多标签页录制与切换步骤 | P1 |
| P4 | 组件识别：AntD/Element/iView Select、Tree、动态属性过滤增强 | P1 |
| P5 | 密码加密存储与解密回放、上传文件绑定回放 | P1 |

## P1 范围

**做**：

- 复选框勾选/取消（change 事件采集，回放幂等）
- 原生 `<select>` 下拉选择（组件库下拉归 P4）
- 文件上传步骤采集（只存 locator + 当时文件名，**不存本机文件内容**）
- 断言录制：文本断言 + JSON 断言（整段深比较）
- AI 自然语言步骤：**保存时编译成具体 DSL**，回放确定性执行
- 变量保存与 `{{varName}}` 引用（执行期物化）
- 随机值生成器：随机字符串 / 随机数字 / 时间戳 / 前缀+时间戳
- 步骤维护：编辑（名称/等待时间/输入值/断言值）、单步与批量复制、同用例及跨用例粘贴、撤销（删除/重排/编辑/粘贴均可回退）
- 录制面板扩展（方案 A：原生 popup + content script 元素拾取模式）

**明确不做**（各归其期）：

- 组件库下拉 / Tree 识别（P4）
- 多标签页录制（P3）
- 密码脱敏加密存储（P5，P1 密码类输入明文编辑并在 README 标注限制）
- 上传文件绑定回放（P5，P1 上传步骤回放为空操作 + warning）
- 无痕模式（P2）
- 录制模式（全新/追加/从这里开始）（P2）

## DSL 扩展（packages/shared）

现有 8 种 action（navigate/click/fill/hover/waitFor/assertText/assertVisible/screenshot）不变，新增 6 种：

```ts
// 复选框：checked 为目标状态，回放时幂等（已符合状态则跳过操作直接通过）
CheckAction      = { kind: 'check', locator: Locator[], checked: boolean }

// 原生下拉：存选中 option 的 value（label 做展示名），回放 selectOption
SelectAction     = { kind: 'select', locator: Locator[], value: string }

// 文件上传：P1 只存 locator + 当时文件名（不存内容）；P5 再补 fileId 绑定
UploadAction     = { kind: 'upload', locator: Locator[], fileName?: string }

// JSON 断言：取元素文本 → JSON.parse → 与 equals 深比较；parse 失败即断言失败
AssertJsonAction = { kind: 'assertJson', locator: Locator[], equals: unknown }

// AI 步骤：录制时只存指令；保存时编译，compiled 落库生成的具体步骤
AiStepAction     = { kind: 'aiStep', instruction: string, compiled: StepAction[] | null }

// 保存变量：回放时抽取元素文本/值存入运行期变量表
ExtractAction    = { kind: 'extract', locator: Locator[], varName: string }
```

fill 的 `value` 从 `string` 扩为 `string | ValueGenerator`：

```ts
ValueGenerator =
  | { mode: 'randomString', length: number }
  | { mode: 'randomNumber', min: number, max: number }
  | { mode: 'timestamp' }                        // 当前时间戳(ms)
  | { mode: 'prefixTimestamp', prefix: string }  // 前缀 + 时间戳
```

**核心原则**：DSL 里始终存原始形态（`{{var}}` 模板和 generator 都不展开），每次执行时在 executor 内物化——同一条用例重复执行产生不同随机值，这正是随机值的用途。

## 采集设计（apps/recorder）

### 事件采集扩展（modules/recorder-manager.ts）

现有 click / input / mouseover 监听之外新增 `change` 监听：

| 事件来源 | 判定 | 产生步骤 |
|---|---|---|
| `input[type=checkbox]` change | 读 `target.checked` | `check`（含目标状态） |
| `select` change | 读选中 option 的 value + label | `select`（存 value） |
| `input[type=file]` change | 只取 `files[0].name` | `upload`（不读文件内容） |

同时修一个噪声问题：现有 onInput 对所有 input 触发 fill，需排除 `type=file` 和 `type=checkbox`，避免与 change 处理重复产出步骤。

### 元素拾取模式（content script 新增）

popup 点「保存变量 / 添加断言 / 记录悬浮」→ background 转发 `enter-pick` 给录制 tab → content script 进入拾取态：

- mousemove 给目标元素画高亮遮罩（fixed 定位 overlay，`pointer-events: none`）
- 点击：对目标跑 `generateLocators`，提取元素 text/value 快照，回传 popup 后退出拾取态
- Esc 取消
- 拾取态下普通事件录制**暂停**——拾取点击本身绝不能进步骤
- 同一套拾取逻辑三种入口复用，差别只在 popup 后续表单

### popup 扩展（原生 JS，方案 A）

现有「开始/停止」之外新增：

- **暂停/继续**：置 manager 标志位，事件照常触发但不产步骤
- **保存变量**：进入拾取 → 表单填变量名（按元素语义给默认值，如 `orderNo`）→ `extract` 步骤
- **添加断言**：进入拾取 → 表单选断言类型（文本/JSON）+ 期望值（文本默认填元素当前文本，可改）→ `assertText` / `assertJson` 步骤
- **记录悬浮**：进入拾取 → 确认直接产 `hover` 步骤（与参考文档一致：本次选择不另存为点击）
- **AI 步骤**：textarea 输入指令 → `aiStep` 步骤

### background / WS 链路

`toDSL` 映射表扩展新类型；WS 协议不变（`{type:'step', step}` 通用信封），`apps/api/src/recorder/ws.ts` 无改动。

## AI 步骤编译（保存时，服务端）

流程：录制结束 → web 调 save steps → API 落库前遍历 steps，遇 `aiStep` 用已配置的 LLM provider 编译：

1. Prompt 输入：自然语言指令 + 起始 URL + 前后相邻步骤（少量上下文），要求输出 DSL 步骤 JSON 数组
2. 输出经 zod `StepAction` 校验；不合法重试一次（附错误信息）
3. 成功：`compiled` 落库，回放时展开执行
4. 失败（两次都败或 LLM 不可用）：`compiled = null` 照常落库，步骤列表显示「编译失败」标记，步骤编辑页提供「重新编译」按钮——**不阻塞保存**

编译放服务端：LLM 密钥与 provider 配置只在 API。

## 变量系统与执行期物化

- 运行期变量表：executor 内一个 `Map<string, string>`，随每次执行新建（用例间不共享）
- `extract` 步骤：按 locator 取元素 `innerText`（input 类取 `value`）→ 存入 `vars[varName]`
- `fill` / `select` 的值执行前物化：
  1. generator 先求值
  2. 再替换 `{{varName}}` 模板；未定义变量 → 该步骤失败，报错列出缺失变量名
- 录制期不做变量解析（录的只是文本）；步骤编辑页输入值支持插入 `{{}}` 引用（下拉列出已定义变量名）

## 回放执行（apps/api/src/execute/cdp.ts）

`dispatch` 新增分支：

| kind | 行为 |
|---|---|
| `check` | 已符合目标状态则跳过（幂等），否则 `check()`/`uncheck()` |
| `select` | `selectOption(value)` |
| `upload` | P1 无绑定文件 → 记 warning 后跳过（不算失败）；结果带 `warning` 字段「待绑定回放文件」 |
| `assertJson` | 取文本 → `JSON.parse` → 与 `equals` 深比较 |
| `extract` | 取值入变量表 |
| `aiStep` | 正常路径不出现（已编译展开）；万一出现 → 步骤失败「AI 步骤未编译」 |

执行结果结构（`ExecStepResult`）扩一个可选 `warning` 字段（前端黄色标注），不改现有 `passed/failed` 语义。

## Web 步骤维护（CaseDetail）

- **步骤编辑**：步骤名、**等待时间**、输入值（固定值 / 四种生成器切换）、下拉选中值、断言期望值
  - 等待时间：现有 step 模型没有该字段，本期给 `test_steps` 加可空 `delay_ms` 列（drizzle migration），执行前 `page.waitForTimeout(delayMs)`；需要等待某元素出现时仍用 `waitFor` 步骤，二者不混
- **复制粘贴**：单步复制 + 复选批量复制 → store 剪贴板；粘贴插入到当前用例某步之后，或跨用例粘贴（用例选择器）；粘贴时重新分配 order
- **撤销**：步骤列表变更（删除/重排/编辑/粘贴）入历史栈，Ctrl+Z 和按钮均可，栈深 20
- 现有删除 / 拖拽重排保留不动

## 错误处理与测试

- 边界校验：API 收 steps 一律过 zod；AI 编译输出过 `StepAction`；执行前整条 DSL 校验，坏步骤在报告里标失败原因
- 单测：
  - recorder：change 事件三分支（checkbox/select/file）、file input 的 fill 抑制、拾取模式状态机
  - shared：generator 求值与模板替换
  - api：AI 编译三态（mock LLM：成功/重试/失败）、assertJson 深比较、变量物化
- 手动 E2E：录制 → 回放一条含 checkbox/下拉/断言/变量的用例，检查截图与报告

## 已知边界（随本期落地写入 README）

- 组件库下拉录出来的是普通点击序列，P4 优化定位质量
- 上传步骤回放为空操作（warning），P5 支持绑定回放文件
- 密码输入明文存储与展示，P5 加密
