# iTest

AI 驱动的自动化测试平台 MVP。

## 架构

Turborepo monorepo：

- `apps/api`：Node 22 + Express 5 + Drizzle + PostgreSQL
- `apps/web`：React 18 + Vite + Tailwind v4（端口 5173）
- `apps/recorder`：Chrome Manifest V3 扩展
- `packages/shared`：步骤 DSL + Zod schema
- `packages/ui`：设计令牌 + glass-panel 工具类

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
4. 用例详情页：「▶ 录制补充」（需 Chrome 扩展）、「AI 补充步骤」、「▶ 执行」；步骤可编辑（名称/等待/随机值）、复制粘贴（跨用例）、撤销、AI 步骤失败重编
5. `/reports` 查看执行结果（含逐步截图）

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
- Chrome 扩展录制（点击 / 输入 / 悬浮 / 复选框 / 原生下拉 / 文件上传步骤 / 文本与 JSON 断言 / AI 自然语言步骤 / 变量保存，stop flush 握手防漏步骤）
- 步骤编辑（删除 + 重排）
- SSE agent 事件流（step_start / step_text / step_complete / workflow_complete）
- 紫罗兰玻璃 UI 主题

❌ 不在 MVP：
- 多用户/权限
- i18n
- 移动端适配

## 已知边界（后续版本）

- 组件库下拉（Ant Design / Element / iView Select）：当前录成普通点击序列，组件识别在后续版本增强
- 文件上传步骤：录制只记文件名，回放为空操作并提示，绑定回放文件在后续版本支持
- 密码输入：明文存储与展示，加密存储在后续版本支持
- 多标签页录制、录制模式（追加/从这里开始）：后续版本
