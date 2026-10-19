#!/usr/bin/env bash
# 本地一键发布：打包仓库 → 上传 tarball → 远程执行 deploy.sh（非首次自动备库）。
# 目标服务器配置在 infra/docker/deploy.d/<env>.env（目录已 gitignore，模板见 deploy.d/.env.example）。
# 推荐按目标命名（prod228.env / staging-31.env），方便一眼区分多台主机。
#
# 用法:
#   infra/docker/release.sh                                # 需要 --env,不默认
#   infra/docker/release.sh --env <name>                   # 指定环境（prod228 / staging-31 / ...）
#   infra/docker/release.sh [--env <name>] --dry-run       # 只打包不上传不部署
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) shift; ENV="${1:-}"; [ -n "$ENV" ] || { echo "--env 需要值"; exit 1; } ;;
    --env=*) ENV="${1#--env=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; sed -n '2,9p' "$0"; exit 1 ;;
  esac
  shift
done

if [ -z "$ENV" ]; then
  echo "必须指定 --env <name>(文件名= deploy.d/<name>.env)"
  sed -n '2,9p' "$0"
  exit 1
fi

# 凭证文件名限制:字母/数字/下划线/连字符,避免路径穿越
case "$ENV" in
  *[!A-Za-z0-9_-]*|'') echo "env name invalid: $ENV (only letters/digits/underscore/dash)"; exit 1 ;;
esac

ENV_FILE="${DEPLOY_ENV_FILE:-$SCRIPT_DIR/deploy.d/$ENV.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "缺少配置文件 $ENV_FILE"
  echo "先复制模板并按实际填写: cp $SCRIPT_DIR/deploy.d/.env.example $ENV_FILE"
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

: "${DEPLOY_SSH_USER:?deploy.d/$ENV.env 缺少 DEPLOY_SSH_USER}"
: "${DEPLOY_SSH_HOST:?deploy.d/$ENV.env 缺少 DEPLOY_SSH_HOST}"
DEPLOY_SSH_PORT="${DEPLOY_SSH_PORT:-22}"
DEPLOY_REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/home/wangb/itest}"
DEPLOY_BACKUP_KEEP="${DEPLOY_BACKUP_KEEP:-10}"
DEPLOY_API_REPLICAS="${DEPLOY_API_REPLICAS:-1}"
DEPLOY_EXEC_CONCURRENCY="${DEPLOY_EXEC_CONCURRENCY:-3}"

if [ -n "${DEPLOY_SSH_PASSWORD:-}" ] && ! command -v sshpass >/dev/null 2>&1; then
  echo "deploy.d/$ENV.env 配置了 DEPLOY_SSH_PASSWORD 但本机没有 sshpass（brew install hudochenkov/sshpass/sshpass 或 apt install sshpass）"
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
# 预检:录制回连地址指回环 = 用户浏览器里的扩展必连不上(2026-10-09 prod228 踩过)。
# 只告警不阻断:确有"浏览器就跑在服务器上"的用法时允许放行。
ENV_PROD="$ROOT/infra/docker/.env.production"
if [ -f "$ENV_PROD" ]; then
  WS_URL="$(grep -E '^RECORDER_PUBLIC_WS_URL=' "$ENV_PROD" | cut -d= -f2- || true)"
  if [ -z "$WS_URL" ]; then
    echo "⚠️  WARN: .env.production 缺少 RECORDER_PUBLIC_WS_URL，api 会回落 ws://127.0.0.1:54321/recorder，远程浏览器里的扩展连不上"
  elif echo "$WS_URL" | grep -qE '127\.0\.0\.1|localhost|::1'; then
    echo "⚠️  WARN: RECORDER_PUBLIC_WS_URL=$WS_URL 指向回环地址。扩展运行在用户浏览器里，回连地址必须是浏览器可达的主机地址(如 ws://<服务器IP>:8080/api/recorder)"
  fi
fi
GIT_SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
echo "来源: $ROOT @ $GIT_SHA"
TMP_LOCAL="$(mktemp -d)"
trap 'rm -rf "$TMP_LOCAL"' EXIT
TARBALL="$TMP_LOCAL/itest.tar.gz"
# --no-xattrs 是关键那条，不是 --exclude='._*'。
# macOS 会把 com.apple.provenance 等扩展属性写进 tar 的 pax 头(解包时 tar 会警告
# "Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.*'")，服务器侧 GNU tar
# 虽忽略这些头，但资源叉内容仍会落成 AppleDouble ._xxx 文件——实测 skill-creator
# 18 个文件在远端变成 41 个。文件名排除只在源目录已有 ._ 文件时有用，挡不住「由扩展
# 属性凭空生成」。--no-xattrs 从源头不打这些头，两者一起留着兜底。
# 不带 ./ 前缀的模式同时被 GNU/bsdtar 理解为按路径段匹配；dist/modules/*.js 在镜像内重建，无需随包携带
tar -C "$ROOT" --no-xattrs -czf "$TARBALL" \
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
  --exclude='._*' \
  --exclude='*.log' \
  --exclude='.env' \
  --exclude='deploy.env' \
  --exclude='deploy.d' \
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
# 先解包（含最新的 deploy.sh），再执行——绝不让脚本执行中自我覆盖。
#
# 解包前先清掉 AppleDouble 残骸。tar 解包是「覆盖」语义，不删旧文件：早于
# --no-xattrs 的 tarball 会把 macOS 扩展属性还原成 ._xxx 文件，这些文件一旦落到
# 服务器上就永久留在 checkout 里，后续每次发版都被 COPY 进镜像 build context——
# 实测 skill-creator 18 文件在远端变 41 个，且这 23 个垃圾文件会污染技能目录树。
# 本地 tarball 干净（已验证 24 条目 / 0 个 ._），所以源头只需清服务器这一份残留。
# 用 find -delete 而不是 rm：路径含中文/空格也安全，且不依赖 shell glob 展开。
run_ssh "
  set -e
  mkdir -p '$DEPLOY_REMOTE_DIR'
  find '$DEPLOY_REMOTE_DIR' -name '._*' -type f -delete 2>/dev/null || true
  tar xzf '$DEPLOY_REMOTE_DIR.tar.gz' -C '$DEPLOY_REMOTE_DIR'
  BACKUP_KEEP='$DEPLOY_BACKUP_KEEP' API_REPLICAS='$DEPLOY_API_REPLICAS' EXEC_CONCURRENCY='$DEPLOY_EXEC_CONCURRENCY' bash '$DEPLOY_REMOTE_DIR/infra/docker/deploy.sh' '$DEPLOY_REMOTE_DIR'
"
