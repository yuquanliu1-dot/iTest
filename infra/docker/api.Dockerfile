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
    API_PORT=54321 \
    PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright \
    PI_DATA_DIR=/repo/apps/api/.data
# 运行时系统依赖:repo checkout 需要 git + ca-certificates;repo_grep 需要 ripgrep;
# chromium 需要一组图形/字体库(playwright-core 自带 CLI 装浏览器,--with-deps 装系统 so)。
# python3:AI 助手 run_skill_script 的 python3 runtime(另有默认自带 node/bash/sh)。
# python3-yaml:官方 skill-creator 的 scripts/quick_validate.py 需要 PyYAML(2026-10-19)——
#   走 apt 系统包而非 pip:bookworm 自带,不用 --break-system-packages/venv。
# bookworm-slim 不带任何系统二进制,apt-get 必须。详见 infra/docker/certs/README.md。
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates ripgrep unzip python3 python3-yaml \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
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
# NODE_OPTIONS=--dns-result-order=ipv4first:prod228 只解析到 registry.npmjs.org 的 IPv6 地址且 IPv6
#   出口不通,corepack 拉 pnpm 会挂在 fetch(实测 curl 默认超时、curl -4 秒回 200)。pin IPv4 优先后
#   构建不再取决于宿主机的 IPv6 状态——同样的坑也会让 pnpm install 随机失败。
ENV NODE_OPTIONS=--dns-result-order=ipv4first
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate \
 && pnpm install --prod --frozen-lockfile --filter @itest/api... --filter @itest/shared --filter @itest/recorder --filter @itest/ui
# chromium 离线优先:国内直连 playwright CDN 极慢(实测 11min+/browser),预下载 zip 放服务器
# infra/docker/(c1243-*.zip 共 ~316MB,不进 git 也不进 release tarball,由运维 scp 预置;
# tar 解包不删已有文件,所以 zip 在服务器上持续可用)。COPY 整目录后按存在性分流,
# zip 缺失时回落网络下载(慢但可用,失败仅告警,deploy.sh smoke 会早期发现)。
# 版本对应 playwright-core ~1.63 browsers.json 的 chromium build 1243;升级 playwright 时需同步换 zip。
COPY infra/docker/ /tmp/itest-pw/
RUN mkdir -p /root/.cache/ms-playwright \
 && if [ -f /tmp/itest-pw/c1243-chrome.zip ] && [ -f /tmp/itest-pw/c1243-shell.zip ]; then \
      unzip -q /tmp/itest-pw/c1243-chrome.zip -d /root/.cache/ms-playwright/chromium-1243 \
   && unzip -q /tmp/itest-pw/c1243-shell.zip -d /root/.cache/ms-playwright/chromium_headless_shell-1243 \
   && touch /root/.cache/ms-playwright/chromium-1243/INSTALLATION_COMPLETE \
            /root/.cache/ms-playwright/chromium_headless_shell-1243/INSTALLATION_COMPLETE \
   && echo "chromium installed from offline zips"; \
    else \
      pnpm exec playwright-core install chromium chromium-headless-shell \
   || echo "WARN: playwright browser install failed; chrome may be missing at runtime"; \
    fi \
 && rm -rf /tmp/itest-pw
EXPOSE 54321
# schema 同步用 drizzle-kit push（schema.ts 是真相源，migrations 历史不完整不可回放）；
# migrate.js 先取 PG advisory lock 再 push，串行化多容器并发启动，防互相冲突。
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]