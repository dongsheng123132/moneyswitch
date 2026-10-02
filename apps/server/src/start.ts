import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.js";
import { buildContext, type AppContext, type BuildContextOptions } from "./context.js";
import { buildApp } from "./app.js";
import { startReconcileLoop } from "./reconcileJob.js";
import { DEFAULT_NOTIFY_INTERVAL_MS, startNotifyLoop } from "./notify/outbox.js";
import { getActiveNetwork, getEnabledNetworks, isMainnetNetwork } from "@moneyswitch/x402";

export { loadConfig, type ServerConfig, type DemoModeInfo } from "./config.js";
export type { AppContext, FirstRunSecrets, BuildContextOptions } from "./context.js";

export interface RunningServer {
  app: FastifyInstance;
  ctx: AppContext;
  url: string;
  /** Stops the reconcile and notification loops, closes the HTTP server and the SQLite handle. */
  close: () => Promise<void>;
}

/**
 * Boots one MoneySwitch server (context + HTTP app + reconcile loop). Shared
 * by `apps/server/src/index.ts` (the classic `node dist/index.js` entry) and
 * the `moneyswitch-server` npm package (self-host + offline demo).
 */
export async function startServer(config: ServerConfig, opts: BuildContextOptions = {}): Promise<RunningServer> {
  getActiveNetwork(); // Validate the configured default before opening a database.
  for (const network of getEnabledNetworks().filter(isMainnetNetwork)) {
    if (!network.rpcUrl) {
      throw new Error(
        "MONEYSWITCH_MAINNET_ENABLED=true but the mainnet rpcUrl is empty — refusing to start " +
          "(set MONEYSWITCH_MAINNET_RPC_URL, or leave MONEYSWITCH_MAINNET_ENABLED unset to use testnet)."
      );
    }
    // Loud, one-time: this mode moves REAL USDC on Monad mainnet.
    console.warn(
      `[moneyswitch] WARNING: MONEYSWITCH_MAINNET_ENABLED=true — this server pays with REAL USDC on ${network.label} ` +
        `(${network.caip2}, rpc ${network.rpcUrl}). There is no undo. Make sure this is intentional.`
    );
  }
  const ctx = await buildContext(config, opts);
  const app = buildApp(ctx);
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    ctx.sqlite.close();
    throw err;
  }
  const reconcile = startReconcileLoop(ctx, config.demo ? 0 : config.reconcileIntervalMs ?? 60_000);
  // Approval push notifications: a decoupled outbox loop, never on the payment path.
  // The offline demo runs it too, so a channel configured in the demo Dashboard really delivers; but it ignores
  // MONEYSWITCH_NOTIFY_* from the environment, so demo approvals never reach channels set up for a real deployment.
  if (config.demo) ctx.notify = { ...ctx.notify, env: {} };
  const notify = startNotifyLoop(ctx, config.notifyIntervalMs ?? DEFAULT_NOTIFY_INTERVAL_MS);
  return {
    app,
    ctx,
    url: `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`,
    close: async () => {
      reconcile.stop();
      // Waits for an in-flight send to be aborted before the SQLite handle goes away.
      await notify.stop();
      await app.close();
      try {
        ctx.sqlite.close();
      } catch {
        // already closed
      }
    },
  };
}
