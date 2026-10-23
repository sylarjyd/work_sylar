#!/usr/bin/env bash
# 一键容器部署（Linux / macOS / Git Bash）。
# 用法：./deploy.sh [--with-admin | --admin-only] [--no-build] [--logs] [--down] [--purge]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENV_FILE="${ENV_FILE:-.env.docker}"
DOWN=0
PURGE=0
NO_BUILD=0
LOGS=0
WITH_ADMIN=0
ADMIN_ONLY=0

usage() {
  cat <<'EOF'
用法: ./deploy.sh [选项]
  --with-admin    同时部署运营端（默认只部署客户端栈）
  --admin-only    只构建并启动运营端（内网部署场景，不启动客户端/BFF/数据库）
  --no-build      复用已有镜像，不重新构建
  --logs          启动后持续输出日志（Ctrl+C 退出）
  --down          停止并移除容器（保留数据卷）
  --purge         与 --down 连用，连同数据卷一起删除
  --env-file 路径 指定环境文件（默认 .env.docker）
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --with-admin) WITH_ADMIN=1 ;;
    --admin-only) ADMIN_ONLY=1 ;;
    --no-build) NO_BUILD=1 ;;
    --logs|-l) LOGS=1 ;;
    --down|-d) DOWN=1 ;;
    --purge|-p) PURGE=1 ;;
    --env-file) ENV_FILE="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

if [ "$WITH_ADMIN" = 1 ] && [ "$ADMIN_ONLY" = 1 ]; then
  echo "--with-admin 与 --admin-only 不能同时使用" >&2
  exit 2
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "未找到 Docker Compose：请安装 docker compose 插件或 docker-compose" >&2
  exit 1
fi

compose() {
  if [ -f "$ENV_FILE" ]; then
    "${COMPOSE[@]}" --env-file "$ENV_FILE" "$@"
  else
    "${COMPOSE[@]}" "$@"
  fi
}

hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -N "$1" -tx1 | tr -d ' \n'
  fi
}

get_kv() {
  { grep -E "^$1=" "$2" 2>/dev/null || true; } | tail -n1 | cut -d= -f2- |
    sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

set_kv() {
  local key="$1" value="$2" file="$3"
  if grep -q "^${key}=" "$file"; then
    awk -v k="$key" -v v="$value" -F= 'BEGIN { OFS="=" } $1 == k { print k"="v; next } { print }' \
      "$file" > "$file.tmp"
    mv "$file.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

ensure_env() {
  [ -f "$ENV_FILE" ] && return
  echo "==> 生成 $ENV_FILE（随机密钥；模型配置优先复用根 .env）"
  umask 077
  cp .env.docker.example "$ENV_FILE"
  set_kv POSTGRES_PASSWORD "$(hex 16)" "$ENV_FILE"
  set_kv MINIO_ROOT_PASSWORD "$(hex 16)" "$ENV_FILE"
  set_kv JWT_SECRET "$(hex 32)" "$ENV_FILE"
  set_kv CONNECTOR_ENC_KEY "$(hex 32)" "$ENV_FILE"
  set_kv MODEL_ENC_KEY "$(hex 32)" "$ENV_FILE"
  set_kv AGENT_RUNTIME_TOKEN "$(hex 24)" "$ENV_FILE"
  set_kv INTERNAL_TOKEN "$(hex 24)" "$ENV_FILE"
  set_kv ALERT_WEBHOOK_SECRET "$(hex 24)" "$ENV_FILE"
  for key in DEEPSEEK_API_KEY MODEL_BASE_URL MODEL_NAME TAVILY_API_KEY \
    EMBEDDING_BASE_URL EMBEDDING_API_KEY EMBEDDING_MODEL EMBEDDING_DIM; do
    value="$(get_kv "$key" .env || true)"
    [ -n "$value" ] && set_kv "$key" "$value" "$ENV_FILE"
  done
  chmod 600 "$ENV_FILE"
  echo "    已生成；如需更换模型/地址，请编辑后重新运行"
}

if [ "$DOWN" = 1 ]; then
  echo "==> 停止容器"
  # 带上 admin profile，确保之前用 --with-admin 启动的运营端也被清理。
  args=(--profile admin down --remove-orphans)
  if [ "$PURGE" = 1 ]; then
    echo "    同时删除数据卷（数据库/对象存储/Redis 全部清空）"
    args+=(-v)
  fi
  compose "${args[@]}"
  echo "已停止。"
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker 未运行：请先启动 docker 服务" >&2
  exit 1
fi

ensure_env

admin_port="$(get_kv ADMIN_WEB_PORT "$ENV_FILE")"
admin_port="${admin_port:-3001}"
admin_bind="$(get_kv ADMIN_WEB_BIND "$ENV_FILE")"
admin_bind="${admin_bind:-127.0.0.1}"
# 绑定到指定内网网卡时用该地址探活；0.0.0.0 与回环都走 127.0.0.1。
admin_host="$admin_bind"
if [ "$admin_host" = "0.0.0.0" ]; then admin_host=127.0.0.1; fi

if [ "$ADMIN_ONLY" = 1 ]; then
  args=(--profile admin up -d --no-deps)
  if [ "$NO_BUILD" = 0 ]; then args+=(--build); fi
  args+=(admin-web)
  echo "==> 构建并启动运营端（独立部署，不启动客户端栈）"
  compose "${args[@]}"
else
  args=(up -d --remove-orphans)
  if [ "$WITH_ADMIN" = 1 ]; then args=(--profile admin "${args[@]}"); fi
  if [ "$NO_BUILD" = 0 ]; then args+=(--build); fi
  echo "==> 构建并启动容器（首次构建约数分钟）"
  compose "${args[@]}"
fi

web_port="$(get_kv WEB_PORT "$ENV_FILE")"
bff_port="$(get_kv BFF_PORT "$ENV_FILE")"
web_port="${web_port:-3000}"
bff_port="${bff_port:-4000}"

http_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 3 "$1" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O /dev/null "$1" >/dev/null 2>&1
  else
    return 0
  fi
}

wait_http() {
  local url="$1" timeout="$2" deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if http_ok "$url"; then return 0; fi
    sleep 2
  done
  return 1
}

echo "==> 等待服务就绪"
if [ "$ADMIN_ONLY" = 0 ]; then
  if ! wait_http "http://127.0.0.1:${bff_port}/api/health" 240; then
    echo "BFF 未就绪，最近日志：" >&2
    compose logs --tail 80 bff agent-runtime web >&2 || true
    exit 1
  fi
  if ! wait_http "http://127.0.0.1:${web_port}/" 120; then
    echo "Web 未就绪，最近日志：" >&2
    compose logs --tail 80 web >&2 || true
    exit 1
  fi
fi
if [ "$ADMIN_ONLY" = 1 ] || [ "$WITH_ADMIN" = 1 ]; then
  if ! wait_http "http://${admin_host}:${admin_port}/login" 120; then
    echo "运营端未就绪，最近日志：" >&2
    compose logs --tail 80 admin-web >&2 || true
    exit 1
  fi
fi

services="${COMPOSE[*]}"
echo ""
echo "部署完成："
if [ "$ADMIN_ONLY" = 0 ]; then
  echo "  Web      http://localhost:${web_port}"
  echo "  BFF      http://localhost:${bff_port}  （健康检查 /api/health）"
fi
if [ "$ADMIN_ONLY" = 1 ] || [ "$WITH_ADMIN" = 1 ]; then
  echo "  运营端   http://${admin_host}:${admin_port}  （绑定 ${admin_bind}，请勿直接暴露公网）"
fi
if [ "$ADMIN_ONLY" = 1 ]; then
  echo "  日志     ${services} --env-file ${ENV_FILE} logs -f admin-web"
else
  echo "  日志     ${services} --env-file ${ENV_FILE} logs -f bff"
  echo "  提升管理员 ${services} --env-file ${ENV_FILE} exec bff node scripts/promote-admin.mjs <邮箱>"
fi
echo "  停止     ./deploy.sh --down   （加 --purge 连数据卷删除）"
if [ "$ADMIN_ONLY" = 0 ] && [ -z "$(get_kv DEEPSEEK_API_KEY "$ENV_FILE")" ]; then
  echo "警告：DEEPSEEK_API_KEY 为空，Agent 将使用 Mock 模型，仅用于链路验证" >&2
fi
if [ "$ADMIN_ONLY" = 0 ] && [ -z "$(get_kv EMBEDDING_API_KEY "$ENV_FILE")" ]; then
  echo "警告：EMBEDDING_API_KEY 为空，知识库文档向量化不可用" >&2
fi

if [ "$LOGS" = 1 ]; then
  compose logs -f --tail 100
fi
