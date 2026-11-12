# GaussDB 100 (Zenith) JDBC bridge: api forwards SQL over HTTP (no driver in the Node ecosystem; Huawei only ships JDBC).
# Build context = repo root (same convention as api.Dockerfile/web.Dockerfile, see deploy.sh).
# No javac inside the image: the deploy host cannot pull 8-jdk (internal registry is restricted; prod228 only cached 8-jre),
# so .class files are precompiled on the dev machine with javac --release 8 into the repo (classes/, same discipline as the lib/ jars).
FROM eclipse-temurin:8-jre
WORKDIR /app
COPY infra/docker/gauss-bridge/classes/ /app/classes/
COPY infra/docker/gauss-bridge/lib/ /app/lib/
ENV GAUSS_BRIDGE_PORT=8080
# The bridge only runs on the compose internal network, no host port mapping (same discipline as api)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["java", "-cp", "/app/classes:/app/lib/*", "GaussBridge"]
