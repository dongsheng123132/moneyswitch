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
