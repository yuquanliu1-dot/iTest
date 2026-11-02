# GaussDB 100 (Zenith) JDBC 桥：api 经 HTTP 转发 SQL（Node 生态无驱动，华为只发 JDBC）。
# 构建上下文 = 仓库根（与 api.Dockerfile/web.Dockerfile 同约定，见 deploy.sh）。
# 不在镜像里 javac：部署机拉不到 8-jdk（内网 registry 受限，prod228 只缓存了 8-jre），
# .class 由开发机 javac --release 8 预编译进仓库（classes/，与 lib/ jar 同纪律）。
FROM eclipse-temurin:8-jre
WORKDIR /app
COPY infra/docker/gauss-bridge/classes/ /app/classes/
COPY infra/docker/gauss-bridge/lib/ /app/lib/
ENV GAUSS_BRIDGE_PORT=8080
# 桥只跑 compose 内网，不映射宿主端口（与 api 同纪律）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["java", "-cp", "/app/classes:/app/lib/*", "GaussBridge"]
