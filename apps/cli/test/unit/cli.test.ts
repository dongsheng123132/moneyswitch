import { describe, it, expect } from "vitest";
import { parseTopArgv, TOP_HELP } from "../../src/cli.js";

describe("buyer CLI", () => {
  it("retains MCP and the offline demo", () => {
    expect(parseTopArgv(["mcp"])).toEqual({ kind: "mcp" });
    expect(parseTopArgv(["demo", "--no-open"])).toEqual({ kind: "demo", args: ["--no-open"] });
    expect(TOP_HELP).toContain("MoneyKey");
  });
  it.each(["ui", "connect", "remove", "status", "sell"])("rejects the retired %s command", (command) => {
    expect(parseTopArgv([command])).toEqual({ kind: "unknown", command });
  });
  it("shows help and version", () => {
    expect(parseTopArgv([])).toEqual({ kind: "help" });
    expect(parseTopArgv(["--help"])).toEqual({ kind: "help" });
    expect(parseTopArgv(["--version"])).toEqual({ kind: "version" });
  });
});
