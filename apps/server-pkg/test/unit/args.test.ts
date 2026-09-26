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

  it("parses demo with defaults and --no-open", () => {
    expect(parseArgs(["demo"])).toEqual({ kind: "demo", port: 4020, host: "127.0.0.1", open: true });
    expect(parseArgs(["demo", "--no-open", "--port", "4100"])).toEqual({ kind: "demo", port: 4100, host: "127.0.0.1", open: false });
  });

  it("refuses --data-dir for demo (always a throwaway temp dir)", () => {
    expect(parseArgs(["demo", "--data-dir", "x"]).kind).toBe("error");
  });

  it("rejects bad ports and unknown args", () => {
    expect(parseArgs(["--port", "0"]).kind).toBe("error");
    expect(parseArgs(["--port", "abc"]).kind).toBe("error");
    expect(parseArgs(["--bogus"]).kind).toBe("error");
    expect(parseArgs(["--no-open"]).kind).toBe("error");
  });

  it("help / version", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help", topic: "serve" });
    expect(parseArgs(["demo", "-h"])).toEqual({ kind: "help", topic: "demo" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
  });
});
