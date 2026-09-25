import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

let t: TestCtx;

afterEach(async () => {
  if (t) await cleanupTestApp(t);
});

async function createKey(t: TestCtx, allowedHosts: string[]) {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: { authorization: `Bearer ${t.adminToken}` },
    payload: {
      name: "demo",
      total_budget: "5",
      daily_budget: "1",
      per_request_limit: "1",
      allowed_hosts: allowedHosts,
    },
  });
  return res.json().key as string;
}

describe("/v1/fetch pre-flight gates", () => {
  it("HOST_NOT_ALLOWED for a host not in allowed_hosts", async () => {
    t = await buildTestApp();
    const key = await createKey(t, ["example.com:443"]);
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: "https://evil.com/x" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("denied");
    expect(body.code).toBe("HOST_NOT_ALLOWED");
  });

  it("SSRF_BLOCKED targeting MoneySwitch's own port, even if allow-listed", async () => {
    t = await buildTestApp({ port: 4020 });
    const key = await createKey(t, ["127.0.0.1:4020"]);
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: "http://127.0.0.1:4020/v1/status" },
    });
    const body = res.json();
    expect(body.status).toBe("denied");
    expect(body.code).toBe("SSRF_BLOCKED");
  });

  it("empty allowed_hosts rejects even a free request (allowlist applies to ALL /v1/fetch)", async () => {
    t = await buildTestApp();
    const key = await createKey(t, []);
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: "https://example.com/free" },
    });
    const body = res.json();
    expect(body.status).toBe("denied");
    expect(body.code).toBe("HOST_NOT_ALLOWED");
  });

  it("WALLET_LOCKED when gates pass but wallet is locked", async () => {
    t = await buildTestApp({ unlockWallet: false });
    const key = await createKey(t, ["example.com:443"]);
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: "https://example.com/premium" },
    });
    const body = res.json();
    expect(body.status).toBe("error");
    expect(body.code).toBe("WALLET_LOCKED");
  });
});
