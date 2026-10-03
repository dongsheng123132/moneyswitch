import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

/**
 * The route inventory (SPEC.md §9): "every external route is registered in the route-inventory test; a new route needs SPEC.md changed
 * first". INVENTORY below is that list - method, path, who may call it, what it is for.
 *
 * It is compared with the routes Fastify really registered (recorded by an onRoute hook on the application instance, not a grep of the
 * source), so a route added anywhere fails this test until it is written down here. The "who" column is not a comment: the tests below
 * call every route without credentials and with the wrong kind of credentials and expect a refusal.
 */

type Who = "public" | "admin" | "money-key";

const INVENTORY: Array<[method: string, path: string, who: Who, purpose: string]> = [
  // --- open to everyone ------------------------------------------------------------------------------------------------------
  ["GET", "/healthz", "public", "liveness probe for the reverse proxy and Docker"],
  ["GET", "/skill.md", "public", "the generic skill text for an AI (contains no key)"],
  ["GET", "/v1/setup/status", "public", "is the one-time sign-in link still unused"],
  ["POST", "/v1/setup/claim", "public", "exchange the one-time sign-in link for the administrator token (single use)"],

  // --- MoneyKey: what the AI calls (SPEC.md §1.3, §3) -------------------------------------------------------------------------
  ["POST", "/v1/fetch", "money-key", "the payment"],
  ["GET", "/v1/status", "money-key", "limits and what is left"],
  ["GET", "/v1/history", "money-key", "this key's payments"],
  ["GET", "/v1/approvals/:id", "money-key", "the AI polls its approval request every 15 s"],
  ["GET", "/v1/keys/children", "money-key", "child keys of this key (back end kept, no UI)"],
  ["POST", "/v1/keys/children", "money-key", "issue a child key (back end kept, no UI)"],
  ["POST", "/v1/keys/children/:id/revoke", "money-key", "revoke a child key (back end kept, no UI)"],

  // --- administrator: the four pages (SPEC.md §2) -----------------------------------------------------------------------------
  ["GET", "/v1/admin/meta", "admin", "instance facts: networks, public URL, version"],
  ["GET", "/v1/admin/wallet", "admin", "Wallet: address, balance per chain, status"],
  ["POST", "/v1/admin/wallet/create", "admin", "Wallet: create (the twelve words are shown once)"],
  ["POST", "/v1/admin/wallet/backup/confirm", "admin", "Wallet: \"I wrote the words down\""],
  ["POST", "/v1/admin/wallet/replace", "admin", "Wallet: replace (danger zone, needs the current address)"],
  ["GET", "/v1/keys", "admin", "Keys: the list"],
  ["POST", "/v1/keys", "admin", "Keys: issue"],
  ["POST", "/v1/keys/:id/rotate", "admin", "Keys: reset the secret and get the new skill paragraph"],
  ["POST", "/v1/keys/:id/revoke", "admin", "Keys: revoke"],
  ["GET", "/v1/admin/keys/tree", "admin", "child-key tree (back end kept, shown read-only on the Keys page)"],
  ["GET", "/v1/approvals", "admin", "Approvals: the list"],
  ["POST", "/v1/approvals/:id/approve", "admin", "Approvals: approve (needs the administrator login)"],
  ["POST", "/v1/approvals/:id/deny", "admin", "Approvals: deny"],
  ["GET", "/v1/admin/usage", "admin", "Bills: every payment"],
  ["POST", "/v1/admin/reconcile", "admin", "SPEC.md §4: look up unknown payments on the chain now (the background job does it every minute)"],
];

/** The Dashboard's files and its single-page-app pages: one wildcard, present only when a built Dashboard exists. */
const DASHBOARD_FILES = "GET /*";

/** Routes that existed in an earlier version and must stay gone; each answers a JSON 404 even for the administrator. */
const REMOVED: Array<[method: string, path: string, why: string]> = [
  ["GET", "/v1/admin/wallet/retired", "retired wallets are listed inside GET /v1/admin/wallet"],
  ["POST", "/v1/admin/wallet/import", "SPEC.md §5: no import"],
  ["POST", "/v1/admin/wallet/backup", "no download of the keystore"],
  ["POST", "/v1/admin/wallet/unlock", "SPEC.md §5: no password form, legacy wallets unlock at startup"],
  ["POST", "/v1/admin/wallet/reveal", "the twelve words are shown once, never again"],
  ["POST", "/v1/admin/wallet/auto-unlock", "there is only auto-unlock; no switch"],
  ["GET", "/v1/admin/notify", "SPEC.md §3: no push channels"],
  ["PUT", "/v1/admin/notify", "SPEC.md §3: no push channels"],
  ["POST", "/v1/admin/notify/test", "SPEC.md §3: no push channels"],
  ["POST", "/v1/admin/local-link", "SPEC.md §8: no local launcher"],
  ["POST", "/v1/local/claim", "SPEC.md §8: no local launcher"],
];

// ---- recording what Fastify registers ----------------------------------------------------------------------------------------

const seen = vi.hoisted(() => [] as Array<{ method: string | string[]; url: string }>);

vi.mock("fastify", async (importOriginal) => {
  const real = await importOriginal<typeof import("fastify")>();
  const recording = ((...args: Parameters<typeof real.default>) => {
    const app = real.default(...args);
    app.addHook("onRoute", (route) => {
      seen.push({ method: route.method, url: route.url });
    });
    return app;
  }) as typeof real.default;
  return { ...real, default: recording, fastify: recording };
});

/** "METHOD /path" for every registered route, sorted. HEAD is Fastify's automatic twin of each GET (the static-file route lists both) and is not a route of its own. */
function registered(): string[] {
  const all = new Set<string>();
  for (const route of seen) for (const method of ([] as string[]).concat(route.method)) all.add(`${method} ${route.url}`);
  return [...all].filter((r) => !(r.startsWith("HEAD ") && all.has(`GET ${r.slice(5)}`))).sort();
}

const listed = (withDashboard: boolean): string[] =>
  [...INVENTORY.map(([method, route]) => `${method} ${route}`), ...(withDashboard ? [DASHBOARD_FILES] : [])].sort();

// ---- the tests ---------------------------------------------------------------------------------------------------------------

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function appWith(dashboard: boolean): Promise<TestCtx> {
  const dashboardDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-inventory-dashboard-"));
  if (dashboard) fs.writeFileSync(path.join(dashboardDir, "index.html"), "<!doctype html><div id=\"root\"></div>");
  seen.length = 0;
  const t = await buildTestApp({ config: { dashboardDir } });
  cleanups.push(async () => {
    await cleanupTestApp(t);
    fs.rmSync(dashboardDir, { recursive: true, force: true });
  });
  return t;
}

describe("route inventory (SPEC.md §9)", () => {
  it("every registered route is in the inventory, and every inventory entry is registered (no Dashboard built)", async () => {
    await appWith(false);
    expect(registered()).toEqual(listed(false));
  });

  it("with a built Dashboard the only addition is its file wildcard", async () => {
    await appWith(true);
    expect(registered()).toEqual(listed(true));
  });

  it("the inventory has no duplicates and every route says who may call it", () => {
    const keys = INVENTORY.map(([method, route]) => `${method} ${route}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [method, route, who, purpose] of INVENTORY) {
      expect(["public", "admin", "money-key"], `${method} ${route}`).toContain(who);
      expect(purpose.length, `${method} ${route}`).toBeGreaterThan(5);
    }
  });

  it("every administrator route refuses a request without credentials and a MoneyKey (403); every MoneyKey route refuses none and the administrator token (401)", async () => {
    const t = await appWith(true);
    const created = await t.app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: { name: "inventory", total_budget: "1", daily_budget: "1", per_request_limit: "0.1", allowed_hosts: [] },
    });
    expect(created.statusCode).toBe(200);
    const moneyKey = created.json().key as string;

    for (const [method, route, who] of INVENTORY) {
      if (who === "public") continue;
      const url = route.replace(/:id/g, "00000000-0000-4000-8000-000000000000");
      const wrongCredentials = who === "admin" ? [undefined, `Bearer ${moneyKey}`] : [undefined, `Bearer ${t.adminToken}`];
      const expected = who === "admin" ? 403 : 401;
      for (const authorization of wrongCredentials) {
        const res = await t.app.inject({ method: method as "GET" | "POST", url, headers: authorization ? { authorization } : {} });
        expect(res.statusCode, `${method} ${route} with ${authorization ? authorization.slice(0, 14) + "..." : "no credentials"}`).toBe(expected);
      }
    }
  });

  it("the public GET routes answer without credentials", async () => {
    const t = await appWith(true);
    for (const [method, route, who] of INVENTORY) {
      if (who !== "public" || method !== "GET") continue;
      expect((await t.app.inject({ method: "GET", url: route })).statusCode, route).toBe(200);
    }
  });

  it("the routes removed in v0.7 answer a JSON 404, even for the administrator", async () => {
    const t = await appWith(true);
    for (const [method, route] of REMOVED) {
      const res = await t.app.inject({ method: method as "GET" | "POST" | "PUT", url: route, headers: { authorization: `Bearer ${t.adminToken}` }, ...(method === "GET" ? {} : { payload: {} }) });
      expect(res.statusCode, `${method} ${route}`).toBe(404);
      expect(res.headers["content-type"], `${method} ${route}`).toMatch(/application\/json/);
    }
    expect(REMOVED.map(([method, route]) => `${method} ${route}`).filter((r) => listed(true).includes(r))).toEqual([]);
  });
});
