// A stand-in for the parts of the MoneySwitch server the desktop console
// talks to, following SPEC-v0.4 §A and the wire shapes of
// apps/server/src/routes/children.ts + agent.ts (/v1/status):
//   GET  /v1/status
//   POST /v1/keys/children   (400 CHILD_EXCEEDS_PARENT + field/parent_value)
//   GET  /v1/keys/children
//   POST /v1/keys/children/:id/revoke
//   HEAD /dl/moneyswitch.tgz (404: forces the in-repo MCP path)
// Used by unit tests and, when the real server is unavailable, the
// Playwright walkthrough. Amounts are decimal strings, like the server.
import http from "node:http";
import crypto from "node:crypto";

const micros = (s) => {
  const [w, f = ""] = String(s).split(".");
  return BigInt(w) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
};
const fmt = (m) => {
  const w = m / 1_000_000n;
  const f = (m % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${w}.${f.padEnd(2, "0")}`;
};

export function createMockMoneyServer(opts = {}) {
  const keys = new Map(); // key -> record
  const byId = new Map();
  const requests = [];
  function addKey(rec) {
    keys.set(rec.key, rec);
    byId.set(rec.id, rec);
    return rec;
  }
  const root = addKey({
    id: "key_root",
    key: opts.rootKey ?? "mk_live_employeeROOT0000000000000000",
    name: opts.rootName ?? "alice (employee)",
    parentId: null,
    depth: 0,
    canDelegate: opts.canDelegate ?? true,
    daily: micros(opts.daily ?? "10.00"),
    total: micros(opts.total ?? "100.00"),
    per: micros(opts.per ?? "1.00"),
    usedToday: micros(opts.usedToday ?? "0"),
    revoked: false,
  });

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      requests.push({ method: req.method, url: req.url, keyPrefix: auth.slice(0, 12) });
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/dl/moneyswitch.tgz") return send(404, {});
      const me = keys.get(auth);
      if (!me) return send(401, { error: "INVALID_KEY", code: "INVALID_KEY", message: "Invalid MoneyKey" });
      if (me.revoked) return send(401, { error: "KEY_REVOKED", code: "KEY_REVOKED", message: "MoneyKey has been revoked" });
      const view = (k) => ({
        id: k.id,
        name: k.name,
        key_prefix: k.key.slice(0, 12),
        status: k.revoked ? "revoked" : "active",
        daily_budget: fmt(k.daily),
        total_budget: fmt(k.total),
        per_request_limit: fmt(k.per),
        used_today: fmt(k.usedToday),
        used_total: fmt(k.usedToday),
        parent_id: k.parentId,
        depth: k.depth,
        can_delegate: k.canDelegate,
      });
      if (req.method === "GET" && req.url === "/v1/status") {
        return send(200, {
          remaining_today: fmt(me.daily - me.usedToday),
          remaining_total: fmt(me.total - me.usedToday),
          per_request_limit: fmt(me.per),
          currency: "USDC",
          network: "eip155:10143",
          key_name: me.name,
          key_prefix: me.key.slice(0, 12),
          daily_budget: fmt(me.daily),
          total_budget: fmt(me.total),
          used_today: fmt(me.usedToday),
          used_total: fmt(me.usedToday),
          depth: me.depth,
          max_depth: 3,
          can_delegate: me.canDelegate,
          can_create_children: me.canDelegate && me.depth < 3,
          is_child: me.parentId != null,
        });
      }
      if (req.method === "POST" && req.url === "/v1/keys/children") {
        let b;
        try {
          b = JSON.parse(body || "{}");
        } catch {
          return send(400, { error: "INVALID_REQUEST", code: "INVALID_REQUEST", message: "bad json" });
        }
        if (!me.canDelegate) return send(403, { error: "DELEGATION_NOT_ALLOWED", code: "DELEGATION_NOT_ALLOWED", message: "this key may not create child keys" });
        for (const [field, mine] of [
          ["daily_budget", me.daily],
          ["total_budget", me.total],
          ["per_request_limit", me.per],
        ]) {
          if (b[field] === undefined) return send(400, { error: "INVALID_REQUEST", code: "INVALID_REQUEST", message: `${field} is required`, field });
          if (micros(b[field]) > mine) {
            return send(400, { error: "CHILD_EXCEEDS_PARENT", code: "CHILD_EXCEEDS_PARENT", message: `${field} exceeds the parent's`, field, parent_value: fmt(mine) });
          }
        }
        const child = addKey({
          id: `key_${crypto.randomBytes(4).toString("hex")}`,
          key: `mk_live_${crypto.randomBytes(16).toString("hex")}`,
          name: String(b.name ?? "child"),
          parentId: me.id,
          depth: me.depth + 1,
          canDelegate: b.can_delegate === true,
          daily: micros(b.daily_budget),
          total: micros(b.total_budget),
          per: micros(b.per_request_limit),
          usedToday: 0n,
          revoked: false,
        });
        return send(200, { ...view(child), key: child.key });
      }
      if (req.method === "GET" && req.url === "/v1/keys/children") {
        return send(200, { children: [...byId.values()].filter((k) => k.parentId === me.id).map(view) });
      }
      const m = /^\/v1\/keys\/children\/([^/]+)\/revoke$/.exec(req.url ?? "");
      if (req.method === "POST" && m) {
        const k = byId.get(decodeURIComponent(m[1]));
        if (!k || k.parentId !== me.id) return send(404, { error: "NOT_FOUND", code: "NOT_FOUND", message: "No such key in your subtree" });
        k.revoked = true;
        return send(200, { id: k.id, revoked: true });
      }
      return send(404, { error: "NOT_FOUND" });
    });
  });
  return {
    server,
    root,
    requests,
    byId,
    /** Pretend an agent spent money with a child key. */
    spend(id, amount) {
      const k = byId.get(id);
      k.usedToday += micros(amount);
      if (k.parentId) byId.get(k.parentId).usedToday += micros(amount);
    },
    listen(port = 0) {
      return new Promise((r) => server.listen(port, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
    },
    close() {
      return new Promise((r) => server.close(() => r()));
    },
  };
}

// `node mock-money-server.mjs <port>`: run standalone (Playwright walkthrough).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const port = Number(process.argv[2] ?? 0);
  const m = createMockMoneyServer({ daily: process.env.MOCK_DAILY ?? "10.00", total: process.env.MOCK_TOTAL ?? "100.00", per: process.env.MOCK_PER ?? "1.00" });
  const url = await m.listen(port);
  process.stdout.write(JSON.stringify({ url, rootKey: m.root.key }) + "\n");
}
