# 内网 CA 证书

把内网 GitLab / GitHub Enterprise 的自签 CA 证书复制到此目录,命名为 `gitlab-ca.crt`(或任意 `*.crt`)。

构建 api 镜像时,`infra/docker/api.Dockerfile` 会自动:

1. `COPY infra/docker/certs/*.crt /usr/local/share/ca-certificates/`
2. `update-ca-certificates`

## 不强制

- 没有 .crt 文件不影响构建。
- 缺 CA 时,`git clone` 内网自签仓库会报 TLS 错误;缺 CA 的同时缺 git,会报 `ENOENT spawn git`(`runGit` 已把 ENOENT 翻译为 "git binary missing in runtime image")。

## 为什么需要这个目录

`infra/docker/api.Dockerfile` 的 runtime stage 基于 `node:22-bookworm-slim`,它不带任何系统二进制也不带 ca-certificates。git clone 走 HTTPS 时会同时卡两个点:缺 git 二进制 + 不信任自签证书。装包 + update-ca-certificates 一并解决。
