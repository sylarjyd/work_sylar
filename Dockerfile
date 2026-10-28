# 生产镜像：一次构建，供 bff / agent-runtime / web / admin 四个 target 复用依赖层。
# 客户端（web）与运营端（admin）是独立应用，可分别构建、分别部署。
# 用法见 docker-compose.yml 与 docs/deploy/06-deployment.md §11。
# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@10.19.0

# ---------------------------------------------------------------- 依赖安装
FROM base AS deps
# argon2 需要 node-gyp 工具链；Prisma 需要 openssl。构建期依赖不会进入运行镜像。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/bff/package.json apps/bff/package.json
COPY apps/agent-runtime/package.json apps/agent-runtime/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
COPY packages/web-core/package.json packages/web-core/package.json
# @prisma/client 的 postinstall 会执行 prisma generate，需先有 schema；
# DATABASE_URL 仅用于满足 datasource 声明，构建期不会连接数据库。
COPY apps/bff/prisma apps/bff/prisma
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build pnpm install --frozen-lockfile

# ---------------------------------------------------------------- 客户端编译产物
FROM deps AS build
# NEXT_PUBLIC_* 会被 Next 在构建期内联，浏览器访问 BFF/运营端的地址必须此时确定。
ARG NEXT_PUBLIC_BFF_URL=http://localhost:4000
ARG NEXT_PUBLIC_ADMIN_URL=
ENV NEXT_PUBLIC_BFF_URL=${NEXT_PUBLIC_BFF_URL} \
    NEXT_PUBLIC_ADMIN_URL=${NEXT_PUBLIC_ADMIN_URL} \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
COPY . .
RUN pnpm --filter @ai-office/shared build \
    && pnpm --filter @ai-office/telemetry build \
    && pnpm --filter @ai-office/bff db:generate \
    && pnpm --filter @ai-office/bff build \
    && pnpm --filter @ai-office/agent-runtime build \
    && pnpm --filter @ai-office/web-core exec file-viewer-copy-assets ../../apps/web/public/file-viewer \
    && pnpm --filter @ai-office/web build

# ---------------------------------------------------------------- 运营端编译产物
# 单独成阶段：运营端常常单独部署在内网主机，不应连带构建 BFF / runtime / 客户端。
FROM deps AS build-admin
# 浏览器直连 BFF 的地址，可能与客户端不同（内网地址）。
ARG ADMIN_BFF_URL=http://localhost:4000
# 客户端工作台地址，用于“返回工作台”外链；留空则不显示。
ARG WORKSPACE_URL=
COPY . .
RUN pnpm --filter @ai-office/shared build \
    && pnpm --filter @ai-office/web-core exec file-viewer-copy-assets ../../apps/admin/public/file-viewer \
    && NEXT_PUBLIC_BFF_URL=${ADMIN_BFF_URL} \
       NEXT_PUBLIC_WORKSPACE_URL=${WORKSPACE_URL} \
       pnpm --filter @ai-office/admin build

# ---------------------------------------------------------------- 运行基座
FROM base AS runtime-base
ENV NODE_ENV=production
# Prisma 靠 openssl 探测二进制目标；缺失时会误判为 debian-openssl-1.1.x 并找不到引擎。
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /repo/packages/telemetry/package.json ./packages/telemetry/package.json
COPY --from=build --chown=node:node /repo/packages/telemetry/dist ./packages/telemetry/dist
# pnpm 把 telemetry 的运行时依赖链接在包内 node_modules，根目录没有提升；漏拷会导致 ERR_MODULE_NOT_FOUND。
COPY --from=build --chown=node:node /repo/packages/telemetry/node_modules ./packages/telemetry/node_modules
COPY --from=build --chown=node:node /repo/packages/web-core/package.json ./packages/web-core/package.json
COPY --from=build --chown=node:node /repo/packages/web-core/src ./packages/web-core/src
USER node

# ---------------------------------------------------------------- BFF
FROM runtime-base AS bff
COPY --from=build --chown=node:node /repo/apps/bff/node_modules ./apps/bff/node_modules
COPY --from=build --chown=node:node /repo/apps/bff/dist ./apps/bff/dist
COPY --from=build --chown=node:node /repo/apps/bff/prisma ./apps/bff/prisma
COPY --from=build --chown=node:node /repo/apps/bff/scripts ./apps/bff/scripts
COPY --from=build --chown=node:node /repo/apps/bff/package.json ./apps/bff/package.json
WORKDIR /repo/apps/bff
EXPOSE 4000
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------- Agent Runtime
FROM runtime-base AS agent-runtime
COPY --from=build --chown=node:node /repo/apps/agent-runtime/node_modules ./apps/agent-runtime/node_modules
COPY --from=build --chown=node:node /repo/apps/agent-runtime/dist ./apps/agent-runtime/dist
COPY --from=build --chown=node:node /repo/apps/agent-runtime/package.json ./apps/agent-runtime/package.json
COPY --chown=node:node docker/wait-for-http.mjs /usr/local/bin/wait-for-http.mjs
WORKDIR /repo/apps/agent-runtime
EXPOSE 4001
CMD ["node", "dist/server.js"]

# ---------------------------------------------------------------- Web
FROM runtime-base AS web
COPY --from=build --chown=node:node /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=build --chown=node:node /repo/apps/web/.next ./apps/web/.next
# 文件预览的 Worker/WASM 资源由 next start 直接从 public 提供。
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /repo/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /repo/apps/web/next.config.mjs ./apps/web/next.config.mjs
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["./node_modules/.bin/next", "start", "-p", "3000"]

# ---------------------------------------------------------------- 运营端
FROM runtime-base AS admin
COPY --from=build-admin --chown=node:node /repo/apps/admin/node_modules ./apps/admin/node_modules
COPY --from=build-admin --chown=node:node /repo/apps/admin/.next ./apps/admin/.next
COPY --from=build-admin --chown=node:node /repo/apps/admin/public ./apps/admin/public
COPY --from=build-admin --chown=node:node /repo/apps/admin/package.json ./apps/admin/package.json
COPY --from=build-admin --chown=node:node /repo/apps/admin/next.config.mjs ./apps/admin/next.config.mjs
WORKDIR /repo/apps/admin
EXPOSE 3001
CMD ["./node_modules/.bin/next", "start", "-p", "3001"]
