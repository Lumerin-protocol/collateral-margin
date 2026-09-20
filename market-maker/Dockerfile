# ── Install deps ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps

WORKDIR /app

RUN corepack enable

# pnpm-workspace.yaml carries the allowBuilds allowances; pnpm 11 treats ignored
# build scripts as a hard install error, so it must be present before install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:24-alpine

ARG COMMIT_HASH=""
ENV NODE_ENV=production
ENV COMMIT_HASH=$COMMIT_HASH

WORKDIR /app

COPY --from=deps /app/node_modules node_modules/
COPY package.json tsconfig.json ./
COPY src/ src/
COPY configs/ configs/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN addgroup -S maker && adduser -S maker -G maker
USER maker

# MAKER_APP selects the entrypoint:
#   MAKER_APP=perps   -> src/apps/perps/main.ts
#   MAKER_APP=futures -> src/apps/futures/main.ts
# MAKER_CONFIG points to the YAML file inside the container.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
