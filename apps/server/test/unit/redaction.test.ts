import { describe, it, expect, afterEach } from "vitest";
import { Writable } from "node:stream";
import Fastify from "fastify";
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
});
