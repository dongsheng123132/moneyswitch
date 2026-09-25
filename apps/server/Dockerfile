# Not built/tested in this environment (Docker daemon not running). Written
# to match SPEC.md §2.1/2.7; validate before relying on it.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @moneyswitch/db build \
 && pnpm --filter @moneyswitch/core build \
 && pnpm --filter @moneyswitch/wallet build \
 && pnpm --filter @moneyswitch/x402 build \
 && pnpm --filter @moneyswitch/server build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app .
EXPOSE 4020
CMD ["node", "apps/server/dist/index.js"]
