# 2026-10-08 修复部署 api 容器缺失 git/ripgrep/ca-certificates

## 现象

生产环境 (192.168.30.228) 用户正确配置 `projects.repo_url/branch/pat/provider='gitlab'`,AI 助手反馈:

> 项目未配置 Git 仓库,repo 类工具不可用

`base-all / V1.13` (`projects 44e0bb98… / versions 6a51e566…`) 实测 `.data/workspaces/v-6a51e566…/repo/` 存在但为空 — 目录被 `createSpaceSessionFactory` (`apps/api/src/pi/space/session.ts:263`) `mkdir -p` 后,`cloneFirst` 失败触发 `cloneFirst` 的 `rm -rf`,留下空壳。

## 根因

`infra/docker/api.Dockerfile` runtime stage 基于 `node:22-bookworm-slim`,**只装了 Node + pnpm,没装 git / ca-certificates / ripgrep**:

```
$ docker exec itest-api sh -c "command -v git rg"
git  MISSING
rg   MISSING
$ docker exec itest-api sh -c "ls /etc/ssl"
ls: cannot access '/etc/ssl': No such file or directory
```

`apps/api/src/pi/repo.ts:264-274` 的 `runGit` 走 `spawn('git', …)`,容器内 ENOENT → reject 原始 `Error: spawn git ENOENT`。

`injectPat` (`apps/api/src/pi/repo.ts:253`) 在 `gitlabOverride=null` 时正确回退 `repoUrl`,逻辑无误。

`apps/api/src/pi/space/session.ts:113-131` `checkoutInBackground` 把非 `RepoUnavailableError` 落到 `repo.issue = e.message`,所以 AI 工具拿到的字符串是 "spawn git ENOENT",运维侧从这行也看不出"该改 Dockerfile"。

## 修复

1. `infra/docker/api.Dockerfile` runtime stage:在 `ENV …` 之后、`COPY --from=api-build` 之前插入:
   - `apt-get install git ca-certificates ripgrep`
   - 可选: `COPY infra/docker/certs/*.crt /usr/local/share/ca-certificates/` + `update-ca-certificates`(用于内网自签 GitLab/GHE)

2. `apps/api/src/pi/repo.ts` `runGit` 的 spawn error 回调:`code === 'ENOENT' && message includes 'git'` 时 reject `new Error('git binary missing in runtime image; rebuild infra/docker/api.Dockerfile with git installed')`。

3. `apps/api/src/pi/space/session.ts` `checkoutInBackground` 兜底分支:匹配 `/git binary missing|spawn git/` → 把 `repo.issue` 改成 `'git binary missing in container (rebuild api.Dockerfile)'`,其它错误照原样落 issue。

4. `infra/docker/certs/.gitkeep` + `README.md`:占位目录,运维把自签 CA 命名为 `gitlab-ca.crt` 放进即可。

## 复现

```bash
# 在容器里跑
docker exec itest-api sh -c "command -v git rg; ls /etc/ssl/certs/ca-certificates.crt 2>&1"
# 期望:全部存在;部署前全是 MISSING / No such file or directory
```

## 不变量

- `infra/docker/deploy.sh:25` 用 `.` 作 build context → `infra/docker/certs/` 自动入包。
- `infra/docker/release.sh:56-71` tar 排除列表不含 `infra/docker/certs/` → 自动入 tarball。
- `injectPat` / `loadProjectRepo` / `checkoutRepoForVersion` 逻辑正确,不动。
- 前端 `apps/web/src/pages/AssistantPage.tsx` 不需要改 — `lastError` 经后端 `repo.issue` 动态透出。

## 验证

1. 部署后 `command -v git rg` + `ls /etc/ssl/certs/ca-certificates.crt` 全部存在。
2. `curl http://127.0.0.1:54321/api/health` → 200。
3. 浏览器进入 `base-all/V1.13` AI 助手发条消息 → `docker exec itest-api ls .data/workspaces/v-6a51e566…/repo/.git/HEAD` 存在。
4. AI 端到端 `repo_ls`/`repo_read` 返回真实文件内容(不是"仓库尚未就绪"或"项目未配置 Git 仓库")。
