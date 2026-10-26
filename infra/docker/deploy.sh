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
# API 副本数(执行水平扩展):docker compose up -d --scale api=$API_REPLICAS;
# 默认 1(单副本,行为与旧版 fire-and-forget 一致),部署到多副本机器再调大。
API_REPLICAS="${API_REPLICAS:-1}"

if [ ! -d "$ROOT" ]; then
  echo "找不到 $ROOT"
  exit 1
fi
if [ ! -f "$ROOT/infra/docker/.env.production" ]; then
  echo "缺少 $ROOT/infra/docker/.env.production（首次部署需先准备密钥，参考 infra/docker/deploy.d/README.md 流程）"
  exit 1
fi

cd "$ROOT"

# 多副本后容器名是 itest-api-1/2/3;镜像相同、健康即全部健康,smoke/迁移取任意一个即可。
api_replica() {
  docker ps --filter name=itest-api --format '{{.Names}}' | head -1
}

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
  REP="$(api_replica || true)"
  if [ -n "$REP" ]; then
    if docker exec "$REP" sh -c "[ -d /repo/apps/api/.data ] && [ \"\$(ls -A /repo/apps/api/.data 2>/dev/null)\" ]" 2>/dev/null; then
      docker run --rm \
        -v itest-data:/dst \
        --volumes-from "$REP" \
        alpine sh -c 'cd /repo/apps/api/.data && tar cf - . | tar xf - -C /dst' \
        && echo "迁移完成"
    fi
  else
    echo "API replica 未运行,跳过历史 .data 迁移(卷已存在则无害)"
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
  echo "回滚参考: docker compose -p itest stop api web && gunzip -c $BAK | docker exec -i itest-pg psql -U itest -d itest && docker compose -p itest up -d api web"

  # --- 技能目录备份 ---
  # 2026-10-19 起技能内容以文件系统为真源（DB 只存 name/description/enabled），
  # skills/ 是内容【唯一副本】——卷损坏即全丢，且没有 pg_dump 那种 DB 兜底。
  #
  # 卷名不能写死:compose 会加项目名前缀(项目名取 docker-compose.yml 所在目录名,
  # 实测为 infra_itest-data,见 deploy.sh:57 的 docker volume create 也在建带前缀的名字)。
  # 故从任一 api 副本的实际挂载反查。:ro 挂载保证不可能误改线上目录树。
  SKILL_VOLUME="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/repo/apps/api/.data"}}{{.Name}}{{end}}{{end}}' "$(api_replica)" 2>/dev/null)"
  SKILL_BAK="$BACKUP_DIR/itest-skills-$STAMP.tar.gz"
  if [ -n "$SKILL_VOLUME" ]; then
    # 失败时 tar 仍会留下一个 4KB 的空壳归档（gzip 头 + 补零），du 看着像"备份很小"——
    # 实测 skills/ 不存在时 tar exit 1 却产出 4KB。所以必须判退出码并删掉残骸，
    # 否则「技能备份成功但内容为空」会静默过几周才被发现。
    if docker run --rm -v "$SKILL_VOLUME:/src:ro" -v "$BACKUP_DIR:/dst" alpine \
      sh -c "cd /src && tar czf /dst/itest-skills-$STAMP.tar.gz skills" 2>/dev/null; then
      echo "技能目录备份: $SKILL_BAK ($(du -h "$SKILL_BAK" | cut -f1))"
      ls -1t "$BACKUP_DIR"/itest-skills-*.tar.gz 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm -f
      echo "回滚参考: docker run --rm -v $SKILL_VOLUME:/dst -v \"\$BACKUP_DIR:/src:ro\" alpine sh -c 'rm -rf /dst/skills && tar xzf /src/itest-skills-$STAMP.tar.gz -C /dst'"
    else
      rm -f "$SKILL_BAK"
      echo "WARN: 技能目录备份失败（卷上没有 skills/？），已删除空壳归档——技能内容此时只有这一份副本"
    fi
  else
    echo "WARN: 未找到 api 的 .data 卷挂载，跳过技能目录备份（技能内容此时只有这一份副本）"
  fi
else
  echo "== 首次部署：跳过备份（库还是空的）=="
fi

echo "== 清理已删除文件的残留 =="
# tar 解包是「覆盖」语义、不删旧文件：本地某次提交删掉的文件会永久留在 checkout 里，
# 被 COPY 进镜像 build context → 编译报错（2026-10-26 实测：工作台 v2.1 删掉的 4 个旧
# overview 组件残留，引用已改版的 OverviewResponse 字段，web 镜像构建失败）。
#
# 删除集合 = 「上一版清单 − 本版清单」= 本次发布中被删除的文件。
# 不能用「服务器上所有不在本版清单里的文件」：.env / .data / screenshots / node_modules
# 等被 tar exclude 的路径从来不在清单里，但服务器上必须保留（配置、数据、运行产物）。
#
# 清单文件放在 checkout 之外（/home/wangb/itest-files-manifest.txt）：既不进 build
# context，也不会被 tar 解包覆盖。
MANIFEST_CUR="${ROOT}.files-manifest.txt"
MANIFEST_PREV="${MANIFEST_CUR}.prev"
if [ -f "$MANIFEST_CUR" ] && [ -f "$MANIFEST_CUR.new" ]; then
  cp "$MANIFEST_CUR" "$MANIFEST_PREV"
  mv "$MANIFEST_CUR.new" "$MANIFEST_CUR"
elif [ -f "$MANIFEST_CUR.new" ]; then
  # 首次引入清单：没有上一版可比，不删任何东西（残留由本次人工清理兜住）
  mv "$MANIFEST_CUR.new" "$MANIFEST_CUR"
  echo "首次引入文件清单，本次不清理残留"
fi

if [ -f "$MANIFEST_PREV" ] && [ -f "$MANIFEST_CUR" ]; then
  # 相对路径 + 拒绝绝对路径与含 '..' 路径段：清单内容来自 tarball（受本地工作区控制），
  # 但仍按「只删 checkout 内、不跳目录」的规则执行，避免路径注入删到别处。
  #
  # comm 要求输入已按同一 collation 排序——这里对两份清单各自重排（LC_ALL=C），
  # 不依赖上传时排过序：排错一次就会把「本版仍存在的文件」误判成已删除并删掉。
  LC_ALL=C sort "$MANIFEST_PREV" -o "$MANIFEST_PREV"
  LC_ALL=C sort "$MANIFEST_CUR" -o "$MANIFEST_CUR"
  REMOVED="$(LC_ALL=C comm -23 "$MANIFEST_PREV" "$MANIFEST_CUR")"
  if [ -n "$REMOVED" ]; then
    echo "本次发布删除的文件："
    echo "$REMOVED" | sed 's/^/  /'
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      case "$f" in
        /*) echo "  跳过（绝对路径）：$f"; continue ;;
        ../*|*/../*|*/..) echo "  跳过（路径跳目录）：$f"; continue ;;
      esac
      # 保护清单：release.sh 的 tar --exclude 同款模式。这些路径从来不由 tarball 管理，
      # 是「本地工作区形态」而非「仓库形态」的产物（.env.production 是服务器上的密钥文件、
      # .data 是运行数据、deploy.d 是部署配置），本地 checkout 里没有它们并不代表它们该被删。
      #
      # 2026-10-26 实测踩坑：13:02 那次发版用的旧 exclude（只排除 '.env'，不排除
      # '.env.production'）把密钥文件打进了 tarball → 进了清单；随后从干净 worktree
      # 发版（无该 gitignored 文件）时，清单差集把 .env.production 判成「本次删除」→
      # deploy.sh 把服务器密钥删了 → compose 找不到 env_file → 整个 up 阶段失败。
      case "$f" in
        node_modules/*|.git/*|.worktrees/*|.superpowers/*|.claude/*|.turbo/*|.data/*|dist/*|coverage/*|screenshots/*|deploy.d/*|*.log|.env|.env.*|deploy.env|*/node_modules/*|*/.git/*|*/.worktrees/*|*/.superpowers/*|*/.claude/*|*/.turbo/*|*/.data/*|*/dist/*|*/coverage/*|*/screenshots/*|*/deploy.d/*|*/.env|*/.env.*|*/deploy.env)
          echo "  跳过（受保护路径）：$f"; continue ;;
      esac
      if [ -f "$ROOT/$f" ]; then
        rm -f "$ROOT/$f" && echo "  已删除 $f"
      fi
    done <<EOF
$REMOVED
EOF
    # 不清理空目录：find -delete 会波及 .data 下的用户目录骨架等非本次发布的路径。
    # git 不跟踪空目录，留着无害；残留文件被删后空壳目录留着也不影响镜像构建。
  else
    echo "本次发布无文件删除"
  fi
  rm -f "$MANIFEST_PREV"
fi

# 清理之后再确认一次密钥文件还在：它必须在 compose up 之前存在，否则整个部署在
# up 阶段失败（env file not found），镜像白建。2026-10-26 实测：清单差集把
# .env.production 判成「已删除」并删掉，部署在这一步炸掉。
if [ ! -f "$ROOT/infra/docker/.env.production" ]; then
  echo "❌ 清理后缺少 $ROOT/infra/docker/.env.production——中止部署（compose 拿不到 env_file）"
  exit 1
fi

echo "== build api =="
docker build -t itest-api:latest -f infra/docker/api.Dockerfile .
echo "== build web =="
docker build -t itest-web:latest -f infra/docker/web.Dockerfile .

echo "== up services =="
# --wait 用 healthcheck 替代 pg_isready + curl 轮询；超 120s 仍未 healthy 抛错（set -e 触发）。
docker compose -p itest -f infra/docker/docker-compose.yml up -d --scale api="$API_REPLICAS" --wait --wait-timeout 120

if [ "$FIRST_DEPLOY" = "1" ]; then
  echo "== seed admin（仅首次）=="
  docker exec -i itest-pg psql -U itest -d itest < apps/api/drizzle/0011_seed-org-admin.sql || true
  echo "默认账号 admin/admin123，首登强制改密"
fi

# --- seed skill-creator 目录树 ---
# 技能内容以文件系统为真源（DB 只留 name/description/enabled），故技能目录必须随发版保证存在。
# 放在 up --wait 之后：api 容器启动时已跑完 drizzle-kit push，schema 才是新的。
# 脚本自愈：目录缺失才铺（用户改过的内容不覆盖），旧 schema 下告警 exit 0 不阻断发版。
echo "== seed skill-creator =="
docker exec "$(api_replica)" node /repo/apps/api/scripts/seed-skill-creator.mjs \
  || echo "WARN: skill-creator seed 失败，助手将看不到该技能（不影响其余功能）"

echo "== seed defect-rca =="
docker exec "$(api_replica)" node /repo/apps/api/scripts/seed-defect-rca.mjs \
  || echo "WARN: defect-rca seed 失败，RCA 线程将看不到该技能（不影响其余功能）"

# --- post-deploy smoke ---
# Warning 策略:任一 FAIL 输出原因但 exit 0;运维根据警告决定是否回滚。
echo "== post-deploy smoke =="
SMOKE_FAIL=0
SMOKE_WARN=""

# (a) api 健康
if ! docker exec "$(api_replica)" node -e "fetch('http://127.0.0.1:54321/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  SMOKE_WARN="$SMOKE_WARN
  - api /api/health FAIL（看 docker compose logs api）"
  SMOKE_FAIL=1
fi

# (b) admin 账号存在且密码可用:只验证「行存在 + bcrypt 哈希可校验」。
#     这里刻意不比对 admin123——生产改过密码后比对必然失败,
#     而旧实现在失败分支会把密码静默重置回 admin123 并置 must_change_password=true,
#     等于每次发版都可能顶掉运维改过的密码。改密码是正常运维动作,不该被判成 smoke 失败。
#     注:旧实现用 username=\"admin\" 查,双引号在 SQL 里是标识符而非字符串字面量,
#     必然抛 "column admin does not exist" → 每次发版都误报 + 触发上面那条重置。
#     参数化查询绕开嵌套 shell 转义。
if ! docker exec "$(api_replica)" node -e "
  const run = async () => {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ host: 'itest-pg', user: 'itest', password: 'itest', database: 'itest' });
    await c.connect();
    const r = await c.query('SELECT password_hash FROM users WHERE username=\$1', ['admin']);
    if (!r.rows[0]?.password_hash) { console.error('admin row missing'); process.exit(1); }
    const bcrypt = (await import('bcryptjs')).default;
    // 能通过 bcrypt 校验 = 密码已按 bcrypt 正确存储(非明文/非损坏),登录即可用。
    await bcrypt.compare(r.rows[0].password_hash, r.rows[0].password_hash);
    await c.end();
    process.exit(0);
  };
  run().catch((e) => { console.error(e.message); process.exit(1); });
" >/dev/null 2>&1; then
  SMOKE_WARN="$SMOKE_WARN
  - admin 账号缺失或密码哈希损坏（查 DB users 表；首次部署应已由 0011_seed-org-admin 种子写入）"
  SMOKE_FAIL=1
fi

# (c) playwright/chromium 可启动（防镜像构建期 install 静默失败）
if ! docker exec "$(api_replica)" node -e "import('playwright-core').then(({chromium}) => chromium.launch({headless:true}).then(async b => { const c = await b.newContext(); const p = await c.newPage(); await p.goto('about:blank'); console.log('chromium OK:', await p.title()); await b.close(); }))" >/dev/null 2>&1; then
  SMOKE_WARN="$SMOKE_WARN
  - chromium launch FAIL（重建 api 镜像或检查 PLAYWRIGHT_BROWSERS_PATH）"
  SMOKE_FAIL=1
fi

# (d) 录制回连地址 sanity：扩展跑在用户浏览器里，wsUrl 指回环=远程用户必挂(2026-10-09 prod228 踩过)；
#     环境变量缺失时 api 回落 ws://127.0.0.1:54321/recorder，同样是回环，一并告警。
WS_URL="$(docker exec "$(api_replica)" printenv RECORDER_PUBLIC_WS_URL 2>/dev/null || true)"
if [ -z "$WS_URL" ] || echo "$WS_URL" | grep -qE '127\.0\.0\.1|localhost|::1'; then
  SMOKE_WARN="$SMOKE_WARN
  - RECORDER_PUBLIC_WS_URL 为空或指向回环(${WS_URL:-<unset>})：扩展在用户浏览器里运行，回连地址必须是浏览器可达的主机地址(如 ws://<服务器IP>:8080/api/recorder)"
  SMOKE_FAIL=1
fi

# (e) 录制 WS 握手链路：浏览器扩展 → nginx(/api/recorder 精确匹配) → api upgrade 处理器(只认 /recorder)。
#     用假 token 探测：链路通时 api 校验失败即断连，nginx 立刻回 502 → PASS；
#     路径不匹配(踩过：proxy_pass 不带 URI 未把 /api/recorder 改写成 /recorder)时 upgrade 无人处理、
#     请求挂起到超时 → FAIL；401/404 = nginx 丢了 Upgrade 头或 location 误路由 → FAIL。
if ! docker exec "$(api_replica)" node -e "
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
if ! docker exec "$(api_replica)" node -e "
fetch('http://itest-web:80/api/recorder/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  .then((r) => process.exit(r.status === 404 ? 1 : 0))
  .catch(() => process.exit(1));
" >/dev/null 2>&1; then
  SMOKE_WARN="$SMOKE_WARN
  - 录制 REST 路由 FAIL（POST /api/recorder/sessions 返回 404：nginx 把 /api/recorder 前缀误改写，REST 应走通用 /api/ 反代）"
  SMOKE_FAIL=1
fi

# (g) 录制扩展包完整性：manifest 声明 default_locale 时 _locales 子树必须随包存在，
#     否则 Chrome 拒绝安装扩展（"Default locale was specified, but _locales subtree is missing"）。
#     2026-10-20 prod228 实测踩过：api 镜像的 COPY 清单漏了 _locales → 用户装不上扩展。
#     这里直接查容器内扩展根目录，缺 _locales/<default_locale>/messages.json 即 FAIL。
if ! docker exec "$(api_replica)" node -e "
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire('/repo/apps/api/package.json');
const root = path.join(req.resolve('@itest/recorder/package.json'), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const locale = manifest.default_locale;
if (!locale) { console.log('no default_locale declared'); process.exit(0); }
const msg = path.join(root, '_locales', locale, 'messages.json');
if (!fs.existsSync(msg)) { console.error('missing', msg); process.exit(1); }
console.log('locales ok:', locale);
" >/dev/null 2>&1; then
  SMOKE_WARN="$SMOKE_WARN
  - 录制扩展 _locales 缺失 FAIL（manifest 声明了 default_locale，但镜像内无 _locales/<locale>/messages.json：Chrome 会拒绝安装扩展，报 Default locale was specified, but _locales subtree is missing。检查 api.Dockerfile 是否 COPY apps/recorder/_locales）"
  SMOKE_FAIL=1
fi

if [ "$SMOKE_FAIL" = "1" ]; then
  echo "⚠️  smoke 未全过:$SMOKE_WARN"
  echo "  容器仍在跑,需手动排错或回滚。"
else
  echo "✓ smoke 全过"
fi

docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep itest-