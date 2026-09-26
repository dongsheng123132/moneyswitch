import { describe, it, expect } from "vitest";
import { parseSellArgs, SELL_HELP } from "../../src/sell.js";
import { parseTopArgv, TOP_HELP } from "../../src/cli.js";

const ADDR = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

describe("moneyswitch sell — argument parsing (SPEC-v0.5 §4)", () => {
  it("dispatches `sell` with its own args", () => {
    expect(parseTopArgv(["sell", "--upstream", "http://x"])).toEqual({ kind: "sell", args: ["--upstream", "http://x"] });
    expect(TOP_HELP).toContain("moneyswitch sell");
  });

  it("parses a full command", () => {
    const r = parseSellArgs([
      "--upstream",
      "http://localhost:8000/",
      "--price",
      "0.01",
      "--pay-to",
      ADDR.toLowerCase(),
      "--route",
      "POST /v1/chat/completions=0.02",
      "--route=GET /health=0",
      "--port",
      "4499",
    ], {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.opts.upstream).toBe("http://localhost:8000");
    expect(r.opts.payTo).toBe(ADDR); // checksummed
    expect(r.opts.defaultPrice).toBe(10_000n);
    expect(r.opts.routes).toEqual([
      { method: "POST", pathPattern: "/v1/chat/completions", price: 20_000n },
      { method: "GET", pathPattern: "/health", price: 0n },
    ]);
    expect(r.opts.port).toBe(4499);
    expect(r.opts.facilitatorUrl).toBe("https://x402-facilitator.molandak.org");
  });

  it("routes only → unmatched requests are refused (defaultPrice null)", () => {
    const r = parseSellArgs(["--upstream", "http://x", "--pay-to", ADDR, "--route", "/a=1"], {});
    expect(r.ok && r.opts.defaultPrice).toBeNull();
  });

  it.each([
    [["--upstream", "http://x", "--price", "0.01", "--pay-to", "mk_live_abcdefghijk"], /MoneyKey/],
    [["--upstream", "http://x", "--price", "0.01", "--pay-to", "0x" + "ab".repeat(32)], /private key/],
    [["--upstream", "http://x", "--price", "0.01", "--pay-to", "ms_admin_abc"], /admin token/],
    [["--upstream", "http://x", "--price", "0.01"], /--pay-to is required/],
    [["--price", "0.01", "--pay-to", ADDR], /--upstream is required/],
    [["--upstream", "ftp://x", "--price", "0.01", "--pay-to", ADDR], /--upstream/],
    [["--upstream", "http://x", "--pay-to", ADDR], /--price/],
    [["--upstream", "http://x", "--price", "abc", "--pay-to", ADDR], /not a USDC amount/],
    [["--upstream", "http://x", "--price", "0.01", "--pay-to", ADDR, "--network", "mainnet"], /not supported/],
    [["--upstream", "http://x", "--price", "0.01", "--pay-to", ADDR, "--route", "POST /x"], /--route/],
    [["--upstream", "http://x", "--price", "0.01", "--pay-to", ADDR, "--bogus"], /Unknown option/],
  ])("refuses %j", (argv, msg) => {
    const r = parseSellArgs(argv as string[], {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(msg);
      // a refused secret is never echoed back
      expect(r.error).not.toContain("mk_live_abcdefghijk");
    }
  });

  it("help explains public pay-to and the settle-on-success rule", () => {
    expect(SELL_HELP).toMatch(/PUBLIC receiving address/);
    expect(SELL_HELP).toMatch(/errors are never charged/);
  });
});
