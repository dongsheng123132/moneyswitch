# Not built/tested in this environment (Docker daemon not running). Written
# to match SPEC.md §2.1/2.7; validate before relying on it.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @moneyswitch/core build \
 && pnpm --filter @moneyswitch/x402 build \
 && pnpm --filter @moneyswitch/demo-seller build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app .
EXPOSE 4021
CMD ["node", "apps/demo-seller/dist/index.js"]
