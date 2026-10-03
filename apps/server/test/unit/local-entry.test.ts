import { afterEach, expect, it } from "vitest";
import { SetupTokenStore } from "@moneyswitch/core";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
let t: TestCtx;
afterEach(async () => { if (t) await cleanupTestApp(t); });

it("a local launcher must authenticate, then its link works once without consuming initial setup", async () => {
  t = await buildTestApp();
  t.ctx.setup = new SetupTokenStore();
  const setup = t.ctx.setup.issue(t.adminToken);
  expect((await t.app.inject({ method: "POST", url: "/v1/admin/local-link", remoteAddress: "127.0.0.1" })).statusCode).toBe(403);
  expect((await t.app.inject({ method: "POST", url: "/v1/admin/local-link", headers: { authorization: "Bearer mk_live_not_admin" } })).statusCode).toBe(403);
  const response = await t.app.inject({ method: "POST", url: "/v1/admin/local-link", headers: { authorization: `Bearer ${t.adminToken}` } });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body).not.toContain(t.adminToken);
  expect(response.json().expires_in_seconds).toBe(60);
  const payload = { local_token: response.json().path.split("#")[1] };
  const claim = await t.app.inject({ method: "POST", url: "/v1/local/claim", payload });
  expect(claim.json().admin_token).toBe(t.adminToken);
  expect((await t.app.inject({ method: "POST", url: "/v1/local/claim", payload })).statusCode).toBe(410);
  expect((await t.app.inject({ method: "POST", url: "/v1/setup/claim", payload: { setup_token: setup } })).statusCode).toBe(200);
});

it("does not issue desktop login links when listening on a public interface", async () => {
  t = await buildTestApp();
  t.ctx.config.host = "0.0.0.0";
  expect((await t.app.inject({ method: "POST", url: "/v1/admin/local-link", headers: { authorization: `Bearer ${t.adminToken}` } })).statusCode).toBe(404);
  expect((await t.app.inject({ method: "POST", url: "/v1/local/claim", payload: { local_token: "guess" } })).statusCode).toBe(410);
});
