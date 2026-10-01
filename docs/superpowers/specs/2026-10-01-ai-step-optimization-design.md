# 智能步骤优化 v2：拆条 + 视觉识别（多模态 LLM）

日期：2026-10-01
状态：待用户审阅
上游参考：
- `docs/superpowers/specs/2026-10-01-step-settings-phase3-design.md`（已落地）
- 用户提供的 CueCast 智能步骤文档全文（本地 HTML）

## 背景与目标

phase 3 已经把 aiStep 的编译入口和基础执行链路（`compileAiStep` / `compileAiStepsInPlace` / `cdp.ts case 'aiStep'`）打通。CueCast 智能步骤文档还描述了几条尚未落到 iTest 的能力：

1. **保存时自动拆条**：当一条指令包含 `1. xxx` / `1、xxx` 编号时，拆成多条独立 aiStep，便于单步排障。
2. **空 instruction 兜底**：用户没填自然语言指令时，退回到用「步骤描述 / 步骤名」作为兜底指令。
3. **使用边界提示**：UI 明示智能步骤不适合登录/支付/删除等高风险路径、强对抗验证码等。
4. **基于选择器的视觉识别**：instruction 文本里 `#cssSelector` 占位符作为视觉输入/输出锚点；dispatch 阶段按选择器截图送多模态 LLM，结果文本填到目标输入框。CueCast 用例：`识别图片 #captchaImg 并输入到 #captchaInput`。

本期把以上四项一次性补齐。视觉识别在 OPENAI / ANTHROPIC 两家 provider 上同步落地，避免单 provider 不靠谱时无能力可用。

### 本期范围（YAGNI）

**做**：

- **A. 拆条**：服务端在 `steps PUT` 时检测编号格式 `^\s*\d+[\.\、]\s+`；一行一个编号段；剩余行作为该条 instruction。逐条独立编译；任一失败保留原 aiStep 不阻塞保存。
- **A. 兜底**：`instruction.trim() === ''` 时传 `step.name ?? '执行当前步骤'` 给 LLM，userMessage 标记 `[fallback-by-name]`。
- **A. UI 提示**：StepEditModal 在 aiStep 编辑区加「使用边界」折叠提示 + 实时「检测到 N 条编号，将拆为 N 步」静态展示。
- **B. 视觉识别**：`#cssSelector` 占位符；dispatch 时按占位符截图 → 视觉模型 → 结果文本填入第二个 `#sel`。无占位符 → 走原文本编译路径。
- **B. OPENAI / ANTHROPIC 双 provider**：`LLMClient.complete` 新增 `image` 参数；provider payload 形状按各自规范输出；LLM 未配置时 dispatch 退化为纯文本路径。
- **B. mock provider 补 vision**：本地开发与单测不依赖外部 key。

**明确不做**：

- 录制阶段实时预览视觉识别结果（避免录制依赖模型 key）。
- 滑块、点选、行为验证等强对抗验证码（CueCast 文档边界）。
- 视觉识别结果缓存（同 case 重跑仍重识别，先简单）。
- 拆条/视觉识别的语义版本号（DB schema 不动；同 phase 3 懒迁移思路，PUT 时升级）。
- 拆条指令格式扩展（仅支持 `\d+[\.\、]`；其它格式记入未来 todo）。

### 设计决策（已与用户确认）

| 议题 | 决策 |
|---|---|
| 范围划分 | 单 spec，阶段 A + 阶段 B 同稿；plan 分两段 |
| 视觉输入 | 基于选择器的截图输入 |
| LLM 供应商 | OPENAI + ANTHROPIC 双 provider + mock |
| 拆条时机 | 服务端拆条（PUT 时） |
| 视觉语法 | instruction 文本中的 `#cssSelector` 占位符 |
| 视觉动作归属 | 仍属 aiStep（同一 kind；不做 `visionRecog` 独立 kind） |
| UI 拆条预览 | 实时提示文案，不弹确认弹窗 |

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         apps/web                                │
│  StepEditModal (扩展)        CaseDetail (智能步骤边界提示)       │
│  - 使用边界折叠              - 高风险路径提示（独立列不做）       │
│  - 拆条预览实时文案                                             │
└─────────────────┬────────────────────────────┬─────────────────┘
                  │  PUT /cases/:id/steps       │
                  │  (Zod + migrate + split)     │
┌─────────────────▼────────────────────────────▼─────────────────┐
│                         apps/api                                │
│  steps.ts (入口)                                                │
│    ├─ aiStepSplit.ts (拆条)                                     │
│    ├─ aiStepCompile.ts (兜底 + 视觉识别)                        │
│    ├─ aiStepVision.ts (占位符解析 + 截图)                       │
│    └─ llm-{openai,anthropic,mock}.ts (provider 适配)            │
│  execute/cdp.ts                                                 │
│    - case 'aiStep': planWithVision → for sub dispatch(sub)     │
└─────────────────────────────────────────────────────────────────┘
```

## 数据形状

### DSL 新增（`packages/shared/src/step-dsl.ts`）

aiStep 不新增字段；约定由 server 端按 instruction 文本解析。

```ts
// aiStep 形状保持不变
export const AiStepAction = z.object({
  kind: z.literal('aiStep'),
  instruction: z.string().max(2000),
  compiled: z.array(StepAction).nullable(),
});

// 视觉识别占位符规则（文档注释，不进 DSL）：
//   "#cssSelector"  — 一个或两个；第一个是模式源，第二是可选输出填入
//   只允许 [a-zA-Z0-9_.\-#>+~*:[\]"=\s] 等安全字符
//   至少一个 → 走视觉路径；0 个 → 走纯文本路径
```

### LLMClient 扩展（`apps/api/src/agent/llm-client.ts`）

```ts
export interface LLMRequest {
  systemPrompt: string;
  userMessage: string;
  /** 多模态输入：当前只支持单图；后续可扩 image[] */
  image?: { base64: string; mime: 'image/png' | 'image/jpeg' };
}

export interface LLMResult {
  kind: 'json' | 'text';
  value: Record<string, unknown> | string;
  /** provider 标记；调试与日志用 */
  provider: 'openai' | 'anthropic' | 'mock';
  /** 是否走了视觉路径（image 已送） */
  vision: boolean;
}

export interface LLMClient {
  provider: 'openai' | 'anthropic' | 'mock';
  complete(req: LLMRequest): Promise<LLMResult>;
}
```

### provider payload（OPENAI / ANTHROPIC）

**OPENAI**：`POST /v1/chat/completions`
```json
{
  "model": "gpt-4o-mini",
  "messages": [
    {"role": "system", "content": "<systemPrompt>"},
    {"role": "user", "content": [
      {"type": "text", "text": "<userMessage>"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,<base64>"}}
    ]}
  ]
}
```

**ANTHROPIC**：`POST /v1/messages`
```json
{
  "model": "claude-3-5-sonnet-latest",
  "system": "<systemPrompt>",
  "messages": [
    {"role": "user", "content": [
      {"type": "text", "text": "<userMessage>"},
      {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "<base64>"}}
    ]}
  ]
}
```

### 拆条纯函数（`apps/api/src/agent/aiStepSplit.ts`）

```ts
/** 检测单条 aiStep 是否可拆；返回拆分后的 instruction 数组。无法拆则原样返回。 */
export function splitByNumber(raw: string): string[];

/** 整批拆条；输入 steps 数组，就地把 aiStep 拆为多条同 kind 步骤，并标记 originOrder。 */
export function splitAiStepsInPlace(
  steps: Array<{ action: unknown; order?: number }>,
): { expanded: number };
```

拆分规则：
- 行级扫描；匹配行首 `^\s*\d+[\.\、]\s+(.+)$` 的行视为编号段。
- 编号段之间允许有空白行；段内多行作为该条 instruction（用 `\n` 拼接）。
- 没有编号段 → 返回 `[raw]`。
- 拆出 1 条 → 返回 `[raw]`（不去凑数）。
- 拆出 ≥ 2 条 → 返回对应数组。

### 兜底（`apps/api/src/agent/aiStepCompile.ts`）

```ts
function buildEffectiveInstruction(step: { name?: string; description?: string }, raw: string): {
  text: string;
  fallback: boolean;
} {
  const trimmed = raw.trim();
  if (trimmed) return { text: trimmed, fallback: false };
  const fallback = step.name?.trim() || step.description?.trim() || '执行当前步骤';
  return { text: fallback, fallback: true };
}
```

`compileAiStep` 调用前把 `effective.text` 与 `effective.fallback` 一并传入 userMessage：

```
ai-step
<页面 URL: ...>
指令: <effective.text>[fallback-by-name]
<hint>
```

### 视觉识别占位符（`apps/api/src/agent/aiStepVision.ts`）

```ts
export interface VisionPlan {
  /** 是否走视觉路径（instruction 含占位符） */
  useVision: boolean;
  /** 截图源选择器；useVision 为 true 时必有 */
  sourceSelector?: string;
  /** 输出填入选择器；可选 */
  outputSelector?: string;
  /** 视觉识别后的剩余指令（移除占位符后；用于 systemPrompt 拼接） */
  cleanedInstruction: string;
}

/** 从 instruction 解析占位符；非法字符抛错。 */
export function planVision(raw: string): VisionPlan;
```

非法字符检测：`#([^\s^"]+)` 抓取整段 → 校验只含 `[a-zA-Z0-9_.\-#>+~*:[\]"=\s]`。非法抛 `InvalidVisionSelectorError`。

无视觉输入时 `useVision=false`，走原 `compileAiStep`；视觉失败时回退到无 `image` 的纯文本路径，再失败才抛错。

## 组件 / 模块拆分

| 文件 | 职责 |
|---|---|
| `apps/api/src/agent/aiStepSplit.ts` | 拆条纯函数 |
| `apps/api/src/agent/aiStepCompile.ts` | 兜底 + 视觉模式选择 + LLM 调用 |
| `apps/api/src/agent/aiStepVision.ts` | 占位符解析 + 截图执行 |
| `apps/api/src/agent/llm-client.ts` | `LLMRequest` / `LLMResult` / `LLMClient` |
| `apps/api/src/agent/llm-openai.ts` | OPENAI provider |
| `apps/api/src/agent/llm-anthropic.ts` | ANTHROPIC provider |
| `apps/api/src/agent/llm-mock.ts` | mock provider（已存在，补 vision 分支） |
| `apps/api/src/agent/llmSettings.ts` | 根据 env 选择 provider；新增 `visionSupported` 判断 |
| `apps/api/src/routes/steps.ts` | PUT 入口顺序：migrate → split → compile（含兜底） |
| `apps/api/src/execute/cdp.ts` | `case 'aiStep'`：planVision → 视 body → for sub dispatch |
| `apps/web/src/components/StepEditModal.tsx` | 智能步骤编辑区：使用边界折叠 + 拆条实时文案 |
| `apps/recorder/popup/panel.js` | 智能步骤 textarea 下方加「可用 `#cssSelector`」提示 |

## 数据流

### 保存

```
用户编辑 → StepEditModal (UI 提示)
   ↓
PUT /api/cases/:id/steps
   ↓
stepsRoute.put:
  1. Zod parse
  2. migrateAction(action)（phase 3 已有）
  3. splitAiStepsInPlace(steps)   ← 阶段 A
  4. compileAiStepsInPlace(steps, { fallbackOnEmpty: true })  ← 阶段 A
  5. 落库
```

### 回放

```
test_steps.action (aiStep)
   ↓
dispatch(action, opts):
  1. planVision(action.instruction)
  2. 若 useVision:
     a. screenshot($sourceSelector) → base64
     b. llm.complete({ systemPrompt, userMessage, image })
     c. 解析结果文本 → for sub in dispatch({ kind:'fill', locator:[outputSelector], value:text }, opts)
  3. 否则（无视觉）:
     for sub in (action.compiled ?? []) dispatch(sub, opts)
```

## 错误处理

| 场景 | 行为 |
|---|---|
| 拆条后某条编译失败 | 保留原 aiStep，`compiled: null`；不阻塞同批保存 |
| 空 instruction 但无 name | 兜底为字面量 `执行当前步骤`，记录 warn 日志 |
| 占位符字符非法 | 抛 `InvalidVisionSelectorError`，消息包含非法片段（截断 50 字符） |
| 视觉源选择器找不到元素 | 抛 `VisionSourceNotFoundError(selector)` |
| LLM provider 未配置 image | 抛 `LLMImageNotSupportedError`；dispatch 退化为纯文本路径 |
| 视觉识别返回空字符串 | 抛 `VisionEmptyResultError`；不静默回退 |
| OPENAI / ANTHROPIC HTTP 4xx/5xx | 抛 `LLMHttpError(status, body)`；dispatch 退化为纯文本路径（仅当 LLM 未带 image 时退；带 image 时直接抛错，让上层报告） |

## 测试策略

- **单元**：
  - `aiStepSplit.test.ts`：单编号段、多段、空行、纯文本不拆、拆出 1 条不拆。
  - `aiStepVision.test.ts`：占位符解析、合法性校验、无占位符走纯文本、source/output 顺序。
  - `aiStepCompile.test.ts`：补「空 instruction 兜底走 name」「带 image 走 vision provider」两个用例。
  - `llm-client.test.ts`：`LLMRequest` / `LLMResult` 形状契约。
  - `llm-openai.test.ts` / `llm-anthropic.test.ts`：用 `vi.fn()` mock `fetch`，断言 payload 形状与 image block 字段；返回响应后断言 result 形状。
- **集成**：
  - `execute-cdp.test.ts`：新增 `aiStepVision: 截图占位 → mock 视觉返回文本 → fill 目标` 一个用例。
  - `cases.test.ts`：新增「PUT 含可拆条的 aiStep → DB 落 N 条独立 aiStep」端到端用例。

## 风险与回退

| 风险 | 回退 |
|---|---|
| 双 provider 复杂度爆炸 | 一个 provider 出错时退化为纯文本路径；视觉失败不阻塞保存 |
| 视觉识别把生产路径绕过安全校验 | 在 UI 使用边界提示「不适用于强对抗验证码 / 高风险路径」；本期不做服务端拦截 |
| 拆条误拆（用户在 instruction 中写 1XXX 不是编号） | 严格锚定 `^\s*\d+[\.\、]\s+`；仅在多段时启用；单段与无段不拆 |
| 占位符误把无关注解当选择器 | 校验字符白名单 + 占位符必须是 `#` 起手 + 跟随非空白 |
| OPENAI / ANTHROPIC key 缺一不可 | mock provider 是默认；任意 provider 单独配置即可启用 |

## 自审记录

- **Spec 覆盖**：
  - 拆条 → aiStepSplit + steps.ts + 测试
  - 兜底 → aiStepCompile + uiStepEditModal 提示
  - 使用边界 → StepEditModal 折叠提示
  - 视觉语法 → aiStepVision 占位符解析
  - 视觉 provider → llm-openai / llm-anthropic / llm-mock 补 vision
  - 视觉 dispatch → cdp.ts case aiStep 分流 + 截图 + fill 目标
- **占位扫描**：无 TBD；每个测试 case 都给出。
- **类型一致性**：`LLMRequest.image` 形状在 client / openai / anthropic / mock 四处保持一致；占位符解析规则在 aiStepVision 与 cdp.ts 共享。
- **范围确认**：单 spec 双阶段，但 plan 切 task；满足「同 spec 多阶段 plan」用户选择。