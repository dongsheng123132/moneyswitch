import { installOutboundProxy, redactProxyUrl } from "@moneyswitch/net";
import { loadConfig } from "./config.js";
import { startServer } from "./start.js";

// Earliest possible point: before loadConfig()/startServer() make any
// outbound call themselves (facilitator, viem RPC and paid fetches all go
// through the global fetch dispatcher this installs).
const proxy = installOutboundProxy();
console.log(
  proxy.url
    ? `[moneyswitch] outbound proxy: ${redactProxyUrl(proxy.url)} (source: ${proxy.source})`
    : "[moneyswitch] outbound proxy: none (direct)"
);

async function main() {
  const config = loadConfig();
  await startServer(config);
  console.log(`[moneyswitch] server listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error("[moneyswitch] fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
