#!/usr/bin/env node
import { runCli } from "moneyswitch-connect/lib";
import { pathToFileURL } from "node:url";
import { runDemoLauncher } from "./demo.js";

declare const __MONEYSWITCH_VERSION__: string | undefined;
/** Injected by build.mjs from package.json; "0.0.0-dev" when run from source (tests). */
export const VERSION = typeof __MONEYSWITCH_VERSION__ === "string" ? __MONEYSWITCH_VERSION__ : "0.0.0-dev";

/**
 * `moneyswitch` — the published client CLI. Thin dispatcher over:
 *  - moneyswitch-connect's runCli (SPEC-v0.3-employee.md §B): `connect`,
 *    `status`, `remove` subcommands.
 *  - SPEC-v0.4 §B: `ui` subcommand, the local desktop console, loaded
 *    lazily from ./desktop.js (built from src/desktop/ui.ts) together with
 *    its static assets in ./ui/.
 *  - @moneyswitch/mcp (SPEC §7): `mcp` subcommand, started as a genuinely
 *    separate bundle (./mcp.js, built from src/mcp-bin.ts) so importing it
 *    is only ever attempted when `moneyswitch mcp` is actually invoked, not
 *    as a side effect of loading this dispatcher.
 */
export const TOP_HELP = `moneyswitch - client CLI for MoneySwitch (x402 + USDC on Monad)

Usage:
  moneyswitch demo [--port 4020] [--no-open] [--registry=<url>]
  moneyswitch connect --server <url> --key <mk_live_...> [--apply] [--json]
  moneyswitch status --server <url> --key <mk_live_...> [--json]
  moneyswitch remove [--apply] [--json]
  moneyswitch ui [--port 4318] [--no-open]
  moneyswitch sell --upstream <url> --pay-to <0x…> [--price 0.01] [--route "POST /path=0.01"]...
  moneyswitch mcp
  moneyswitch --version

"demo" is a 30-second offline tour (mock wallet, no real money). It runs
"npx -y moneyswitch-server@<version> demo", which DOWNLOADS the separate
moneyswitch-server package (self-hosted server + Dashboard, AGPL-3.0-only;
this CLI is Apache-2.0). Run "moneyswitch demo --help" for details.
"sell" puts a toll booth in front of your own API: AI agents pay USDC per call
(x402) straight to your PUBLIC receiving address; no MoneySwitch server needed.
Run "moneyswitch sell --help" for all options.
"ui" opens the local desktop console (127.0.0.1 only): give each agent a
model key and a MoneyKey, preview the config diff, then enable.
Without --apply, "connect"/"remove" only print planned changes (dry-run).
"mcp" starts a stdio MCP server; it reads MONEY_API_BASE and MONEY_API_KEY
from the environment and never touches this process's argv/stdout for
anything other than the MCP protocol itself.

Exit codes: 0 ok, 1 failure, 2 bad args.`;

export type Dispatch =
  | { kind: "mcp" }
  | { kind: "ui"; args: string[] }
  | { kind: "sell"; args: string[] }
  | { kind: "connect-lib"; args: string[] }
  | { kind: "demo"; args: string[] }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "unknown"; command: string };

/**
 * Pure argv -> Dispatch mapping, kept separate from process.exit / dynamic
 * import side effects so it's directly unit-testable.
 */
export function parseTopArgv(argv: string[]): Dispatch {
  const [sub, ...rest] = argv;
  if (sub === "mcp") return { kind: "mcp" };
  if (sub === "ui") return { kind: "ui", args: rest };
  if (sub === "sell") return { kind: "sell", args: rest };
  if (sub === "demo") return { kind: "demo", args: rest };
  if (sub === "--version" || sub === "-v") return { kind: "version" };
  if (sub === "connect") return { kind: "connect-lib", args: rest };
  if (sub === "status" || sub === "remove") return { kind: "connect-lib", args: argv };
  if (sub === undefined || sub === "--help" || sub === "-h") return { kind: "help" };
  return { kind: "unknown", command: sub };
}

async function main(): Promise<void> {
  const dispatch = parseTopArgv(process.argv.slice(2));

  if (dispatch.kind === "mcp") {
    await import("./mcp.js");
    return;
  }

  if (dispatch.kind === "ui") {
    const { runUi } = (await import("./desktop.js")) as { runUi: (argv: string[]) => Promise<number> };
    process.exit(await runUi(dispatch.args));
    return;
  }

  if (dispatch.kind === "sell") {
    // SPEC-v0.5 §4: lazy bundle (express + @x402/* + viem), loaded only for `sell`.
    const { runSell } = (await import("./sell.js")) as { runSell: (argv: string[]) => Promise<number> };
    process.exit(await runSell(dispatch.args));
    return;
  }

  if (dispatch.kind === "demo") {
    process.exit(await runDemoLauncher(dispatch.args, VERSION));
    return;
  }

  if (dispatch.kind === "version") {
    process.stdout.write(VERSION + "\n");
    process.exit(0);
    return;
  }

  if (dispatch.kind === "connect-lib") {
    const code = await runCli(dispatch.args);
    process.exit(code);
    return;
  }

  if (dispatch.kind === "help") {
    process.stdout.write(TOP_HELP + "\n");
    process.exit(0);
    return;
  }

  process.stderr.write(`moneyswitch: unknown command "${dispatch.command}"\n\n${TOP_HELP}\n`);
  process.exit(2);
}

// Only run as a side effect when executed directly (`node dist/cli.js ...`),
// not when this module is imported (e.g. by unit tests importing
// parseTopArgv/TOP_HELP).
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] as string).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`moneyswitch: unexpected error: ${(err as Error)?.message ?? err}\n`);
    process.exit(1);
  });
}
