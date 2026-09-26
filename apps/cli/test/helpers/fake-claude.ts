import fs from "node:fs";
import path from "node:path";
import type { CommandResult, CommandRunner } from "moneyswitch-connect/lib/runner";

/**
 * Simulates the parts of the real `claude` CLI the console uses, against the
 * *isolated* home only: `--version`, `mcp add <name> -s user -e K=V ... -- cmd args`
 * and `mcp remove <name> -s user`, reading/writing <home>/.claude.json the
 * same way Claude Code 2.1.280 does (mcpServers.<name> = {type,command,args,env}).
 * `codex --version` / `openclaw --version` are answered too.
 */
export class FakeAgentRunner implements CommandRunner {
  calls: string[] = [];
  failAdd = false;
  constructor(private readonly home: string, private readonly installed: string[] = ["claude", "codex"]) {}

  private file() {
    return path.join(this.home, ".claude.json");
  }
  private read(): Record<string, unknown> {
    return fs.existsSync(this.file()) ? JSON.parse(fs.readFileSync(this.file(), "utf8")) : {};
  }
  private write(j: Record<string, unknown>) {
    fs.writeFileSync(this.file(), JSON.stringify(j, null, 2));
  }

  run(cmd: string, args: string[]): CommandResult {
    this.calls.push([cmd, ...args].join(" "));
    const ok = (stdout = ""): CommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
    const fail = (stderr: string): CommandResult => ({ ok: false, code: 1, stdout: "", stderr });
    if (!this.installed.includes(cmd)) return fail(`'${cmd}' is not recognized as an internal or external command`);
    if (args[0] === "--version") return ok(cmd === "claude" ? "2.1.280 (Claude Code)" : cmd === "codex" ? "codex-cli 0.156.1" : "1.0.0");
    if (cmd === "claude" && args[0] === "mcp" && args[1] === "remove") {
      const j = this.read();
      const servers = (j.mcpServers ?? {}) as Record<string, unknown>;
      if (!(args[2] in servers)) return fail(`No user-scoped MCP server found with name: ${args[2]}`);
      delete servers[args[2]];
      j.mcpServers = servers;
      this.write(j);
      return ok(`Removed MCP server ${args[2]} from user config`);
    }
    if (cmd === "claude" && args[0] === "mcp" && args[1] === "add") {
      if (this.failAdd) return fail("simulated failure");
      const name = args[2];
      const env: Record<string, string> = {};
      let i = 3;
      while (i < args.length && args[i] !== "--") {
        if (args[i] === "-e") {
          const [k, ...v] = args[i + 1].split("=");
          env[k] = v.join("=");
          i += 2;
        } else i++;
      }
      const rest = args.slice(i + 1);
      const j = this.read();
      const servers = (j.mcpServers ?? {}) as Record<string, unknown>;
      if (name in servers) return fail(`MCP server ${name} already exists in user config`);
      servers[name] = { type: "stdio", command: rest[0], args: rest.slice(1), env };
      j.mcpServers = servers;
      this.write(j);
      return ok(`Added stdio MCP server ${name} to user config`);
    }
    return fail(`unsupported fake command: ${cmd} ${args.join(" ")}`);
  }
}
