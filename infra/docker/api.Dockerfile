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
# recorder 包：拷贝 manifest/popup/content/background 等运行时文件 + 已构建的 modules。
# node_modules 留给 pnpm install --prod 阶段拉齐；modules 在 pnpm --filter @itest/recorder build 后由 tsc/esbuild 生成。
COPY apps/recorder/manifest.json ./apps/recorder/manifest.json
COPY apps/recorder/popup ./apps/recorder/popup
COPY apps/recorder/content ./apps/recorder/content
COPY apps/recorder/background.js ./apps/recorder/background.js
COPY apps/recorder/modules ./apps/recorder/modules

RUN pnpm --filter @itest/shared build || true \
 && pnpm --filter @itest/recorder build \
 && pnpm --filter @itest/api build

# ----- runtime -----
FROM node:22-bookworm-slim AS api
# build context 默认从仓库根(infra/docker/deploy.sh:25 用 . 作 context)。
# WORKDIR /repo 让 infra/docker/certs 路径与 api-build stage 一致。
WORKDIR /repo
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=54321
# 运行时系统依赖:repo checkout 需要 git + ca-certificates;repo_grep 需要 ripgrep。
# bookworm-slim 不带任何系统二进制,apt-get 必须。详见 infra/docker/certs/README.md。
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/*

# 2026-10-09: 内网 GitLab 部署的证书仅签到 IP,无 SAN 匹配,git 默认会拒;
# 在镜像里全局关 TLS 验证。代价:整个容器内 git 都不校验证书,运维可控且写明出处。
RUN git config --global http.sslVerify false

# 自签 CA(可选;若 infra/docker/certs/*.crt 存在则 update-ca-certificates)。
# COPY 在 source 不匹配 glob 时整个构建会失败,所以用 RUN + shopt glob 探测 + cp,空目录也跑通。
# cert 拷贝 layer 与 update-ca-certificates 分开,避免任一步骤被 buildkit 缓存层复用导致 cert 缺失。
COPY infra/docker/certs/ /tmp/itest-certs/
RUN cp /tmp/itest-certs/*.crt /usr/local/share/ca-certificates/ 2>/dev/null || echo "no .crt files in infra/docker/certs/"
RUN rm -rf /tmp/itest-certs
RUN if ls /usr/local/share/ca-certificates/*.crt >/dev/null 2>&1; then \
      update-ca-certificates && echo "custom CAs loaded"; \
    else \
      echo "no custom CA certs; using system CA only"; \
    fi

# 拷贝构建好的源码 + 依赖
COPY --from=api-build /repo /repo
WORKDIR /repo/apps/api
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate \
 && pnpm install --prod --frozen-lockfile --filter @itest/api... --filter @itest/shared --filter @itest/recorder --filter @itest/ui
EXPOSE 54321
# fresh DB schema 用 drizzle-kit push 同步（migrations 历史不完整，migrate 路径会失败）；后续启动才用 migrate 增量。
CMD ["sh", "-c", "pnpm exec drizzle-kit push --force && node dist/index.js"]