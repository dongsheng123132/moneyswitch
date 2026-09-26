import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "@moneyswitch/db";
import { authenticateMoneyKey, getMoneyKeyById } from "../src/keys.js";
import { sha256Hex, keyPrefix12, generateMoneyKey } from "../src/moneykey.js";
import { usedToday } from "../src/ledger.js";
import {
  createTollbooth,
  updateTollbooth,
  listTollboothRoutes,
  getTollboothBySlug,
  recordEarning,
  queryEarnings,
  deleteTollbooth,
  TollboothError,
} from "../src/tollbooths.js";
import { assertNotSsrf } from "../src/ssrf.js";
import { freshDb } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "..", "..", "db", "migrations");
const ADDR = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

function base(extra: Record<string, unknown> = {}) {
  return { name: "Weather API", upstreamUrl: "http://127.0.0.1:8000/", payTo: ADDR, network: "eip155:10143", defaultPrice: 10_000n, ...extra };
}

describe("toll booth CRUD (SPEC-v0.5 §2)", () => {
  it("creates with a derived slug, checksummed pay_to, normalized upstream and rules", () => {
    const { db } = freshDb();
    const { tollbooth, routes } = createTollbooth(db, {
      ...base({ payTo: ADDR.toLowerCase() }),
      routes: [{ method: "post", pathPattern: "v1//chat/completions", price: 10_000n }, { pathPattern: "*", price: 0n }],
    });
    expect(tollbooth.slug).toBe("weather-api");
    expect(tollbooth.payTo).toBe(ADDR);
    expect(tollbooth.upstreamUrl).toBe("http://127.0.0.1:8000");
    expect(routes.map((r) => [r.method, r.pathPattern, r.price])).toEqual([
      ["POST", "/v1/chat/completions", 10_000n],
      ["ANY", "/*", 0n],
    ]);
    // second booth with the same name gets a unique slug
    expect(createTollbooth(db, base()).tollbooth.slug).toBe("weather-api-2");
  });

  it("rejects secrets as pay_to with INVALID_PAY_TO + reason", () => {
    const { db } = freshDb();
    for (const [payTo, reason] of [
      ["mk_live_abcdefghijkl", "LOOKS_LIKE_MONEYKEY"],
      ["ms_admin_abcdefghijkl", "LOOKS_LIKE_ADMIN_TOKEN"],
      ["0x" + "12".repeat(32), "LOOKS_LIKE_PRIVATE_KEY"],
      ["0x1234", "NOT_AN_ADDRESS"],
    ] as const) {
      try {
        createTollbooth(db, base({ payTo }));
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TollboothError);
        expect((e as TollboothError).code).toBe("INVALID_PAY_TO");
        expect((e as TollboothError).reason).toBe(reason);
        expect((e as TollboothError).message).not.toContain(payTo);
      }
    }
  });

  it("validates slug, upstream, prices and rules", () => {
    const { db } = freshDb();
    createTollbooth(db, base({ slug: "taken" }));
    expect(() => createTollbooth(db, base({ slug: "taken" }))).toThrow(/already used/);
    expect(() => createTollbooth(db, base({ slug: "Bad Slug!" }))).toThrow(TollboothError);
    expect(() => createTollbooth(db, base({ upstreamUrl: "ftp://x" }))).toThrow(TollboothError);
    expect(() => createTollbooth(db, base({ upstreamUrl: "http://user:pw@x" }))).toThrow(TollboothError);
    expect(() => createTollbooth(db, base({ defaultPrice: -1n }))).toThrow(TollboothError);
    expect(() => createTollbooth(db, base({ routes: [{ method: "FETCH", pathPattern: "/x", price: 1n }] }))).toThrow(TollboothError);
    expect(() => createTollbooth(db, base({ routes: [{ pathPattern: "/a/../b", price: 1n }] }))).toThrow(TollboothError);
  });

  it("update replaces rules atomically and keeps order; null default = refuse", () => {
    const { db } = freshDb();
    const { tollbooth } = createTollbooth(db, base({ routes: [{ pathPattern: "/a", price: 1n }] }));
    const { tollbooth: t2, routes } = updateTollbooth(db, tollbooth.id, {
      defaultPrice: null,
      routes: [
        { method: "GET", pathPattern: "/z", price: 2n },
        { method: "POST", pathPattern: "/y", price: 3n },
      ],
    });
    expect(t2.defaultPrice).toBeNull();
    expect(routes.map((r) => r.pathPattern)).toEqual(["/z", "/y"]);
    expect(listTollboothRoutes(db, tollbooth.id)).toHaveLength(2);
    // a bad rule leaves the old ones untouched
    expect(() => updateTollbooth(db, tollbooth.id, { routes: [{ pathPattern: "/ok", price: 1n }, { pathPattern: "/x?y", price: 1n }] })).toThrow();
    expect(listTollboothRoutes(db, tollbooth.id).map((r) => r.pathPattern)).toEqual(["/z", "/y"]);
  });

  it("earnings: settled sums only, grouped; history survives deleting the booth", () => {
    const { db } = freshDb();
    const { tollbooth, routes } = createTollbooth(db, base({ routes: [{ pathPattern: "/a", price: 5n }] }));
    const common = { tollbooth, method: "GET", path: "/a", network: "eip155:10143", payer: ADDR };
    recordEarning(db, { ...common, routeId: routes[0].id, amount: 5n, txHash: "0x1", status: "settled", upstreamStatus: 200 });
    recordEarning(db, { ...common, routeId: routes[0].id, amount: 5n, txHash: "0x2", status: "settled", upstreamStatus: 201 });
    recordEarning(db, { ...common, routeId: routes[0].id, amount: 5n, txHash: null, status: "failed", upstreamStatus: 500 });
    recordEarning(db, { ...common, routeId: null, amount: 7n, txHash: "0x3", status: "settled", upstreamStatus: 200 });
    const s = queryEarnings(db);
    expect(s.total).toBe(17n);
    expect(s.settledCount).toBe(3);
    expect(s.failedCount).toBe(1);
    expect(s.byTollbooth).toEqual([{ tollboothId: tollbooth.id, slug: "weather-api", name: "Weather API", total: 17n, count: 3 }]);
    expect(s.byRoute.find((r) => r.routeId === null)?.total).toBe(7n);
    expect(queryEarnings(db, { sinceIso: new Date(Date.now() + 60_000).toISOString() }).total).toBe(0n);
    deleteTollbooth(db, tollbooth.id);
    expect(getTollboothBySlug(db, "weather-api")).toBeUndefined();
    expect(queryEarnings(db).total).toBe(17n);
  });
});

describe("SSRF self-port rule with the toll booth exception", () => {
  const opts = { selfPort: 4020, allowedHosts: ["127.0.0.1:4020"] };
  it("self /t/… is allowed only when allowSelfTollbooth is set", () => {
    expect(() => assertNotSsrf(new URL("http://127.0.0.1:4020/t/weather/x"), opts)).toThrow(/own listening/);
    expect(() => assertNotSsrf(new URL("http://127.0.0.1:4020/t/weather/x"), { ...opts, allowSelfTollbooth: true })).not.toThrow();
  });
  it.each(["/v1/keys", "/t/../v1/keys", "/t", "/", "/tx/a", "/t%2Fx"])("self %s stays blocked even with the exception", (p) => {
    expect(() => assertNotSsrf(new URL(`http://127.0.0.1:4020${p}`), { ...opts, allowSelfTollbooth: true })).toThrow(/own listening/);
  });
  it("new self spellings are blocked", () => {
    for (const u of ["http://localhost.:4020/v1/keys", "http://[::ffff:127.0.0.1]:4020/v1/keys"]) {
      expect(() => assertNotSsrf(new URL(u), { selfPort: 4020, allowedHosts: [] })).toThrow(/own listening/);
    }
  });
});

describe("v0.5 migration 0003_v05_tollbooths on an existing v0.4 database", () => {
  it("adds the three tables without touching keys/payments", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-mig5-"));
    const file = path.join(dir, "v04.sqlite");
    const plaintext = generateMoneyKey();
    try {
      const old = new Database(file);
      old.pragma("journal_mode = WAL");
      old.exec(`CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
      for (const f of ["0000_init.sql", "0001_v02_channels.sql", "0002_v04_subkeys.sql"]) {
        old.exec(fs.readFileSync(path.join(migrationsDir, f), "utf-8"));
        old.prepare(`INSERT INTO __migrations (name, applied_at) VALUES (?, ?)`).run(f, new Date().toISOString());
      }
      const now = new Date().toISOString();
      old.prepare(
        `INSERT INTO money_keys (id, name, key_prefix, key_hash, enabled, total_budget, daily_budget, per_request_limit,
           approval_threshold, allowed_hosts, max_payments_per_minute, expires_at, created_at, last_used_at, allowed_models,
           parent_id, depth, can_delegate, created_by)
         VALUES ('k04', 'v04 key', ?, ?, 1, 10000000, 1000000, 500000, NULL, '["example.com:443"]', 10, NULL, ?, NULL, NULL,
           NULL, 0, 1, 'admin')`
      ).run(keyPrefix12(plaintext), sha256Hex(plaintext), now);
      old.prepare(
        `INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, tx_hash, error_code,
           approval_id, created_at, updated_at, kind)
         VALUES ('p1', 'k04', 'https://example.com/x', 'example.com:443', 'GET', 'eip155:10143', '0xa', '0xb', 25000,
           'settled', '0xmock', NULL, NULL, ?, ?, 'fetch')`
      ).run(now, now);
      old.close();

      const { db, sqlite } = openDb({ filePath: file });
      try {
        const applied = (sqlite.prepare(`SELECT name FROM __migrations ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
        expect(applied).toContain("0003_v05_tollbooths.sql");
        const tables = (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
        expect(tables).toEqual(expect.arrayContaining(["tollbooths", "tollbooth_routes", "earnings"]));
        expect(getMoneyKeyById(db, "k04")!.canDelegate).toBe(true);
        expect(authenticateMoneyKey(db, plaintext).id).toBe("k04");
        expect(usedToday(db, "k04")).toBe(25000n);
        expect(createTollbooth(db, base()).tollbooth.slug).toBe("weather-api");
      } finally {
        sqlite.close();
      }
      const again = openDb({ filePath: file });
      expect(getTollboothBySlug(again.db, "weather-api")).toBeTruthy();
      again.sqlite.close();
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks: harmless */
      }
    }
  });
});
