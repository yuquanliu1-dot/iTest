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
# vite copies public/ verbatim into dist — without it every /landing/*.png 404s and falls back to index.html,
# the browser renders text/html as an image → all landing screenshots break (observed on prod228, 2026-10-19).
COPY apps/web/public ./apps/web/public
COPY packages/shared/src ./packages/shared/src
COPY packages/ui/src ./packages/ui/src

RUN pnpm --filter @itest/web build
# The release pipeline is macOS bsdtar packing → Linux GNU tar unpacking; the mode of newly unpacked files = archive mode & ~umask;
# the server's umask 027 cuts 644 down to 640, the image inherits it and nginx's non-root worker cannot read → static assets 403
# (observed on landing/*.png, 2026-10-19). Permissions are fixed uniformly at build time: a+rX = all files readable, all directories enterable.
RUN chmod -R a+rX /repo/apps/web/dist

# ----- runtime -----
FROM nginx:1.27-alpine AS web
COPY --from=web-build /repo/apps/web/dist /usr/share/nginx/html
COPY infra/docker/web.nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]