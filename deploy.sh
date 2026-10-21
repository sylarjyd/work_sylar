#!/usr/bin/env bash
# 一键容器部署入口；实际逻辑在 scripts/deploy.sh。
set -euo pipefail
exec bash "$(cd "$(dirname "$0")" && pwd)/scripts/deploy.sh" "$@"
