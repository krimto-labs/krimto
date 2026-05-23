# syntax=docker/dockerfile:1
# Krimto self-host image (Gap 10). Serves MCP over HTTP with bearer auth + /health.
# Two stages: a builder with the toolchain to compile better-sqlite3, and a slim
# non-root runtime that runs the server via tsx (the project's source is ESM-with-
# extensionless-imports, so it runs through tsx rather than a plain `node dist`).

# ---- builder: install production deps (better-sqlite3 compiles from source) ----
FROM node:22-slim AS builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --prod keeps vitest/eslint/typescript out; tsx is a runtime dependency.
# allowBuilds (pnpm-workspace.yaml) lets better-sqlite3's native build run.
RUN pnpm install --prod --frozen-lockfile

# ---- runtime: slim, non-root, no build toolchain ----
FROM node:22-slim AS runtime
# git is required at runtime (the server commits to git); openssh-client for SSH git remotes;
# ca-certificates for HTTPS remotes and embedding-provider calls.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    KRIMTO_DATA=/data \
    KRIMTO_HTTP_PORT=8080
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
VOLUME ["/data"]
# Readiness probe hits the HTTP health endpoint (no external tools needed).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KRIMTO_HTTP_PORT||8080)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run via tsx directly (no pnpm/corepack needed at runtime).
CMD ["node_modules/.bin/tsx", "src/server/index.ts"]
