import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

let t: TestCtx;

afterEach(async () => {
  if (t) await cleanupTestApp(t);
});

describe("Dashboard static hosting + SPA fallback", () => {
  it("GET / serves the Dashboard's index.html (apps/dashboard/dist is built in this repo)", async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("<div id=\"root\"");
  });

  it("GET /keys (unknown, non-/v1 route) falls back to index.html for client-side routing", async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: "GET", url: "/keys" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("GET /v1/nope (unknown /v1 route) still returns JSON 404, never HTML", async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});
