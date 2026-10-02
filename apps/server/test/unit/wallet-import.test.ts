import { afterEach, describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

let t: TestCtx;
afterEach(async () => { if (t) await cleanupTestApp(t); });

describe("wallet import and backup", () => {
  it("requires administrator auth and never returns plaintext keys or passwords", async () => {
    t = await buildTestApp();
    const original = Wallet.createRandom();
    const password = "wallet-import-test-password";
    const payload = { kind: "private_key", private_key: original.privateKey, password };
    for (const url of ["/v1/admin/wallet/import", "/v1/admin/wallet/backup"]) {
      expect((await t.app.inject({ method: "POST", url, payload })).statusCode).toBe(403);
    }
    const headers = { authorization: `Bearer ${t.adminToken}` };
    const moneyKey = (await t.app.inject({ method: "POST", url: "/v1/keys", headers, payload: { name: "employee", total_budget: "1", daily_budget: "1", per_request_limit: "0.01", allowed_hosts: [] } })).json().key;
    for (const url of ["/v1/admin/wallet/import", "/v1/admin/wallet/backup"]) {
      expect((await t.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${moneyKey}` }, payload })).statusCode).toBe(403);
    }
    const imported = await t.app.inject({ method: "POST", url: "/v1/admin/wallet/import", headers, payload });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toEqual({ address: original.address });
    t.ctx.wallet.lock();
    const backup = await t.app.inject({ method: "POST", url: "/v1/admin/wallet/backup", headers });
    expect(backup.statusCode).toBe(200);
    expect(backup.headers["cache-control"]).toBe("no-store");
    const restored = await Wallet.fromEncryptedJson(backup.json().keystore, password);
    expect(restored.address).toBe(original.address);
    const audit = JSON.stringify(t.ctx.sqlite.prepare("SELECT * FROM audit_log").all());
    for (const secret of [password, original.privateKey, original.privateKey.slice(2)]) {
      expect(imported.body + backup.body + audit).not.toContain(secret);
    }
    const second = await t.app.inject({ method: "POST", url: "/v1/admin/wallet/import", headers, payload: { ...payload, private_key: Wallet.createRandom().privateKey } });
    expect(second.statusCode).toBe(400);
    expect(t.ctx.wallet.getAddress()).toBe(original.address);
  });

  it("rejects malformed imports without echoing input or creating a wallet", async () => {
    t = await buildTestApp();
    const headers = { authorization: `Bearer ${t.adminToken}` };
    const bad = "secret-that-must-not-be-reflected";
    const res = await t.app.inject({ method: "POST", url: "/v1/admin/wallet/import", headers, payload: { kind: "private_key", private_key: bad, password: "valid-password" } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(bad);
    const malformed = await t.app.inject({ method: "POST", url: "/v1/admin/wallet/import", headers: { ...headers, "content-type": "application/json" }, payload: `{"private_key":"${bad}` });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain(bad);
    expect(t.ctx.wallet.hasKeystore()).toBe(false);
    expect((await t.app.inject({ method: "POST", url: "/v1/admin/wallet/backup", headers })).statusCode).toBe(404);
  });
});
