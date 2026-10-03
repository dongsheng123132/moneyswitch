import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { Wallet } from "ethers";
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
      url: "/v1/admin/wallet/unlock",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: { password: "test-password-123" },
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
    await call("/v1/admin/wallet/backup/confirm", { positions: [1, 12], words: [words[0], words[11]] });
    await call("/v1/admin/wallet/reveal", { confirm_address: created.address });
    const unlockSecret = fs.readFileSync(unlockSecretPath(t.tmpDir, created.address), "utf-8");
    await call("/v1/admin/wallet/backup", { password: "redaction-file-password" });
    await call("/v1/admin/wallet/auto-unlock", { enabled: false, password: "redaction-wallet-password" });
    await call("/v1/admin/wallet/unlock", { password: "redaction-wallet-password" });
    const replaced = (await call("/v1/admin/wallet/replace", { confirm_address: created.address })).json() as { recovery_phrase: string };
    const imported = Wallet.createRandom();
    await call("/v1/admin/wallet/import", { kind: "private_key", private_key: imported.privateKey });
    await call("/v1/admin/wallet/import", { kind: "mnemonic", mnemonic: replaced.recovery_phrase });
    await loggedApp.close();

    expect(captured).toContain("/v1/admin/wallet/reveal"); // the requests really were logged
    for (const secret of [
      created.recovery_phrase,
      replaced.recovery_phrase,
      words.slice(0, 4).join(" "),
      unlockSecret,
      "redaction-file-password",
      "redaction-wallet-password",
      imported.privateKey,
      imported.privateKey.slice(2),
      t.adminToken,
    ]) {
      expect(captured).not.toContain(secret);
    }
  });
});
