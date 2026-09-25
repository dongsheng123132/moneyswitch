import { createRequire } from "node:module";

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
