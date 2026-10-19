FROM node:22-bookworm-slim AS web-build
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json turbo.json ./
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts ./apps/web/
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/ui/package.json packages/ui/tsconfig.json ./packages/ui/

ENV CI=true
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate \
 && pnpm install --frozen-lockfile --filter @itest/web... --filter @itest/shared --filter @itest/ui

COPY apps/web/src ./apps/web/src
COPY apps/web/index.html ./apps/web/index.html
# vite 会把 public/ 原样拷进 dist——漏掉它则 /landing/*.png 全部 404 回落到 index.html，
# 浏览器拿到 text/html 当图片渲染 → landing 截图全裂（2026-10-19 prod228 实测）。
COPY apps/web/public ./apps/web/public
COPY packages/shared/src ./packages/shared/src
COPY packages/ui/src ./packages/ui/src

RUN pnpm --filter @itest/web build
# 发版链路是 macOS bsdtar 打包 → Linux GNU tar 解包，解包新建文件的模式 = 归档模式 & ~umask；
# 服务器 umask 027 会把 644 削成 640，镜像继承后 nginx 非 root worker 读不到 → 静态资源 403
# （2026-10-19 landing/*.png 实测）。构建期统一补权限：a+rX = 所有文件补可读、目录补可进入。
RUN chmod -R a+rX /repo/apps/web/dist

# ----- runtime -----
FROM nginx:1.27-alpine AS web
COPY --from=web-build /repo/apps/web/dist /usr/share/nginx/html
COPY infra/docker/web.nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]