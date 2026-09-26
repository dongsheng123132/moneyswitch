import { describe, it, expect } from "vitest";
import { checkPayTo, checkKeyInput, detectSecretShape } from "../src/secrets.js";
import {
  buildUpstreamRequestHeaders,
  buildBuyerResponseHeaders,
  joinUpstreamUrl,
  normalizeUpstreamUrl,
  rewriteLocation,
} from "../src/forward.js";
import { isSelfTarget, isSelfTargetResolved, isLoopbackOrPrivateHost } from "../src/self-target.js";

const CHECKSUMMED = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

describe("pay_to validation (SPEC-v0.5 §1 防呆)", () => {
  it("accepts a checksummed address", () => {
    expect(checkPayTo(CHECKSUMMED)).toEqual({ ok: true, address: CHECKSUMMED });
  });
  it("accepts all-lower-case and returns the checksummed form", () => {
    expect(checkPayTo(CHECKSUMMED.toLowerCase())).toEqual({ ok: true, address: CHECKSUMMED });
    expect(checkPayTo("  " + CHECKSUMMED.toLowerCase() + " ")).toMatchObject({ ok: true });
  });
  it("rejects a mixed-case address with a wrong checksum", () => {
    const bad = CHECKSUMMED.replace("A3", "a3").replace("b2f", "B2f");
    expect(checkPayTo(bad)).toMatchObject({ ok: false, code: "BAD_CHECKSUM" });
  });
  it("rejects a MoneyKey, admin token, private key, mnemonic", () => {
    expect(checkPayTo("mk_live_abcDEF1234567890")).toMatchObject({ ok: false, code: "LOOKS_LIKE_MONEYKEY" });
    expect(checkPayTo("Bearer mk_live_abc")).toMatchObject({ ok: false, code: "LOOKS_LIKE_MONEYKEY" });
    expect(checkPayTo("ms_admin_abc")).toMatchObject({ ok: false, code: "LOOKS_LIKE_ADMIN_TOKEN" });
    expect(checkPayTo("0x" + "ab".repeat(32))).toMatchObject({ ok: false, code: "LOOKS_LIKE_PRIVATE_KEY" });
    expect(checkPayTo("ab".repeat(32))).toMatchObject({ ok: false, code: "LOOKS_LIKE_PRIVATE_KEY" });
    const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    expect(checkPayTo(phrase)).toMatchObject({ ok: false, code: "LOOKS_LIKE_MNEMONIC" });
  });
  it("rejects garbage and the zero address", () => {
    expect(checkPayTo("")).toMatchObject({ ok: false, code: "EMPTY" });
    expect(checkPayTo("0x1234")).toMatchObject({ ok: false, code: "NOT_AN_ADDRESS" });
    expect(checkPayTo("0x" + "0".repeat(40))).toMatchObject({ ok: false, code: "ZERO_ADDRESS" });
  });
  it("key inputs reject a pasted address / private key", () => {
    expect(checkKeyInput(CHECKSUMMED)).toBe("LOOKS_LIKE_ADDRESS");
    expect(checkKeyInput("0x" + "cd".repeat(32))).toBe("LOOKS_LIKE_PRIVATE_KEY");
    expect(checkKeyInput("mk_live_abc")).toBeNull();
    expect(detectSecretShape(CHECKSUMMED)).toBeNull();
  });
});

describe("forwarding headers", () => {
  const incoming = {
    host: "pay.example.com",
    authorization: "Bearer mk_live_secret",
    cookie: "session=1",
    "Payment-Signature": "abc",
    "x-payment": "v1",
    "x-moneyswitch-payer": "0xspoofed",
    "x-forwarded-for": "6.6.6.6",
    "x-http-method-override": "DELETE",
    connection: "keep-alive, x-secret-hop",
    "x-secret-hop": "1",
    "transfer-encoding": "chunked",
    "content-type": "application/json",
    accept: "application/json",
    "x-custom": ["a", "b"],
  };
  const out = buildUpstreamRequestHeaders(incoming, {
    tollbooth: "weather",
    payer: "0x1111111111111111111111111111111111111111",
    amount: "0.01",
    publicHost: "pay.example.com",
    publicProto: "https",
    clientIp: "10.0.0.9",
  });
  it("strips Authorization, Cookie, x402 headers, hop-by-hop, overrides, spoofed X-MoneySwitch-*", () => {
    for (const h of ["authorization", "cookie", "payment-signature", "x-payment", "connection", "x-secret-hop", "transfer-encoding", "x-http-method-override", "host"]) {
      expect(out[h]).toBeUndefined();
    }
  });
  it("adds X-MoneySwitch-Payer / Amount / Tollbooth and fresh X-Forwarded-*", () => {
    expect(out["x-moneyswitch-payer"]).toBe("0x1111111111111111111111111111111111111111");
    expect(out["x-moneyswitch-amount"]).toBe("0.01");
    expect(out["x-moneyswitch-tollbooth"]).toBe("weather");
    expect(out["x-forwarded-for"]).toBe("10.0.0.9");
    expect(out["x-forwarded-host"]).toBe("pay.example.com");
    expect(out["content-type"]).toBe("application/json");
    expect(out["x-custom"]).toBe("a, b");
  });
  it("free route: no payer header", () => {
    const free = buildUpstreamRequestHeaders({ authorization: "x" }, { tollbooth: "t", payer: null, amount: "0" });
    expect(free["x-moneyswitch-payer"]).toBeUndefined();
    expect(free["x-moneyswitch-amount"]).toBe("0");
  });
  it("keeps Host only when forward_host_header is on", () => {
    expect(buildUpstreamRequestHeaders({ host: "h" }, { tollbooth: "t", payer: null, amount: "0", forwardHostHeader: true }).host).toBe("h");
  });
  it("response: strips Set-Cookie, spoofed PAYMENT-RESPONSE, encoding; sandboxes", () => {
    const res = buildBuyerResponseHeaders(
      new Headers({
        "set-cookie": "a=1",
        "payment-response": "forged",
        "content-encoding": "gzip",
        "content-length": "12",
        "content-type": "text/html",
        "x-moneyswitch-payer": "x",
      })
    );
    expect(res["set-cookie"]).toBeUndefined();
    expect(res["payment-response"]).toBeUndefined();
    expect(res["content-encoding"]).toBeUndefined();
    expect(res["x-moneyswitch-payer"]).toBeUndefined();
    expect(res["content-type"]).toBe("text/html");
    expect(res["content-security-policy"]).toBe("sandbox");
  });
});

describe("upstream URLs", () => {
  it("validates upstream base", () => {
    expect(normalizeUpstreamUrl("http://localhost:8000/")).toBe("http://localhost:8000");
    expect(normalizeUpstreamUrl("https://api.example.com/base/")).toBe("https://api.example.com/base");
    expect(() => normalizeUpstreamUrl("ftp://x")).toThrow();
    expect(() => normalizeUpstreamUrl("http://u:p@x")).toThrow();
    expect(() => normalizeUpstreamUrl("http://x/?a=1")).toThrow();
    expect(() => normalizeUpstreamUrl("localhost:8000")).toThrow();
  });
  it("joins base path + forward path + query without changing origin", () => {
    expect(joinUpstreamUrl("http://127.0.0.1:8000/api", "/v1/x", "?a=1").toString()).toBe("http://127.0.0.1:8000/api/v1/x?a=1");
    expect(joinUpstreamUrl("http://127.0.0.1:8000", "//evil.com/x", "").origin).toBe("http://127.0.0.1:8000");
  });
  it("rewrites upstream-internal redirects to the public toll booth URL", () => {
    expect(rewriteLocation("/api/login", "http://127.0.0.1:8000/api", "https://ms.example/t/w")).toBe("https://ms.example/t/w/login");
    expect(rewriteLocation("https://other.example/x", "http://127.0.0.1:8000", "https://ms.example/t/w")).toBe("https://other.example/x");
  });
});

describe("upstream SSRF: MoneySwitch's own port is refused", () => {
  const self = 4020;
  it.each([
    "http://127.0.0.1:4020/",
    "http://localhost:4020/",
    "http://LOCALHOST.:4020/",
    "http://[::1]:4020/",
    "http://[::ffff:127.0.0.1]:4020/",
    "http://0.0.0.0:4020/",
    "http://127.1:4020/",
    "http://10.1.2.3:4020/",
  ])("%s is self", (u) => {
    expect(isSelfTarget(new URL(u), self)).toBe(true);
  });
  it("other ports on loopback are allowed (sellers expose local services)", () => {
    expect(isSelfTarget(new URL("http://127.0.0.1:8000/"), self)).toBe(false);
    expect(isLoopbackOrPrivateHost("127.0.0.1")).toBe(true);
  });
  it("DNS names resolving to loopback on the self port are caught", async () => {
    expect(await isSelfTargetResolved(new URL("http://localhost:4020/"), self)).toBe(true);
    expect(await isSelfTargetResolved(new URL("http://localhost:4021/"), self)).toBe(false);
  });
});
