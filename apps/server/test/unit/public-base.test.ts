import { describe, it, expect, afterEach } from "vitest";
import { renderSkill } from "@moneyswitch/skill";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
import { bindOrigin, publicBaseUrl } from "../../src/public-base.js";

/**
 * Every link the server builds for itself (the approve_url the skill tells the AI to hand to a person, the base of /skill.md, the
 * public_base the Dashboard reads, the first-run sign-in link) comes from MONEYSWITCH_PUBLIC_URL, else from the address the server
 * itself listens on. Never from the request: the Host header is chosen by whoever sends the request, and a link the server hands out
 * as its own that can be steered to another site is a phishing path for the administrator token.
 */

let t: TestCtx;
afterEach(async () => {
  if (t) await cleanupTestApp(t);
});

describe("publicBaseUrl / bindOrigin", () => {
  it("MONEYSWITCH_PUBLIC_URL wins (trailing slashes dropped); otherwise the address the server listens on", () => {
    expect(publicBaseUrl({ publicUrl: "https://pay.example.com", host: "127.0.0.1", port: 4020 })).toBe("https://pay.example.com");
    expect(publicBaseUrl({ publicUrl: "https://pay.example.com//", host: "127.0.0.1", port: 4020 })).toBe("https://pay.example.com");
    expect(publicBaseUrl({ publicUrl: null, host: "127.0.0.1", port: 4020 })).toBe("http://127.0.0.1:4020");
    expect(publicBaseUrl({ host: "127.0.0.1", port: 4020 })).toBe("http://127.0.0.1:4020");
  });

  it("a wildcard bind address means this machine; an IPv6 literal is bracketed; a named host stays", () => {
    expect(bindOrigin({ host: "0.0.0.0", port: 4020 })).toBe("http://127.0.0.1:4020");
    expect(bindOrigin({ host: "::", port: 4020 })).toBe("http://127.0.0.1:4020");
    expect(bindOrigin({ host: "", port: 4020 })).toBe("http://127.0.0.1:4020");
    expect(bindOrigin({ host: "::1", port: 4020 })).toBe("http://[::1]:4020");
    expect(bindOrigin({ host: "pay.internal", port: 8080 })).toBe("http://pay.internal:8080");
  });
});

describe("no link is built from the request", () => {
  const FORGED = { host: "phish.example", "x-forwarded-host": "phish.example", "x-forwarded-proto": "https", origin: "https://phish.example" };

  it("GET /skill.md with a forged Host names the server's own address, nothing from the request", async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: "GET", url: "/skill.md", headers: FORGED });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(renderSkill({ baseUrl: "http://127.0.0.1:4020" }));
    expect(res.body).not.toContain("phish.example");
  });

  it("GET /v1/admin/meta: public_base is the server's own address, not the Host header", async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: "GET", url: "/v1/admin/meta", headers: { ...FORGED, authorization: `Bearer ${t.adminToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ public_base: "http://127.0.0.1:4020", public_base_from_env: false });
  });

  it("with MONEYSWITCH_PUBLIC_URL set, that is the base everywhere, whatever the request says", async () => {
    t = await buildTestApp();
    t.ctx.config.publicUrl = "https://pay.example.com";
    const skill = await t.app.inject({ method: "GET", url: "/skill.md", headers: FORGED });
    expect(skill.body).toBe(renderSkill({ baseUrl: "https://pay.example.com" }));
    const meta = await t.app.inject({ method: "GET", url: "/v1/admin/meta", headers: { ...FORGED, authorization: `Bearer ${t.adminToken}` } });
    expect(meta.json()).toMatchObject({ public_base: "https://pay.example.com", public_base_from_env: true });
  });

  it("a server bound to a name the skill cannot use renders the server-agnostic skill, never the request's host", async () => {
    t = await buildTestApp({ config: { host: "moneyswitch_srv" } }); // an underscore is not a valid host name for a skill
    const res = await t.app.inject({ method: "GET", url: "/skill.md", headers: FORGED });
    expect(res.body).toBe(renderSkill({}));
    expect(res.body).not.toContain("phish.example");
  });
});
