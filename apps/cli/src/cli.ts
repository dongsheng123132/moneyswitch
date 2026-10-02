#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runDemoLauncher } from "./demo.js";

declare const __MONEYSWITCH_VERSION__: string | undefined;
/** Injected by build.mjs from package.json; "0.0.0-dev" when run from source (tests). */
export const VERSION = typeof __MONEYSWITCH_VERSION__ === "string" ? __MONEYSWITCH_VERSION__ : "0.0.0-dev";

export const TOP_HELP = `moneyswitch - client CLI for MoneySwitch (x402 + USDC)

Usage:
  moneyswitch demo [--port 4020] [--no-open] [--registry=<url>]
  moneyswitch mcp
  moneyswitch --version

Give an AI the skill and MoneyKey copied from the server Dashboard.
"demo" starts the separate moneyswitch-server package's offline tour (AGPL-3.0-only).
"mcp" starts a stdio MCP server using MONEY_API_BASE and MONEY_API_KEY.
Exit codes: 0 ok, 1 failure, 2 bad args.`;

export type Dispatch =
  | { kind: "mcp" }
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
  if (sub === "demo") return { kind: "demo", args: rest };
  if (sub === "--version" || sub === "-v") return { kind: "version" };
  if (sub === undefined || sub === "--help" || sub === "-h") return { kind: "help" };
  return { kind: "unknown", command: sub };
}

async function main(): Promise<void> {
  const dispatch = parseTopArgv(process.argv.slice(2));

  if (dispatch.kind === "mcp") {
    await import("./mcp.js");
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
