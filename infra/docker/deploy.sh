# 服务器端部署脚本：preflight → build → (非首次先备库) → up + 等 healthcheck → smoke
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
  echo "缺少 $ROOT/infra/docker/.env.production（首次部署需先准备密钥，参考 infra/docker/deploy.d/README.md 流程）"
  exit 1
fi

cd "$ROOT"

# --- preflight ---
command -v docker >/dev/null || { echo "docker 不可用"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "需要 docker compose v2"; exit 1; }

# --- 起依赖，pg 就绪后判断是否首次部署（users 表存在 = 非首次）---
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

# --- 迁移历史 .data 到 itest-data 卷（仅首次切卷时执行）---
# 旧 overlay 镜像层的 1.1GB 工作空间如果还在旧容器,需要带过去;之后由 itest-data 卷托管。
if [ "$FIRST_DEPLOY" = "0" ] && ! docker volume inspect itest-data >/dev/null 2>&1; then
  echo "== 创建 itest-data 卷并迁移历史 .data =="
  docker volume create itest-data >/dev/null
  if docker exec itest-api sh -c "[ -d /repo/apps/api/.data ] && [ \"\$(ls -A /repo/apps/api/.data 2>/dev/null)\" ]" 2>/dev/null; then
    docker run --rm \
      -v itest-data:/dst \
      --volumes-from itest-api \
      alpine sh -c 'cd /repo/apps/api/.data && tar cf - . | tar xf - -C /dst' \
      && echo "迁移完成"
  fi
fi

if [ "$FIRST_DEPLOY" = "0" ]; then
  echo "== 备份数据库（非首次部署）=="
  mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  BAK="$BACKUP_DIR/itest-db-$STAMP.sql.gz"
  docker exec itest-pg pg_dump -U itest --clean --if-exists itest | gzip > "$BAK"
  echo "备份完成: $BAK ($(du -h "$BAK" | cut -f1))"
  ls -1t "$BACKUP_DIR"/itest-db-*.sql.gz 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm -f
  echo "回滚参考: docker stop itest-api itest-web && gunzip -c $BAK | docker exec -i itest-pg psql -U itest -d itest && 重启 api"
else
  echo "== 首次部署：跳过备份（库还是空的）=="
fi

echo "== build api =="
docker build -t itest-api:latest -f infra/docker/api.Dockerfile .
echo "== build web =="
docker build -t itest-web:latest -f infra/docker/web.Dockerfile .

echo "== up services =="
# --wait 用 healthcheck 替代 pg_isready + curl 轮询；超 120s 仍未 healthy 抛错（set -e 触发）。
docker compose -p itest -f infra/docker/docker-compose.yml up -d --wait --wait-timeout 120

if [ "$FIRST_DEPLOY" = "1" ]; then
  echo "== seed admin（仅首次）=="
  docker exec -i itest-pg psql -U itest -d itest < apps/api/drizzle/0011_seed-org-admin.sql || true
  echo "默认账号 admin/admin123，首登强制改密"
fi

# --- post-deploy smoke ---
# Warning 策略:任一 FAIL 输出原因但 exit 0;运维根据警告决定是否回滚。
echo "== post-deploy smoke =="
SMOKE_FAIL=0
SMOKE_WARN=""

# (a) api 健康
if ! docker exec itest-api node -e "fetch('http://127.0.0.1:54321/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  SMOKE_WARN="$SMOKE_WARN
  - api /api/health FAIL（看 docker logs itest-api）"
  SMOKE_FAIL=1
fi

# (b) admin/admin123 可登:比对 bcryptjs 真校验,失败自动重置
if ! docker exec itest-api sh -c "node -e \"
  import('playwright-core').then(async () => {
    const { pool } = await import('./dist/db/client.js').catch(() => ({ pool: null }));
    const { default: pg } = await import('pg');
    const c = new pg.Client({ host: 'itest-pg', user: 'itest', password: 'itest', database: 'itest' });
    await c.connect();
    const r = await c.query('SELECT password_hash FROM users WHERE username=\\\"admin\\\"');
    if (!r.rows[0]?.password_hash) { console.error('admin row missing'); process.exit(1); }
    const bcrypt = (await import('bcryptjs')).default;
    const ok = await bcrypt.compare('admin123', r.rows[0].password_hash);
    await c.end();
    process.exit(ok ? 0 : 2);
  });
\"" >/dev/null 2>&1; then
  SMOKE_WARN="$SMOKE_WARN
  - admin/admin123 hash 不匹配,正在重设"
  HASH=$(node -e "const b=require('./node_modules/.pnpm/bcryptjs@3.0.3/node_modules/bcryptjs'); console.log(b.hashSync('admin123', 10))" 2>/dev/null || true)
  if [ -n "${HASH:-}" ]; then
    docker exec itest-pg psql -U itest -d itest -c "UPDATE users SET password_hash='$HASH', must_change_password=true WHERE username='admin'" >/dev/null
    SMOKE_WARN="$SMOKE_WARN（已自动 reset）"
  else
    SMOKE_WARN="$SMOKE_WARN（重置失败:本机无 bcryptjs,需手动）"
  fi
  SMOKE_FAIL=1
fi

# (c) playwright/chromium 可启动（防镜像构建期 install 静默失败）
if ! docker exec itest-api node -e "import('playwright-core').then(({chromium}) => chromium.launch({headless:true}).then(async b => { const c = await b.newContext(); const p = await c.newPage(); await p.goto('about:blank'); console.log('chromium OK:', await p.title()); await b.close(); }))" >/dev/null 2>&1; then
  SMOKE_WARN="$SMOKE_WARN
  - chromium launch FAIL（重建 api 镜像或检查 PLAYWRIGHT_BROWSERS_PATH）"
  SMOKE_FAIL=1
fi

# (d) 录制回连地址 sanity：扩展跑在用户浏览器里，wsUrl 指回环=远程用户必挂(2026-10-09 prod228 踩过)；
#     环境变量缺失时 api 回落 ws://127.0.0.1:54321/recorder，同样是回环，一并告警。
WS_URL="$(docker exec itest-api printenv RECORDER_PUBLIC_WS_URL 2>/dev/null || true)"
if [ -z "$WS_URL" ] || echo "$WS_URL" | grep -qE '127\.0\.0\.1|localhost|::1'; then
  SMOKE_WARN="$SMOKE_WARN
  - RECORDER_PUBLIC_WS_URL 为空或指向回环(${WS_URL:-<unset>})：扩展在用户浏览器里运行，回连地址必须是浏览器可达的主机地址(如 ws://<服务器IP>:8080/api/recorder)"
  SMOKE_FAIL=1
fi

# (e) 录制 WS 握手链路：浏览器扩展 → nginx(/api/recorder 精确匹配) → api upgrade 处理器(只认 /recorder)。
#     用假 token 探测：链路通时 api 校验失败即断连，nginx 立刻回 502 → PASS；
#     路径不匹配(踩过：proxy_pass 不带 URI 未把 /api/recorder 改写成 /recorder)时 upgrade 无人处理、
#     请求挂起到超时 → FAIL；401/404 = nginx 丢了 Upgrade 头或 location 误路由 → FAIL。
if ! docker exec itest-api node -e "
const http = require('node:http');
const req = http.request({
  host: 'itest-web', port: 80, path: '/api/recorder?sessionId=smoke&token=smoke',
  headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' },
});
req.on('upgrade', () => process.exit(0));
req.on('response', (r) => process.exit(r.statusCode === 502 ? 0 : 1));
req.on('error', () => process.exit(1));
req.setTimeout(6000, () => { req.destroy(); process.exit(1); });
req.end();
" >/dev/null 2>&1; then
  SMOKE_WARN="$SMOKE_WARN
  - 录制 WS 握手链路 FAIL（nginx /api/recorder → api /recorder upgrade 不通：检查 web.nginx.conf 的 location = /api/recorder 与 proxy_pass /recorder 改写）"
  SMOKE_FAIL=1
fi

# (f) 录制 REST 路由：POST /api/recorder/sessions 无凭证应得到 401/400(证明打到 api 的路由层)；
#     若 /api/recorder 前缀被整体改写(踩过)，api 会回 404 Cannot POST /recorder/sessions。
if ! docker exec itest-api node -e "
fetch('http://itest-web:80/api/recorder/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  .then((r) => process.exit(r.status === 404 ? 1 : 0))
  .catch(() => process.exit(1));
" >/dev/null 2>&1; then
  SMOKE_WARN="$SMOKE_WARN
  - 录制 REST 路由 FAIL（POST /api/recorder/sessions 返回 404：nginx 把 /api/recorder 前缀误改写，REST 应走通用 /api/ 反代）"
  SMOKE_FAIL=1
fi

if [ "$SMOKE_FAIL" = "1" ]; then
  echo "⚠️  smoke 未全过:$SMOKE_WARN"
  echo "  容器仍在跑,需手动排错或回滚。"
else
  echo "✓ smoke 全过"
fi

docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep itest-