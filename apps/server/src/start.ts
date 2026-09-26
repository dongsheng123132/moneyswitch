import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.js";
import { buildContext, type AppContext, type BuildContextOptions } from "./context.js";
import { buildApp } from "./app.js";
import { startReconcileLoop } from "./reconcileJob.js";

export { loadConfig, type ServerConfig, type DemoModeInfo } from "./config.js";
export type { AppContext, FirstRunSecrets, BuildContextOptions } from "./context.js";

export interface RunningServer {
  app: FastifyInstance;
  ctx: AppContext;
  url: string;
  /** Stops the reconcile loop, closes the HTTP server and the SQLite handle. */
  close: () => Promise<void>;
}

/**
 * Boots one MoneySwitch server (context + HTTP app + reconcile loop). Shared
 * by `apps/server/src/index.ts` (the classic `node dist/index.js` entry) and
 * the `moneyswitch-server` npm package (self-host + offline demo).
 */
export async function startServer(config: ServerConfig, opts: BuildContextOptions = {}): Promise<RunningServer> {
  const ctx = await buildContext(config, opts);
  const app = buildApp(ctx);
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    ctx.sqlite.close();
    throw err;
  }
  const reconcile = startReconcileLoop(ctx, config.demo ? 0 : config.reconcileIntervalMs ?? 60_000);
  return {
    app,
    ctx,
    url: `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`,
    close: async () => {
      reconcile.stop();
      await app.close();
      try {
        ctx.sqlite.close();
      } catch {
        // already closed
      }
    },
  };
}
