#!/usr/bin/env node
import { installOutboundProxy, closeOutboundProxy } from "@moneyswitch/net";
import { runCli } from "./lib/cli.js";

// `--server` is very often a local/private address (packages/net's own
// isAlwaysDirectHost/shouldBypassProxy already dial those direct no matter
// what proxy is installed) but can also be a remote MoneySwitch server, in
// which case it should follow the user's configured proxy like every other
// outbound fetch in this codebase (apps/server, apps/cli). Installing
// unconditionally is the minimal change: local/private targets are
// unaffected, remote ones now go through the proxy.
installOutboundProxy();

// This CLI calls process.exit() itself (needed: without it, a lingering
// keep-alive socket on the dispatcher above could hold the event loop open
// and delay exit rather than crash it). process.exit() skips the
// `beforeExit` hook packages/net registers for a graceful shutdown, so the
// dispatcher is closed explicitly here first.
async function main(): Promise<number> {
  try {
    return await runCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`moneyswitch-connect: unexpected error: ${(err as Error)?.message ?? err}\n`);
    return 1;
  }
}

main().then(async (code) => {
  await closeOutboundProxy();
  process.exit(code);
});
