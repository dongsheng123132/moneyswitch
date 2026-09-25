import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { SetupTokenStore } from "@moneyswitch/core";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

let t: TestCtx;

afterEach(async () => {
  if (t) await cleanupTestApp(t);
});

async function withSetup() {
  t = await buildTestApp();
  const store = new SetupTokenStore();
  const setupToken = store.issue(t.adminToken);
  t.ctx.setup = store;
  return setupToken;
}

describe("First-run setup link", () => {
  it("status is inactive when no setup link was issued (every boot except the first)", async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: "GET", url: "/v1/setup/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ setup_link_active: false });
    const claim = await t.app.inject({ method: "POST", url: "/v1/setup/claim", payload: { setup_token: "ms_setup_x" } });
    expect(claim.statusCode).toBe(410);
  });

  it("claim hands over a working admin token exactly once, with no-store", async () => {
    const setupToken = await withSetup();
    expect((await t.app.inject({ method: "GET", url: "/v1/setup/status" })).json()).toEqual({ setup_link_active: true });

    const res = await t.app.inject({ method: "POST", url: "/v1/setup/claim", payload: { setup_token: setupToken } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const adminToken = res.json().admin_token as string;
    expect(adminToken).toBe(t.adminToken);

    const keys = await t.app.inject({ method: "GET", url: "/v1/keys", headers: { authorization: `Bearer ${adminToken}` } });
    expect(keys.statusCode).toBe(200);

    const again = await t.app.inject({ method: "POST", url: "/v1/setup/claim", payload: { setup_token: setupToken } });
    expect(again.statusCode).toBe(410);
    expect(again.json()).toEqual({ error: "SETUP_USED" });
    expect((await t.app.inject({ method: "GET", url: "/v1/setup/status" })).json()).toEqual({ setup_link_active: false });
  });

  it("wrong token, a MoneyKey, or the admin token itself cannot claim", async () => {
    const setupToken = await withSetup();
    for (const bad of ["ms_setup_wrong", t.adminToken, "mk_live_abc", "", 123, null]) {
      const res = await t.app.inject({ method: "POST", url: "/v1/setup/claim", payload: { setup_token: bad } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "SETUP_INVALID" });
      expect(res.json().admin_token).toBeUndefined();
    }
    // Loopback is NOT trusted: no body at all from 127.0.0.1 is still refused.
    const noBody = await t.app.inject({ method: "POST", url: "/v1/setup/claim", remoteAddress: "127.0.0.1" });
    expect(noBody.statusCode).toBe(403);
    // still claimable by the real token afterwards (6+1 < 10 attempts)
    const ok = await t.app.inject({ method: "POST", url: "/v1/setup/claim", payload: { setup_token: setupToken } });
    expect(ok.statusCode).toBe(200);
  });

  it("burns after 10 failed attempts", async () => {
    const setupToken = await withSetup();
    for (let i = 0; i < 10; i++) {
      await t.app.inject({ method: "POST", url: "/v1/setup/claim", payload: { setup_token: `ms_setup_guess${i}` } });
    }
    const res = await t.app.inject({ method: "POST", url: "/v1/setup/claim", payload: { setup_token: setupToken } });
    expect(res.statusCode).toBe(410);
    expect(res.json().admin_token).toBeUndefined();
  });

  it("/v1/admin/meta requires the admin token and exposes no secrets", async () => {
    t = await buildTestApp();
    expect((await t.app.inject({ method: "GET", url: "/v1/admin/meta" })).statusCode).toBe(403);
    t.ctx.config.demoSellerUrl = "http://127.0.0.1:18021";
    const res = await t.app.inject({ method: "GET", url: "/v1/admin/meta", headers: { authorization: `Bearer ${t.adminToken}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.network).toBe("eip155:10143");
    expect(body.chain_id).toBe(10143);
    expect(body.demo_seller_url).toBe("http://127.0.0.1:18021");
    expect(typeof body.cli_tarball_available).toBe("boolean");
    expect(JSON.stringify(body)).not.toContain("ms_admin_");
  });

  it("/dl/moneyswitch.tgz serves the packed CLI when present, JSON 404 otherwise", async () => {
    t = await buildTestApp();
    t.ctx.config.cliTarballPath = path.join(t.tmpDir, "missing.tgz");
    const missing = await t.app.inject({ method: "GET", url: "/dl/moneyswitch.tgz" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("not_found");

    const p = path.join(t.tmpDir, "moneyswitch.tgz");
    fs.writeFileSync(p, Buffer.from([0x1f, 0x8b, 1, 2, 3]));
    t.ctx.config.cliTarballPath = p;
    const ok = await t.app.inject({ method: "GET", url: "/dl/moneyswitch.tgz" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("application/gzip");
    expect(ok.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });
});

describe("buildContext setup link printing", () => {
  it("prints a one-time /setup# link only on the first boot of a data dir; restart has none", async () => {
    const os = await import("node:os");
    const { vi } = await import("vitest");
    const { buildContext } = await import("../../src/context.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-setup-ctx-"));
    const config = { port: 18555, host: "0.0.0.0", dataDir: dir, dbFilePath: path.join(dir, "db.sqlite"), walletPassword: null };
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      const first = await buildContext(config);
      const out = lines.join("\n");
      const link = /http:\/\/127\.0\.0\.1:18555\/setup#(ms_setup_[A-Za-z0-9]{32})/.exec(out);
      expect(link).not.toBeNull();
      expect(first.setup?.isActive()).toBe(true);
      expect(first.setup?.claim(link![1]).ok).toBe(true);
      first.sqlite.close();

      lines.length = 0;
      const second = await buildContext(config);
      expect(lines.join("\n")).not.toContain("/setup#");
      expect(second.setup?.isActive()).toBe(false);
      second.sqlite.close();
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
