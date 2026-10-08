FROM node:22-bookworm-slim AS api-build
WORKDIR /repo
# 拷贝 workspace 顶层
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json turbo.json ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/drizzle.config.ts ./apps/api/
COPY apps/recorder/package.json apps/recorder/tsconfig.json apps/recorder/tsconfig.build.json ./apps/recorder/
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/ui/package.json packages/ui/tsconfig.json ./packages/ui/

ENV CI=true
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate \
 && pnpm install --frozen-lockfile --filter @itest/api... --filter @itest/shared --filter @itest/recorder --filter @itest/ui

# 拷贝源码（仅 api 的运行时所需）
COPY apps/api/src ./apps/api/src
COPY apps/api/drizzle ./apps/api/drizzle
COPY apps/api/scripts ./apps/api/scripts
COPY packages/shared/src ./packages/shared/src
COPY packages/ui/src ./packages/ui/src
COPY apps/recorder/modules ./apps/recorder/modules

RUN pnpm --filter @itest/shared build || true \
 && pnpm --filter @itest/recorder build \
 && pnpm --filter @itest/api build

# ----- runtime -----
FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=54321
# 拷贝构建好的源码 + 依赖
COPY --from=api-build /repo /repo
WORKDIR /repo/apps/api
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate \
 && pnpm install --prod --frozen-lockfile --filter @itest/api... --filter @itest/shared --filter @itest/recorder --filter @itest/ui
EXPOSE 54321
# fresh DB schema 用 drizzle-kit push 同步（migrations 历史不完整，migrate 路径会失败）；后续启动才用 migrate 增量。
CMD ["sh", "-c", "pnpm exec drizzle-kit push --force && node dist/index.js"]