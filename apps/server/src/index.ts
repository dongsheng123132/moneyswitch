import { loadConfig } from "./config.js";
import { startServer } from "./start.js";

async function main() {
  const config = loadConfig();
  await startServer(config);
  console.log(`[moneyswitch] server listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error("[moneyswitch] fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
