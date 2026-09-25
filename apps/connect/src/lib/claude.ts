import type { CommandRunner, CommandResult } from "./runner.js";
import type { McpCommand } from "./mcp-entry.js";

const SERVER_NAME = "moneyswitch";

/**
 * SPEC-v0.3-employee.md §B.2 step 3: `claude mcp add moneyswitch -s user
 * -e MONEY_API_BASE=... -e MONEY_API_KEY=... -- <mcp command>`; if
 * already present, remove it first. `mcpCommand` is `{command, args}` from
 * `resolveMcpCommand()` — `node <abs path>` in-repo, `npx -y moneyswitch
 * mcp` from the published package.
 */
export function applyClaude(
  runner: CommandRunner,
  server: string,
  key: string,
  mcpCommand: McpCommand
): { removed: CommandResult; added: CommandResult } {
  const removed = runner.run("claude", ["mcp", "remove", SERVER_NAME, "-s", "user"]);
  const added = runner.run("claude", [
    "mcp",
    "add",
    SERVER_NAME,
    "-s",
    "user",
    "-e",
    `MONEY_API_BASE=${server}`,
    "-e",
    `MONEY_API_KEY=${key}`,
    "--",
    mcpCommand.command,
    ...mcpCommand.args,
  ]);
  return { removed, added };
}

export function removeClaude(runner: CommandRunner): CommandResult {
  return runner.run("claude", ["mcp", "remove", SERVER_NAME, "-s", "user"]);
}
