import { describe, it, expect } from "vitest";
import type { CommandRunner, CommandResult } from "../../src/lib/runner.js";
import { applyClaude, removeClaude } from "../../src/lib/claude.js";

/**
 * SPEC-v0.3-employee.md §B.4: "Claude Code 部分用可注入的命令执行器做单测（不要真的改本机 Claude 配置）"
 */
class FakeRunner implements CommandRunner {
  calls: { cmd: string; args: string[] }[] = [];
  results: Map<string, CommandResult>;
  constructor(results: Map<string, CommandResult> = new Map()) {
    this.results = results;
  }
  run(cmd: string, args: string[]): CommandResult {
    this.calls.push({ cmd, args });
    const key = [cmd, ...args].join(" ");
    return this.results.get(key) ?? { ok: true, code: 0, stdout: "", stderr: "" };
  }
}

describe("claude integration (SPEC-v0.3-employee.md §B.2 step 3, §B.4)", () => {
  it("applyClaude removes any existing entry first, then adds with -e env vars and node entry path", () => {
    const runner = new FakeRunner();
    const res = applyClaude(runner, "http://127.0.0.1:4020", "mk_live_xyz", {
      command: "node",
      args: ["/abs/mcp/dist/index.js"],
    });
    expect(runner.calls).toEqual([
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
          "MONEY_API_BASE=http://127.0.0.1:4020",
          "-e",
          "MONEY_API_KEY=mk_live_xyz",
          "--",
          "node",
          "/abs/mcp/dist/index.js",
        ],
      },
    ]);
    expect(res.added.ok).toBe(true);
  });

  it("applyClaude still adds even if the remove call fails (no prior entry)", () => {
    const runner = new FakeRunner(
      new Map([["claude mcp remove moneyswitch -s user", { ok: false, code: 1, stdout: "", stderr: "not found" }]])
    );
    const res = applyClaude(runner, "http://s", "mk_live_a", { command: "node", args: ["/x.js"] });
    expect(res.removed.ok).toBe(false);
    expect(res.added.ok).toBe(true);
    expect(runner.calls.length).toBe(2);
  });

  it("removeClaude runs `claude mcp remove moneyswitch -s user`", () => {
    const runner = new FakeRunner();
    const res = removeClaude(runner);
    expect(runner.calls).toEqual([{ cmd: "claude", args: ["mcp", "remove", "moneyswitch", "-s", "user"] }]);
    expect(res.ok).toBe(true);
  });
});
