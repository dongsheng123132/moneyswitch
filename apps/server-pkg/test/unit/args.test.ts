import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/args.js";

describe("moneyswitch-server argv", () => {
  it("defaults to the self-hosted server", () => {
    expect(parseArgs([])).toEqual({ kind: "serve", dataDir: null, port: null, host: null });
    expect(parseArgs(["--data-dir", "/srv/ms", "--port=5000", "--host", "0.0.0.0"])).toEqual({
      kind: "serve",
      dataDir: "/srv/ms",
      port: 5000,
      host: "0.0.0.0",
    });
  });

  it("has no offline demo any more: `demo` and --no-open are unknown arguments", () => {
    expect(parseArgs(["demo"]).kind).toBe("error");
    expect(parseArgs(["demo", "--no-open", "--port", "4100"]).kind).toBe("error");
  });

  it("rejects bad ports and unknown args", () => {
    expect(parseArgs(["--port", "0"]).kind).toBe("error");
    expect(parseArgs(["--port", "abc"]).kind).toBe("error");
    expect(parseArgs(["--bogus"]).kind).toBe("error");
    expect(parseArgs(["--no-open"]).kind).toBe("error");
  });

  it("help / version", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
  });
});

describe("moneyswitch-server reset-admin-token", () => {
  it("is a subcommand that takes only --data-dir (optional: the service's own data directory by default)", () => {
    expect(parseArgs(["reset-admin-token"])).toEqual({ kind: "reset-admin-token", dataDir: null });
    expect(parseArgs(["reset-admin-token", "--data-dir", "/srv/ms"])).toEqual({ kind: "reset-admin-token", dataDir: "/srv/ms" });
    expect(parseArgs(["reset-admin-token", "--data-dir=/srv/ms"])).toEqual({ kind: "reset-admin-token", dataDir: "/srv/ms" });
  });

  it("refuses what does not belong to it: --port, --host, extra words, a missing path, and the subcommand anywhere but first", () => {
    for (const argv of [
      ["reset-admin-token", "--port", "5000"],
      ["reset-admin-token", "-p", "5000"],
      ["reset-admin-token", "--host", "0.0.0.0"],
      ["reset-admin-token", "now"],
      ["reset-admin-token", "--data-dir"],
      ["reset-admin-token", "--bogus"],
      ["--data-dir", "/srv/ms", "reset-admin-token"],
      ["serve", "reset-admin-token"],
    ]) {
      expect(parseArgs(argv).kind, argv.join(" ")).toBe("error");
    }
    expect(parseArgs(["reset-admin-token", "--port", "5000"])).toMatchObject({ message: expect.stringMatching(/--port does not apply to reset-admin-token/) });
  });

  it("--help and --version still answer, and serving is unchanged", () => {
    expect(parseArgs(["reset-admin-token", "--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["reset-admin-token", "-v"])).toEqual({ kind: "version" });
    expect(parseArgs(["start", "--port", "4100"])).toEqual({ kind: "serve", dataDir: null, port: 4100, host: null });
  });
});
