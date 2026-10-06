import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { createApproval, listAudit } from "@moneyswitch/core";
import { unlockSecretPath } from "@moneyswitch/wallet";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
import { registerAdminRoutes } from "../../src/routes/admin.js";
import { registerAgentRoutes } from "../../src/routes/agent.js";

let t: TestCtx;

afterEach(async () => {
  if (t) await cleanupTestApp(t);
});

describe("Log redaction", () => {
  it("full MoneyKey / admin token / wallet password never appear in log output", async () => {
    t = await buildTestApp({ unlockWallet: true });

    let captured = "";
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured += chunk.toString();
        cb();
      },
    });

    // Build a second app instance with the same ctx but a logger piped to
    // our capture stream, so we can inspect exactly what would be logged.
    const loggedApp = Fastify({ logger: { stream, level: "info" } });
    registerAdminRoutes(loggedApp, t.ctx);
    registerAgentRoutes(loggedApp, t.ctx);
    await loggedApp.ready();

    const createRes = await loggedApp.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: {
        name: "demo",
        total_budget: "5",
        daily_budget: "1",
        per_request_limit: "1",
        allowed_hosts: ["example.com:443"],
      },
    });
    const moneyKey = createRes.json().key as string;

    // Exercise a bunch of routes with secrets in headers/body.
    await loggedApp.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: `Bearer ${moneyKey}` },
    });
    await loggedApp.inject({
      method: "GET",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${t.adminToken}` },
    });
    await loggedApp.inject({
      method: "POST",
      url: "/v1/admin/wallet/create",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: { password: "test-password-123" }, // refused (no password wallets), but it must not be logged either
    });

    await loggedApp.close();

    expect(captured).not.toContain(moneyKey);
    expect(captured).not.toContain(t.adminToken);
    expect(captured).not.toContain("test-password-123");
  });

  it("recovery phrase / wallet passwords / unlock secret never appear in log output across the wallet lifecycle routes", async () => {
    t = await buildTestApp({ walletOptions: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, protect: false } });

    let captured = "";
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured += chunk.toString();
        cb();
      },
    });
    const loggedApp = Fastify({ logger: { stream, level: "trace" } });
    registerAdminRoutes(loggedApp, t.ctx);
    await loggedApp.ready();
    const headers = { authorization: `Bearer ${t.adminToken}` };
    const call = (url: string, payload?: object) => loggedApp.inject({ method: "POST", url, headers, ...(payload ? { payload } : {}) });

    const created = (await call("/v1/admin/wallet/create")).json() as { address: string; recovery_phrase: string };
    const words = created.recovery_phrase.split(" ");
    await call("/v1/admin/wallet/backup/confirm", { address: created.address });
    const unlockSecret = fs.readFileSync(unlockSecretPath(t.tmpDir, created.address), "utf-8");
    await call("/v1/admin/wallet/create", { password: "redaction-wallet-password" }); // refused, and still never logged
    const replaced = (await call("/v1/admin/wallet/replace", { confirm_address: created.address })).json() as { recovery_phrase: string };
    await loggedApp.close();

    expect(captured).toContain("/v1/admin/wallet/replace"); // the requests really were logged
    for (const secret of [created.recovery_phrase, replaced.recovery_phrase, words.slice(0, 4).join(" "), unlockSecret, "redaction-wallet-password", t.adminToken]) {
      expect(captured).not.toContain(secret);
    }
  });

  it("an approval PIN never appears in log output (issuing a key, setting a PIN, approving with it)", async () => {
    t = await buildTestApp();
    let captured = "";
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured += chunk.toString();
        cb();
      },
    });
    const loggedApp = Fastify({ logger: { stream, level: "trace" } });
    registerAdminRoutes(loggedApp, t.ctx);
    await loggedApp.ready();
    const headers = { authorization: `Bearer ${t.adminToken}` };

    const created = await loggedApp.inject({
      method: "POST",
      url: "/v1/keys",
      headers,
      payload: { name: "pin", total_budget: "5", daily_budget: "1", per_request_limit: "1", allowed_hosts: ["example.com:443"], approval_pin: "739155" },
    });
    const id = created.json().id as string;
    await loggedApp.inject({ method: "POST", url: `/v1/keys/${id}/approval-pin`, headers, payload: { approval_pin: "620417" } });
    const approval = createApproval(t.ctx.db, { keyId: id, url: "https://example.com/x", method: "GET", body: undefined, network: "n", asset: "a", payTo: "p", amount: 1n });
    await loggedApp.inject({ method: "POST", url: `/v1/approvals/${approval.id}/approve`, payload: { pin: "111111" } }); // wrong, counted
    await loggedApp.inject({ method: "POST", url: `/v1/approvals/${approval.id}/approve`, payload: { pin: "620417" } });
    await loggedApp.close();

    expect(captured).toContain("/approval-pin"); // the requests really were logged
    for (const pin of ["739155", "620417", "111111"]) {
      expect(captured).not.toContain(pin);
      expect(JSON.stringify(listAudit(t.ctx.db, 200))).not.toContain(pin);
    }
  });
});
