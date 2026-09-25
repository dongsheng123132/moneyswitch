import { createRequire } from "node:module";
import type { FetchLike } from "./status.js";

export interface McpCommand {
  command: string;
  args: string[];
}

/**
 * SPEC-v0.3-employee.md §B.3, extended for the published `moneyswitch` npm
 * package: resolve *how to launch the MCP server* for the Claude Code /
 * Codex config we write.
 *
 * - In-repo (this package's sibling workspace dependency `@moneyswitch/mcp`
 *   resolves successfully): use the exact same process, same node, no extra
 *   network hop -> `node <apps/mcp dist/index.js absolute path>`.
 * - From the published `moneyswitch` package (no `@moneyswitch/mcp` module
 *   to resolve — the MCP server is bundled directly inside `moneyswitch`
 *   instead of being a separate installable package): the absolute path to
 *   this install is not portable to another machine/user and may not even
 *   be on this machine tomorrow (npx cache eviction) -> use the portable,
 *   self-installing `npx -y moneyswitch mcp`.
 *
 * The judgment is a real, testable signal (module resolution succeeding or
 * throwing `MODULE_NOT_FOUND`), not a heuristic on file paths.
 */
export function resolveMcpCommand(fromUrl: string = import.meta.url): McpCommand {
  const require = createRequire(fromUrl);
  try {
    const entry = require.resolve("@moneyswitch/mcp");
    return { command: "node", args: [entry] };
  } catch {
    return { command: "npx", args: ["-y", "moneyswitch", "mcp"] };
  }
}

/** @deprecated kept for callers that only need the in-repo dev path; prefer resolveMcpCommand. */
export function resolveMcpEntryPath(fromUrl: string = import.meta.url): string {
  const require = createRequire(fromUrl);
  return require.resolve("@moneyswitch/mcp");
}

/** The npm-registry fallback launch command (only works once `moneyswitch` is published). */
export function isNpmRegistryFallback(cmd: McpCommand): boolean {
  return cmd.command === "npx" && cmd.args.length === 3 && cmd.args[0] === "-y" && cmd.args[1] === "moneyswitch" && cmd.args[2] === "mcp";
}

/**
 * Portable MCP launch command for installs outside the repo (docs/ux-audit.md
 * A-11). Every MoneySwitch server built with `pnpm build` serves this very
 * package at `/dl/moneyswitch.tgz`, and the MCP server needs that server
 * anyway (MONEY_API_BASE), so prefer
 * `npx -y --package=<server>/dl/moneyswitch.tgz moneyswitch mcp` when the
 * server has it — it works whether or not the package is on the npm registry
 * and survives npx cache eviction. Falls back to `npx -y moneyswitch mcp`.
 */
export async function resolvePortableMcpCommand(server: string, fetchImpl: FetchLike = fetch): Promise<McpCommand> {
  const base = server.replace(/\/+$/, "");
  const tarballUrl = `${base}/dl/moneyswitch.tgz`;
  try {
    const res = await fetchImpl(tarballUrl, { method: "HEAD" });
    if (res.ok) return { command: "npx", args: ["-y", `--package=${tarballUrl}`, "moneyswitch", "mcp"] };
  } catch {
    // unreachable / no tarball -> registry fallback
  }
  return { command: "npx", args: ["-y", "moneyswitch", "mcp"] };
}
