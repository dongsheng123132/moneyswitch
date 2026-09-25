import { loadConfig } from "./config.js";
import { buildContext } from "./context.js";
import { buildApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const ctx = await buildContext(config);
  const app = buildApp(ctx);
  await app.listen({ port: config.port, host: config.host });
  console.log(`[moneyswitch] server listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error("[moneyswitch] fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
