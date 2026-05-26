# ── Install deps ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
RUN pnpm install --frozen-lockfile --prod

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY --from=deps /app/node_modules node_modules/
COPY package.json tsconfig.json ./
COPY src/ src/

RUN addgroup -S keeper && adduser -S keeper -G keeper
USER keeper

CMD ["node", "--import=amaro/strip", "src/index.ts"]
