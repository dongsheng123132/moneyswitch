import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/lib/cli.js";
import type { CommandRunner, CommandResult } from "../../src/lib/runner.js";
import type { FetchLike } from "../../src/lib/status.js";

class FakeRunner implements CommandRunner {
  calls: { cmd: string; args: string[] }[] = [];
  claudePresent: boolean;
  constructor(claudePresent = true) {
    this.claudePresent = claudePresent;
  }
  run(cmd: string, args: string[]): CommandResult {
    this.calls.push({ cmd, args });
    if (cmd === "claude" && args[0] === "--version") {
      return this.claudePresent
        ? { ok: true, code: 0, stdout: "claude 1.0.0", stderr: "" }
        : { ok: false, code: null, stdout: "", stderr: "not found" };
    }
    if (cmd === "codex") {
      return { ok: false, code: null, stdout: "", stderr: "not found" };
    }
    return { ok: true, code: 0, stdout: "", stderr: "" };
  }
}

const STATUS_BODY = {
  remaining_today: "0.29",
  remaining_total: "9.71",
  per_request_limit: "1",
  currency: "USDC",
  network: "eip155:10143",
  key_name: "employee-1",
  key_prefix: "mk_live_ab12",
  daily_budget: "0.30",
  total_budget: "10",
};

function fakeFetch(overrides: Partial<{ ok: boolean; status: number; body: unknown }> = {}): FetchLike {
  const ok = overrides.ok ?? true;
  const status = overrides.status ?? (ok ? 200 : 401);
  const body = overrides.body ?? (ok ? STATUS_BODY : { error: "KEY_INVALID" });
  return async () => new Response(JSON.stringify(body), { status });
}

function collector() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

const dirs: string[] = [];
function tmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ms-connect-home-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("runCli status command", () => {
  it("prints status as JSON and exits 0", async () => {
    const out = collector();
    const err = collector();
    const code = await runCli(["status", "--server", "http://127.0.0.1:9", "--key", "mk_live_x", "--json"], {
      stdout: out.sink,
      stderr: err.sink,
      fetchImpl: fakeFetch(),
      runner: new FakeRunner(),
      env: {},
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.lines[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.status.key_name).toBe("employee-1");
    expect(parsed.status.daily_budget).toBe("0.30");
  });

  it("exits 1 and prints JSON on invalid key", async () => {
    const out = collector();
    const code = await runCli(["status", "--server", "http://s", "--key", "mk_live_bad", "--json"], {
      stdout: out.sink,
      stderr: () => {},
      fetchImpl: fakeFetch({ ok: false }),
      runner: new FakeRunner(),
      env: {},
    });
    expect(code).toBe(1);
    expect(JSON.parse(out.lines[0]).ok).toBe(false);
  });
});

describe("runCli arg errors", () => {
  it("exits 2 with unknown flag", async () => {
    const out = collector();
    const code = await runCli(["--bogus"], { stdout: out.sink, stderr: () => {}, isTTY: false });
    expect(code).toBe(2);
    expect(JSON.parse(out.lines[0]).ok).toBe(false);
  });

  it("exits 2 when --server/--key missing", async () => {
    const code = await runCli([], { stdout: () => {}, stderr: () => {}, isTTY: false });
    expect(code).toBe(2);
  });
});

describe("runCli connect (default) command dry-run vs --apply (SPEC-v0.3-employee.md §B.2)", () => {
  it("dry-run lists planned actions without touching codex config or invoking claude add/remove", async () => {
    const home = tmpHome();
    const runner = new FakeRunner(true);
    const out = collector();
    const code = await runCli(
      ["--server", "http://127.0.0.1:9", "--key", "mk_live_x", "--json"],
      {
        stdout: out.sink,
        stderr: () => {},
        fetchImpl: fakeFetch(),
        runner,
        env: { CODEX_HOME: path.join(home, ".codex") },
        mcpCommand: { command: "node", args: ["/abs/mcp/dist/index.js"] },
      }
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.lines[0]);
    expect(parsed.applied).toBe(false);
    const claudeAgent = parsed.agents.find((a: any) => a.name === "claude");
    expect(claudeAgent.detected).toBe(true);
    expect(claudeAgent.action).toContain("would run: claude mcp add moneyswitch");
    // dry-run must not actually call `claude mcp add/remove`
    expect(runner.calls.some((c) => c.args.includes("add") || c.args.includes("remove"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex", "config.toml"))).toBe(false);
  });

  it("--apply invokes claude add and writes codex config.toml", async () => {
    const home = tmpHome();
    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { recursive: true }); // makes detectCodex see it as present
    const runner = new FakeRunner(true);
    const out = collector();
    const code = await runCli(
      ["--server", "http://127.0.0.1:9", "--key", "mk_live_x", "--apply", "--json"],
      {
        stdout: out.sink,
        stderr: () => {},
        fetchImpl: fakeFetch(),
        runner,
        env: { CODEX_HOME: codexHome },
        mcpCommand: { command: "node", args: ["/abs/mcp/dist/index.js"] },
      }
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.lines[0]);
    expect(parsed.applied).toBe(true);
    const claudeAgent = parsed.agents.find((a: any) => a.name === "claude");
    expect(claudeAgent.action).toBe("added");
    expect(runner.calls).toEqual([
      { cmd: "claude", args: ["--version"] },
      { cmd: "codex", args: ["--version"] },
      { cmd: "claude", args: ["mcp", "remove", "moneyswitch", "-s", "user"] },
      {
        cmd: "claude",
        args: [
          "mcp",
          "add",
          "moneyswitch",
          "-s",
          "user",
          "-e",
          "MONEY_API_BASE=http://127.0.0.1:9",
          "-e",
          "MONEY_API_KEY=mk_live_x",
          "--",
          "node",
          "/abs/mcp/dist/index.js",
        ],
      },
    ]);
    const cfgPath = path.join(codexHome, "config.toml");
    expect(fs.existsSync(cfgPath)).toBe(true);
    const text = fs.readFileSync(cfgPath, "utf8");
    expect(text).toContain("[mcp_servers.moneyswitch]");
    expect(text).toContain("mk_live_x");
    expect(text).toContain("/abs/mcp/dist/index.js");
  });

  it("skips claude when not detected in PATH", async () => {
    const home = tmpHome();
    const runner = new FakeRunner(false);
    const out = collector();
    const code = await runCli(
      ["--server", "http://127.0.0.1:9", "--key", "mk_live_x", "--apply", "--json"],
      {
        stdout: out.sink,
        stderr: () => {},
        fetchImpl: fakeFetch(),
        runner,
        env: { CODEX_HOME: path.join(home, ".codex") },
        mcpCommand: { command: "node", args: ["/abs/mcp/dist/index.js"] },
      }
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.lines[0]);
    expect(parsed.agents.find((a: any) => a.name === "claude").action).toBe("not_found");
    expect(runner.calls.some((c) => c.cmd === "claude" && c.args[0] === "mcp")).toBe(false);
  });
});

describe("runCli remove command", () => {
  it("dry-run reports what would be removed without invoking claude or touching config", async () => {
    const home = tmpHome();
    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    const cfgPath = path.join(codexHome, "config.toml");
    fs.writeFileSync(cfgPath, "[mcp_servers.moneyswitch]\ncommand = \"node\"\n", "utf8");
    const runner = new FakeRunner(true);
    const out = collector();
    const code = await runCli(["remove", "--json"], {
      stdout: out.sink,
      stderr: () => {},
      runner,
      env: { CODEX_HOME: codexHome },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.lines[0]).applied).toBe(false);
    expect(runner.calls.some((c) => c.args.includes("remove"))).toBe(false);
    expect(fs.readFileSync(cfgPath, "utf8")).toContain("moneyswitch");
  });

  it("--apply removes claude entry and strips codex config section, leaving a backup", async () => {
    const home = tmpHome();
    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    const cfgPath = path.join(codexHome, "config.toml");
    fs.writeFileSync(
      cfgPath,
      "[mcp_servers.other]\ncommand = \"x\"\n\n[mcp_servers.moneyswitch]\ncommand = \"node\"\n",
      "utf8"
    );
    const runner = new FakeRunner(true);
    const out = collector();
    const code = await runCli(["remove", "--apply", "--json"], {
      stdout: out.sink,
      stderr: () => {},
      runner,
      env: { CODEX_HOME: codexHome },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.lines[0]);
    expect(parsed.applied).toBe(true);
    expect(runner.calls).toContainEqual({ cmd: "claude", args: ["mcp", "remove", "moneyswitch", "-s", "user"] });
    const text = fs.readFileSync(cfgPath, "utf8");
    expect(text).toContain("[mcp_servers.other]");
    expect(text).not.toContain("moneyswitch");
    const backups = fs.readdirSync(codexHome).filter((f) => f.startsWith("config.toml.bak-"));
    expect(backups.length).toBe(1);
  });
});
