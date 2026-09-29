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
# 1. 起 PG + Redis
docker compose -f infra/docker-compose.yml up -d

# 2. 应用 migration
cd apps/api && pnpm db:migrate && cd ../..

# 3. 一键启动 web + api
pnpm dev
```

访问 http://localhost:5173。

## Chrome 扩展加载

先 `pnpm --filter @itest/recorder build` 编译 modules/，再加载扩展

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」 → 选择 `apps/recorder/` 目录

## 核心流程

1. `/settings` 配置 LLM provider（默认 mock）
2. `/requirements` 新建需求 → 「⚡ 用 AI 生成用例」
3. `/cases` 看到生成的用例 → 进入详情
4. 用例详情页：「▶ 录制补充」（需 Chrome 扩展）、「▶ 执行（Mock）」
5. `/reports` 查看执行结果

## 测试

```bash
pnpm verify  # lint + typecheck + test
```

后端测试需要 Docker 运行（testcontainers 起临时 PG）。apps/api 的 `pnpm test` 已固化 `TESTCONTAINERS_RYUK_DISABLED=true` 跳过 Ryuk 镜像拉取（仅在 Ryuk 镜像无法拉取的环境下需要）。

## MVP 范围

✅ 已实现：
- 需求 → 用例（mock LLM）
- 用例 → 步骤（mock LLM）
- 用例执行（mock，80/20 通过率）
- Chrome 扩展骨架（WS 推送步骤）
- 紫罗兰玻璃 UI 主题

❌ 不在 MVP：
- 真实 CDP 回放
- 多用户/权限
- i18n
- 移动端适配
