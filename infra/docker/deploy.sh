# 部署脚本：在 wangb@192.168.30.228 上
# 用法: ./deploy.sh /path/to/itest.tar.gz
set -euo pipefail

ROOT="${1:-/home/wangb/itest}"

if [ ! -d "$ROOT" ]; then
  echo "找不到 $ROOT"
  exit 1
fi

cd "$ROOT"
tar xzf /home/wangb/itest.tar.gz --overwrite 2>/dev/null || true

# 重新构建镜像
echo "== build api =="
docker build -t itest-api:latest -f infra/docker/api.Dockerfile .
echo "== build web =="
docker build -t itest-web:latest -f infra/docker/web.Dockerfile .

# 起服务（保留卷）
echo "== up services =="
docker compose -p itest -f infra/docker/docker-compose.yml up -d

# 等待 api 起来
for i in $(seq 1 30); do
  code=$(curl -sS -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/health || true)
  if [ "$code" = "200" ]; then
    echo "API ready"
    break
  fi
  sleep 2
done

# 首次部署需要 seed 一次 admin (idempotent: 已经存在会被 ignore)
if [ "${SEED_ADMIN:-1}" = "1" ]; then
  echo "== seed admin =="
  docker exec -i itest-pg psql -U itest -d itest <<<'SELECT 1' >/dev/null 2>&1 || true
  # 0011_seed-org-admin.sql 用 ON CONFLICT 不可达；单独 psql 跑一次即可（user 已存在则不影响）
  docker exec -i itest-pg psql -U itest -d itest < apps/api/drizzle/0011_seed-org-admin.sql || true
fi

docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep itest-