# deploy.d/ — 多环境发布凭证目录

每个文件对应一个目标环境的发布配置，文件名即环境名（如 `prod.env` / `staging.env` / `dev.env`）。
`release.sh` 通过 `--env <name>` 选择要加载的文件，默认 `prod`。

## 首次使用

```bash
cd infra/docker/deploy.d
cp .env.example <env>.env
$EDITOR <env>.env          # 填入目标服务器的 SSH 凭据与远端路径
```

推荐按目标命名(如 `prod228.env` / `staging-31.env`),便于一眼区分多台 prod 主机。

新增环境直接 `cp <env>.env <other>.env` 后改值；旧 env 不会被覆盖。

## 文件命名约定

| 文件 | 加载方式 |
| --- | --- |
| `.env.example` | 模板，提交进 git |
| `README.md` | 本说明，提交进 git |
| `<env>.env` | 实际配置，被 gitignore 排除 |

`release.sh --env staging` 会尝试加载 `deploy.d/staging.env`；文件不存在则报错退出。

## 凭据存储安全

- 整目录除模板与 README 外全部走 `.gitignore` 的 `deploy.d/*` 通配
- 任何 `<env>.env` 都不应被 `git add` 显式提交
- 跨机器同步:推荐放密码管理器 / 1Password / KeePass,**不要** push 到任何远程

## sshpass 依赖

如果 `<env>.env` 里 `DEPLOY_SSH_PASSWORD` 非空,本机需要 `sshpass`:

- macOS: `brew install hudochenkov/sshpass/sshpass`
- Debian/Ubuntu: `apt install sshpass`

`DEPLOY_SSH_PASSWORD` 留空则走本机 ssh key,不依赖 sshpass。

## 常见工作流

```bash
# 干跑打包到 prod(不实际上传)
infra/docker/release.sh --env prod --dry-run

# 真发到 prod
infra/docker/release.sh --env prod

# 发到 staging
infra/docker/release.sh --env staging

# 自定义环境(临时测试)
cp deploy.d/.env.example deploy.d/sandbox.env
$EDITOR deploy.d/sandbox.env
infra/docker/release.sh --env sandbox --dry-run
```
