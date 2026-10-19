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
COPY packages/shared/src ./packages/shared/src
COPY packages/ui/src ./packages/ui/src

RUN pnpm --filter @itest/web build

# ----- runtime -----
FROM nginx:1.27-alpine AS web
COPY --from=web-build /repo/apps/web/dist /usr/share/nginx/html
COPY infra/docker/web.nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]