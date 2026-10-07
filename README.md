# iTest

AI 驱动的自动化测试平台 MVP。

## 架构

Turborepo monorepo：

- `apps/api`：Node 22 + Express 5 + Drizzle + PostgreSQL
- `apps/web`：React 18 + Vite + Tailwind v4（端口 5173）
- `apps/recorder`：Chrome Manifest V3 扩展
- `packages/shared`：步骤 DSL + Zod schema
- `packages/ui`：设计令牌 + glass-panel 工具类
- 移动端测试：`agent-device` SDK（callstack）— `apps/api/src/execute/mobileEngine.ts`

## 端口

| 服务 | 端口 |
|---|---|
| Web | 127.0.0.1:5173 |
| API | 127.0.0.1:54321 |
| PostgreSQL | 127.0.0.1:5432 |
| Redis | 127.0.0.1:6379 |

## 启动

```bash
pnpm install
pnpm dev   # 自动：docker compose 起 PG/Redis → drizzle migrate → turbo 并行起 web + api
```

访问 http://localhost:5173。

前提：本机装有 Docker（用于 PG/Redis）与 Node 22 + pnpm 9。

## 用例执行（真实浏览器）

执行走 playwright-core 驱动本机 chromium（headless），逐步截图存到 `apps/api/screenshots/<reportId>/`。
chromium 二进制 **不会** 随 `pnpm install` 下载（playwright-core 不含浏览器安装器），需要本机已存在：

- 装过 `playwright` / `playwright-core` 的 `npx playwright install chromium`，缓存位于 `~/Library/Caches/ms-playwright`（macOS）/ `~/.cache/ms-playwright`（Linux）；或
- 设置 `CHROMIUM_PATH` 指向系统 chromium。

两者都缺失时执行自动回退 mock 路径（随机 80% 通过 + 占位截图），报告中会标注。

## Chrome 扩展加载

先 `pnpm --filter @itest/recorder build` 编译 modules/，再加载扩展

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」 → 选择 `apps/recorder/` 目录

## 核心流程

1. `/settings` 配置 LLM provider（默认 mock；支持 openai / anthropic / google，model 留空用各 provider 默认模型）
2. `/requirements` 新建需求 → 「⚡ 用 AI 生成用例」
3. `/cases` 看到生成的用例 → 进入详情（步骤可删除 / 上下移重排）
4. 用例详情页：「录制补充」（需 Chrome 扩展，模式 全新/追加/从这里开始/无痕）、「AI 补充步骤」、「执行」；步骤可编辑（名称/等待/随机值/敏感值/上传绑定）、复制粘贴、撤销、AI 步骤失败重编
5. `/reports` 查看执行结果（含逐步截图）

## 移动端测试

支持 **iOS Simulator** 与 **Android Emulator**。基于 [agent-device](https://github.com/callstack/agent-device) SDK 驱动模拟器，后端在 `apps/api/src/execute/mobileEngine.ts` 实现。

- **设备目标管理**：项目行右侧「设备目标」按钮 → `/p/:projectId/device-targets`，按 mobileOs 区分 ios/android，每条记录带 deviceRef（如 `iPhone 17 Pro`）和 appBundleId 兜底。
- **用例改 mobile**：用例详情 → 改 `platform='mobile'`、`mobileOs`、`mobileDeviceTargetId`、`appRef.bundleId`，保存后该用例走 MobileEngine 路由。
- **录制 Mobile**：用例详情 → 「录制 Mobile」按钮（依赖后端 mobile session WS — 任务单独跟踪）。
- **执行**：用例执行按 `platform` 路由到 MobileEngine（agent-device SDK）或 WebEngine（playwright-core）。
- **报告**：报告 header 显示 `mobileOs + deviceName` pill；右栏元数据卡显示平台/设备；步骤截图存到 `apps/api/screenshots/<reportId>/`。
- **手动验证**：项目根 `node apps/api/probe-mobile.mjs`（默认连本机 dev API；可设 `API_TOKEN/ORG_ID`；`DRY_RUN=1` 仅打印请求序列）。
- **当前边界**：暂不支持真机 / 云设备 / 屏幕录制；iOS 仅 Simulator，Android 仅 Emulator。

## 测试

```bash
pnpm verify  # lint + typecheck + test
```

后端测试需要 Docker 运行（testcontainers 起临时 PG）。apps/api 的 `pnpm test` 已固化 `TESTCONTAINERS_RYUK_DISABLED=true` 跳过 Ryuk 镜像拉取（仅在 Ryuk 镜像无法拉取的环境下需要）。

## MVP 范围

✅ 已实现：
- 需求 → 用例（Agent 工作流 + saveCase 工具落库；LLM 支持 mock / openai / anthropic / google）
- 用例 → 步骤（case2script 工作流 + saveSteps / getCase 工具）
- 用例执行（playwright-core 真实 chromium 回放，失败即停 + 逐步截图；无浏览器时 mock 回退）
- Chrome 扩展录制（点击 / 输入 / 悬浮 / 复选框 / 原生下拉 / 文件上传 / 文本与 JSON 断言 / AI 自然语言步骤 / 变量保存；录制模式 全新/追加/从这里开始/无痕；多标签页自动接管；AntD/Element/iView 组件识别与动态属性过滤；密码加密存储）
- 步骤编辑（删除 + 重排）
- SSE agent 事件流（step_start / step_text / step_complete / workflow_complete）
- 紫罗兰玻璃 UI 主题

❌ 不在 MVP：
- 多用户/权限
- i18n

## 已知边界（后续版本）

- 上传文件：单个文件 ≤ 50MB；按 sha256 跨用例复用；多文件 / 拖拽不支持
- 密码加密：使用 AES-256-GCM；密钥由 ENCRYPTION_KEY 环境变量提供（base64 32 字节），密钥丢失意味着密码不可恢复
- 组件识别仅覆盖 AntD / Element / iView
- 多标签页录制只接管由录制 tab opener 派生的 tab；手动打开的无关 tab 不接管
