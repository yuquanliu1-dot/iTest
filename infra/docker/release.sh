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
# 关键那条是 COPYFILE_DISABLE=1，不是 --exclude='._*'，也不是 --no-xattrs。
#
# macOS 的 tar 是 bsdtar(libarchive)，打包时会为每个文件【自动合成】一个
# AppleDouble 伴随条目 ._xxx，把扩展属性/资源叉内容装进去（COPYFILE 特性）。
# 这不是「源目录里已有的文件」，所以 --exclude='._*' 根本匹配不到（排除发生在
# 读取前，而此时那些条目还不存在）；--no-xattrs 同样无效——它只影响 pax 头，
# 不阻止 libarchive 合成伴随条目。实测：同一份目录，tar 条目 8 → 加
# COPYFILE_DISABLE=1 后 4，._ 条目 0。
#
# 危害：这些 ._xxx 落到服务器 checkout 后，tar 解包会原样写出（tar 解包是覆盖
# 语义、不删旧文件，于是它们永久滞留），随后被 COPY 进镜像 build context——
# 实测 skill-creator 18 个文件在远端变成 41 个，且 read_skill 会把 ._SKILL.md
# 这类噪声当真实文件列给模型。
#
# 三个保险都留着：COPYFILE_DISABLE 从源头断（主），.dockerignore 挡镜像侧
# （兜底），解包前 find -delete 清历史残留（治已污染的服务器）。
#
# 注意：macOS 的 `tar tzf` 自己会【隐藏】这些条目，用它自查会误判为 0——
# 必须用 GNU tar 或 python tarfile 读。用 python tarfile 验：条目数、._ 计数。
#
# 不带 ./ 前缀的模式同时被 GNU/bsdtar 理解为按路径段匹配；dist/modules/*.js 在镜像内重建，无需随包携带
COPYFILE_DISABLE=1 tar -C "$ROOT" -czf "$TARBALL" \
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
  --exclude='.env.*' \
  --exclude='deploy.env' \
  --exclude='deploy.d' \
  .
ls -lh "$TARBALL"

# 自检：用 python tarfile 读（macOS 自带 tar 会隐藏 ._ 条目，查不出来）。
# 打包完立刻验，别等远端才发现——远端每个 ._ 都会随 build context 进镜像。
AD_COUNT="$(python3 - "$TARBALL" <<'PY'
import os, sys, tarfile
names = tarfile.open(sys.argv[1]).getnames()
print(sum(1 for n in names if os.path.basename(n).startswith('._')))
PY
)"
if [ "$AD_COUNT" != "0" ]; then
  echo "❌ tarball 里仍有 $AD_COUNT 个 AppleDouble 条目（._*），会污染远端镜像——中止上传"
  exit 1
fi
echo "✓ tarball 无 AppleDouble 条目"

# --- 导出本次发布的文件清单（供远端删除「已删除文件」的残留）---
# tar 解包是「覆盖」语义、不删旧文件：本地已删的文件会永久留在服务器 checkout 里，
# 随后被 COPY 进镜像 build context → 编译报错（2026-10-26 实测：工作台 v2.1 删掉的
# 4 个旧 overview 组件残留，引用已改版的 OverviewResponse 字段，web 镜像构建失败）。
# 清单 = 本次 tarball 的文件列表（相对路径，LC_ALL=C 排序），单独上传、放在 checkout 之外。
MANIFEST="$TMP_LOCAL/files-manifest.txt"
python3 - "$TARBALL" > "$MANIFEST" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as t:
    for m in t.getmembers():
        if m.isfile():
            print(m.name)
PY
# tarball 条目名形如 "./apps/api/src/x.ts"，去掉前导 "./" 才是相对路径
sed -i.bak 's|^\./||' "$MANIFEST" && rm -f "$MANIFEST.bak"
LC_ALL=C sort -o "$MANIFEST" "$MANIFEST"
echo "✓ 文件清单 $(wc -l < "$MANIFEST") 条"

if [ "$DRY_RUN" = "1" ]; then
  echo "--dry-run: 跳过上传与部署（tarball 保留在 ${TMP_LOCAL}）"
  trap - EXIT
  exit 0
fi

echo "== 上传 =="
put_file "$TARBALL" "$DEPLOY_REMOTE_DIR.tar.gz"
# 清单传到 .new 后缀：deploy.sh 需要「上一版」与「本版」两份做差集，
# 所以不能直接覆盖同名文件（覆盖了就拿不到旧清单）。
put_file "$MANIFEST" "$DEPLOY_REMOTE_DIR.files-manifest.txt.new"

echo "== 远程部署 =="
# 先解包（含最新的 deploy.sh），再执行——绝不让脚本执行中自我覆盖。
#
# 解包前先清掉 AppleDouble 残骸。tar 解包是「覆盖」语义，不删旧文件：早于
# COPYFILE_DISABLE=1 的 tarball 会带上一批 ._xxx 条目，这些文件一旦落到服务器
# 上就永久留在 checkout 里，后续每次发版都被 COPY 进镜像 build context——
# 实测 skill-creator 18 文件在远端变 41 个，且这 23 个垃圾文件会污染技能目录树。
# 本地 tarball 干净（打包后用 python tarfile 自检），所以根因只需清服务器这份残留。
# 用 find -delete 而不是 rm：路径含中文/空格也安全，且不依赖 shell glob 展开。
run_ssh "
  set -e
  mkdir -p '$DEPLOY_REMOTE_DIR'
  find '$DEPLOY_REMOTE_DIR' -name '._*' -type f -delete 2>/dev/null || true
  tar xzf '$DEPLOY_REMOTE_DIR.tar.gz' -C '$DEPLOY_REMOTE_DIR'
  BACKUP_KEEP='$DEPLOY_BACKUP_KEEP' API_REPLICAS='$DEPLOY_API_REPLICAS' EXEC_CONCURRENCY='$DEPLOY_EXEC_CONCURRENCY' bash '$DEPLOY_REMOTE_DIR/infra/docker/deploy.sh' '$DEPLOY_REMOTE_DIR'
"
