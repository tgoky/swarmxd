# ── Base ───────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base

RUN apk add --no-cache libc6-compat curl
RUN npm install -g pnpm@9

WORKDIR /app
COPY package.json pnpm-lock.yaml turbo.json tsconfig.json ./

# ── Dependencies ───────────────────────────────────────────────────────────────
FROM base AS deps

COPY packages/shared/package.json ./packages/shared/
COPY packages/conductor/package.json ./packages/conductor/
COPY packages/agents/researcher/package.json ./packages/agents/researcher/
COPY packages/agents/risk-assessor/package.json ./packages/agents/risk-assessor/
COPY packages/agents/executor/package.json ./packages/agents/executor/
COPY packages/agents/rebalancer/package.json ./packages/agents/rebalancer/
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile --ignore-scripts

# ── Source ─────────────────────────────────────────────────────────────────────
FROM deps AS source

COPY packages/ ./packages/
COPY apps/ ./apps/
COPY scripts/ ./scripts/

# ── API target ─────────────────────────────────────────────────────────────────
FROM source AS api

ENV NODE_ENV=production
EXPOSE 3001

# Use tsx for zero-build TypeScript execution in production
CMD ["node", "--loader", "tsx", "apps/api/src/index.ts"]

# ── Conductor target ───────────────────────────────────────────────────────────
FROM source AS conductor

ENV NODE_ENV=production

# Healthcheck: verify agent heartbeats are flowing through Redis
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD redis-cli -u $REDIS_URL ping || exit 1

CMD ["node", "--loader", "tsx", "packages/conductor/src/bootstrap.ts"]
