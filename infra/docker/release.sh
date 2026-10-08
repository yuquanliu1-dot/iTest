#!/usr/bin/env bash
# 本地一键发布：打包仓库 → 上传 tarball → 远程执行 deploy.sh（非首次自动备库）。
# 目标服务器配置在 infra/docker/deploy.env（模板见 deploy.env.example，勿提交）。
#
# 用法:
#   infra/docker/release.sh            # 正式发布
#   infra/docker/release.sh --dry-run  # 只打包不上传不部署
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "未知参数: $arg"; echo "用法: $0 [--dry-run]"; exit 1 ;;
  esac
done

ENV_FILE="${DEPLOY_ENV_FILE:-$SCRIPT_DIR/deploy.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "缺少配置文件 $ENV_FILE"
  echo "先复制模板并填写: cp $SCRIPT_DIR/deploy.env.example $SCRIPT_DIR/deploy.env"
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

: "${DEPLOY_SSH_USER:?deploy.env 缺少 DEPLOY_SSH_USER}"
: "${DEPLOY_SSH_HOST:?deploy.env 缺少 DEPLOY_SSH_HOST}"
DEPLOY_SSH_PORT="${DEPLOY_SSH_PORT:-22}"
DEPLOY_REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/home/wangb/itest}"
DEPLOY_BACKUP_KEEP="${DEPLOY_BACKUP_KEEP:-10}"

if [ -n "${DEPLOY_SSH_PASSWORD:-}" ] && ! command -v sshpass >/dev/null 2>&1; then
  echo "deploy.env 配置了 DEPLOY_SSH_PASSWORD 但本机没有 sshpass（brew install hudochenkov/sshpass/sshpass 或 apt install sshpass）"
  exit 1
fi

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -p "$DEPLOY_SSH_PORT")
if [ -n "${DEPLOY_SSH_PASSWORD:-}" ]; then
  run_ssh() { sshpass -p "$DEPLOY_SSH_PASSWORD" ssh "${SSH_OPTS[@]}" "$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST" "$@"; }
  put_file() { sshpass -p "$DEPLOY_SSH_PASSWORD" scp -P "$DEPLOY_SSH_PORT" -o StrictHostKeyChecking=accept-new "$1" "$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST:$2"; }
else
  run_ssh() { ssh "${SSH_OPTS[@]}" "$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST" "$@"; }
  put_file() { scp -P "$DEPLOY_SSH_PORT" -o StrictHostKeyChecking=accept-new "$1" "$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST:$2"; }
fi

echo "== 打包 =="
GIT_SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
echo "来源: $ROOT @ $GIT_SHA"
TMP_LOCAL="$(mktemp -d)"
trap 'rm -rf "$TMP_LOCAL"' EXIT
TARBALL="$TMP_LOCAL/itest.tar.gz"
# 不带 ./ 前缀的模式同时被 GNU/bsdtar 理解为按路径段匹配；dist/modules/*.js 在镜像内重建，无需随包携带
tar -C "$ROOT" -czf "$TARBALL" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.worktrees' \
  --exclude='.superpowers' \
  --exclude='.claude' \
  --exclude='.turbo' \
  --exclude='.data' \
  --exclude='dist' \
  --exclude='coverage' \
  --exclude='screenshots' \
  --exclude='.DS_Store' \
  --exclude='*.log' \
  --exclude='.env' \
  --exclude='deploy.env' \
  .
ls -lh "$TARBALL"

if [ "$DRY_RUN" = "1" ]; then
  echo "--dry-run: 跳过上传与部署（tarball 保留在 ${TARBALL}）"
  trap - EXIT
  exit 0
fi

echo "== 上传 =="
put_file "$TARBALL" "$DEPLOY_REMOTE_DIR.tar.gz"

echo "== 远程部署 =="
# 先解包（含最新的 deploy.sh），再执行——绝不让脚本执行中自我覆盖
run_ssh "
  set -e
  mkdir -p '$DEPLOY_REMOTE_DIR'
  tar xzf '$DEPLOY_REMOTE_DIR.tar.gz' -C '$DEPLOY_REMOTE_DIR'
  BACKUP_KEEP='$DEPLOY_BACKUP_KEEP' bash '$DEPLOY_REMOTE_DIR/infra/docker/deploy.sh' '$DEPLOY_REMOTE_DIR'
"
