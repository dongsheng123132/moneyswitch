#!/usr/bin/env node
import { runCli } from "moneyswitch-connect/lib";
import { pathToFileURL } from "node:url";

/**
 * `moneyswitch` — the published client CLI. Thin dispatcher over:
 *  - moneyswitch-connect's runCli (SPEC-v0.3-employee.md §B): `connect`,
 *    `status`, `remove` subcommands.
 *  - @moneyswitch/mcp (SPEC §7): `mcp` subcommand, started as a genuinely
 *    separate bundle (./mcp.js, built from src/mcp-bin.ts) so importing it
 *    is only ever attempted when `moneyswitch mcp` is actually invoked, not
 *    as a side effect of loading this dispatcher.
 */
export const TOP_HELP = `moneyswitch - client CLI for MoneySwitch (x402 + USDC on Monad)

Usage:
  moneyswitch connect --server <url> --key <mk_live_...> [--apply] [--json]
  moneyswitch status --server <url> --key <mk_live_...> [--json]
  moneyswitch remove [--apply] [--json]
  moneyswitch mcp

Without --apply, "connect"/"remove" only print planned changes (dry-run).
"mcp" starts a stdio MCP server; it reads MONEY_API_BASE and MONEY_API_KEY
from the environment and never touches this process's argv/stdout for
anything other than the MCP protocol itself.

Exit codes: 0 ok, 1 failure, 2 bad args.`;

export type Dispatch =
  | { kind: "mcp" }
  | { kind: "connect-lib"; args: string[] }
  | { kind: "help" }
  | { kind: "unknown"; command: string };

/**
 * Pure argv -> Dispatch mapping, kept separate from process.exit / dynamic
 * import side effects so it's directly unit-testable.
 */
export function parseTopArgv(argv: string[]): Dispatch {
  const [sub, ...rest] = argv;
  if (sub === "mcp") return { kind: "mcp" };
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
