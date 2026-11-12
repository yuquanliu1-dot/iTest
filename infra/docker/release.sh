#!/usr/bin/env bash
# Local one-stop release: pack the repo → upload tarball → run deploy.sh remotely (auto backup unless first deploy).
# Target server config lives in infra/docker/deploy.d/<env>.env (directory is gitignored; template in deploy.d/.env.example).
# Name files after their target (prod228.env / staging-31.env) so multiple hosts are easy to tell apart at a glance.
#
# Usage:
#   infra/docker/release.sh                                # --env required, no default
#   infra/docker/release.sh --env <name>                   # specify the environment (prod228 / staging-31 / ...)
#   infra/docker/release.sh [--env <name>] --dry-run       # pack only, no upload, no deploy
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

# Credential file name restriction: letters/digits/underscore/dash, to prevent path traversal
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
# Pre-check: a loopback recorder callback address = the extension in the user's browser can never connect (bitten on prod228, 2026-10-09).
# Warn only, do not block: allowed through when "the browser genuinely runs on the server" is the intended setup.
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
# --no-xattrs is NOT the key flag; neither is --exclude='._*'.
# The key flag is COPYFILE_DISABLE=1 — not --exclude='._*', and not --no-xattrs either.
#
# macOS's tar is bsdtar (libarchive); when packing it silently synthesizes an AppleDouble companion
# entry ._xxx for every file, stashing extended attributes/resource forks inside (COPYFILE feature).
# These are not "files already in the source directory", so --exclude='._*' never matches (exclusion
# happens at read time, before those entries even exist); --no-xattrs is equally useless — it only
# affects pax headers, it does not stop libarchive from synthesizing companion entries. Observed:
# same directory, tar entries 8 → 4 after COPYFILE_DISABLE=1, ._ entries 0.
#
# The harm: once these ._xxx land in the server checkout, tar unpacking writes them out as-is
# (unpacking is overwrite semantics, never deletes old files, so they stay forever), then get COPY'd
# into the image build context — observed: skill-creator's 18 files became 41 on the remote, and
# read_skill lists noise like ._SKILL.md to the model as real files.
#
# All three safeguards stay: COPYFILE_DISABLE cuts it at the source (primary), .dockerignore blocks
# the image side (fallback), and find -delete before unpacking clears historical residue (cures already-polluted servers).
#
# Note: macOS's own `tar tzf` HIDES these entries, so self-checking with it misreads 0 —
# must read with GNU tar or python tarfile. Verified with python tarfile: entry count, ._ count.
#
# Patterns without the ./ prefix are understood by both GNU/bsdtar as path-segment matches; dist/modules/*.js is rebuilt inside the image, no need to ship it
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
  --exclude='.env.production' \
  --exclude='deploy.env' \
  --exclude='deploy.d' \
  .
ls -lh "$TARBALL"

# Self-check: read with python tarfile (macOS's bundled tar hides ._ entries, so it cannot detect them).
# Verify right after packing, don't wait for the remote to find out — every ._ on the remote enters the image via the build context.
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

# --- Export this release's file manifest (so the remote can delete residue of "deleted files") ---
# tar unpacking is "overwrite" semantics and never deletes old files: files deleted locally stay in the server
# checkout forever, then get COPY'd into the image build context → compile errors (observed 2026-10-26: the 4
# stale overview components deleted in workbench v2.1 lingered, referencing the redesigned OverviewResponse
# fields, breaking the web image build).
# Manifest = this tarball's file list (relative paths, LC_ALL=C sorted), uploaded separately, kept outside the checkout.
MANIFEST="$TMP_LOCAL/files-manifest.txt"
python3 - "$TARBALL" > "$MANIFEST" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as t:
    for m in t.getmembers():
        if m.isfile():
            print(m.name)
PY
# Tarball entry names look like "./apps/api/src/x.ts"; strip the leading "./" to get the relative path
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
# Manifest uploaded with a .new suffix: deploy.sh needs both the "previous" and "current" manifests for the diff,
# so the same-named file must not be overwritten directly (overwriting would lose the old manifest).
put_file "$MANIFEST" "$DEPLOY_REMOTE_DIR.files-manifest.txt.new"

echo "== 远程部署 =="
# Unpack first (including the latest deploy.sh), then execute — never let the script overwrite itself mid-execution.
#
# Before unpacking, wipe AppleDouble residue. tar unpacking is "overwrite" semantics and never deletes old files:
# tarballs made before COPYFILE_DISABLE=1 carried a batch of ._xxx entries; once on the server they stay in the
# checkout forever and get COPY'd into the image build context on every subsequent release — observed: skill-creator's
# 18 files became 41 on the remote, and those 23 junk files pollute the skill directory tree.
# The local tarball is clean (self-checked with python tarfile after packing), so the root fix only needs to clear
# this server-side residue. find -delete instead of rm: safe with Chinese/spaces in paths, and independent of shell glob expansion.
run_ssh "
  set -e
  mkdir -p '$DEPLOY_REMOTE_DIR'
  find '$DEPLOY_REMOTE_DIR' -name '._*' -type f -delete 2>/dev/null || true
  tar xzf '$DEPLOY_REMOTE_DIR.tar.gz' -C '$DEPLOY_REMOTE_DIR'
  BACKUP_KEEP='$DEPLOY_BACKUP_KEEP' API_REPLICAS='$DEPLOY_API_REPLICAS' EXEC_CONCURRENCY='$DEPLOY_EXEC_CONCURRENCY' bash '$DEPLOY_REMOTE_DIR/infra/docker/deploy.sh' '$DEPLOY_REMOTE_DIR'
"
