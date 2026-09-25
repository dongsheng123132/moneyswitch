import { describe, it, expect } from "vitest";
import { parseTopArgv, TOP_HELP } from "../../src/cli.js";

describe("moneyswitch top-level argv dispatch", () => {
  it("routes `mcp` to the mcp bundle", () => {
    expect(parseTopArgv(["mcp"])).toEqual({ kind: "mcp" });
  });

  it("routes `connect ...` to connect-lib with the `connect` token stripped (runCli defaults to connect)", () => {
    expect(parseTopArgv(["connect", "--server", "http://s", "--key", "mk_live_x", "--apply"])).toEqual({
      kind: "connect-lib",
      args: ["--server", "http://s", "--key", "mk_live_x", "--apply"],
    });
  });

  it("routes `status ...` to connect-lib keeping the `status` token (runCli's own subcommand)", () => {
    expect(parseTopArgv(["status", "--server", "http://s", "--key", "mk_live_x"])).toEqual({
      kind: "connect-lib",
      args: ["status", "--server", "http://s", "--key", "mk_live_x"],
    });
  });

  it("routes `remove --apply` to connect-lib keeping the `remove` token", () => {
    expect(parseTopArgv(["remove", "--apply"])).toEqual({ kind: "connect-lib", args: ["remove", "--apply"] });
  });

  it("routes no args / --help / -h to help", () => {
    expect(parseTopArgv([])).toEqual({ kind: "help" });
    expect(parseTopArgv(["--help"])).toEqual({ kind: "help" });
    expect(parseTopArgv(["-h"])).toEqual({ kind: "help" });
  });

  it("routes unknown top-level commands to unknown", () => {
    expect(parseTopArgv(["bogus"])).toEqual({ kind: "unknown", command: "bogus" });
  });

  it("TOP_HELP documents all four subcommands", () => {
    expect(TOP_HELP).toContain("moneyswitch connect");
    expect(TOP_HELP).toContain("moneyswitch status");
    expect(TOP_HELP).toContain("moneyswitch remove");
    expect(TOP_HELP).toContain("moneyswitch mcp");
  });
});
