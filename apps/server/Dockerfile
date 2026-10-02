FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* && corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('apps/server-pkg/package.json')); delete p.devDependencies; delete p.scripts; fs.writeFileSync('/app/runtime-package.json', JSON.stringify(p));"

FROM node:22-slim
ENV NODE_ENV=production MONEYSWITCH_HOST=0.0.0.0 MONEYSWITCH_PORT=4020 MONEYSWITCH_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/runtime-package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/apps/server-pkg/dist ./dist
COPY --from=build /app/apps/server-pkg/dashboard ./dashboard
COPY --from=build /app/apps/server-pkg/migrations ./migrations
COPY --from=build /app/apps/server-pkg/LICENSE ./LICENSE
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4020
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
 CMD node -e "fetch('http://127.0.0.1:4020/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/cli.js"]
