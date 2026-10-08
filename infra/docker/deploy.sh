# 服务器端部署脚本：build → (非首次先备库) → 起服务 → (首次 seed admin)
# 用法: ./deploy.sh [APP_ROOT]          APP_ROOT 默认 /home/wangb/itest
#       BACKUP_KEEP=N                   数据库备份保留份数，默认 10
# 前置：代码 tarball 需先解包到 APP_ROOT（一键入口见同目录 release.sh，它会先解包再调用本脚本；
#       手动部署则 tar xzf <APP_ROOT>.tar.gz -C <APP_ROOT>）。不要在本脚本里解包——
#       bash 按字节偏移读脚本，执行中自我覆盖会把后续行读成乱码。
set -euo pipefail

ROOT="${1:-/home/wangb/itest}"
BACKUP_DIR="${ROOT}-backups"
BACKUP_KEEP="${BACKUP_KEEP:-10}"

if [ ! -d "$ROOT" ]; then
  echo "找不到 $ROOT"
  exit 1
fi
if [ ! -f "$ROOT/infra/docker/.env.production" ]; then
  echo "缺少 $ROOT/infra/docker/.env.production（首次部署需先准备密钥，参考 deploy.env.example 流程）"
  exit 1
fi

cd "$ROOT"

echo "== build api =="
docker build -t itest-api:latest -f infra/docker/api.Dockerfile .
echo "== build web =="
docker build -t itest-web:latest -f infra/docker/web.Dockerfile .

# 先起依赖，pg 就绪后判断是否首次部署（users 表存在 = 非首次）
echo "== up deps (pg/redis) =="
docker compose -p itest -f infra/docker/docker-compose.yml up -d postgres redis
for i in $(seq 1 30); do
  if docker exec itest-pg pg_isready -U itest -d itest >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

FIRST_DEPLOY=1
if docker exec itest-pg psql -U itest -d itest -tAc "SELECT to_regclass('public.users') IS NOT NULL" 2>/dev/null | grep -q '^t$'; then
  FIRST_DEPLOY=0
fi

if [ "$FIRST_DEPLOY" = "0" ]; then
  echo "== 备份数据库（非首次部署）=="
  mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  BAK="$BACKUP_DIR/itest-db-$STAMP.sql.gz"
  docker exec itest-pg pg_dump -U itest --clean --if-exists itest | gzip > "$BAK"
  echo "备份完成: $BAK ($(du -h "$BAK" | cut -f1))"
  # 轮换：只保留最新 BACKUP_KEEP 份
  ls -1t "$BACKUP_DIR"/itest-db-*.sql.gz 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm -f
  echo "回滚参考: docker stop itest-api itest-web && gunzip -c $BAK | docker exec -i itest-pg psql -U itest -d itest && 重启 api"
else
  echo "== 首次部署：跳过备份（库还是空的）=="
fi

echo "== up services =="
docker compose -p itest -f infra/docker/docker-compose.yml up -d

# 等 api 就绪（api 启动会先 drizzle-kit push 再起 http）
API_READY=0
for i in $(seq 1 30); do
  code=$(curl -sS -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/health || true)
  if [ "$code" = "200" ]; then
    echo "API ready"
    API_READY=1
    break
  fi
  sleep 2
done
if [ "$API_READY" = "0" ]; then
  echo "警告: API 60s 内未就绪，请手动检查 docker logs itest-api"
fi

if [ "$FIRST_DEPLOY" = "1" ]; then
  echo "== seed admin（仅首次）=="
  # push 不执行 seed SQL；admin 不存在时才需要。已存在会报 duplicate key，忽略即可。
  docker exec -i itest-pg psql -U itest -d itest < apps/api/drizzle/0011_seed-org-admin.sql || true
  echo "默认账号 admin/admin123，首登强制改密"
fi

docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep itest-
