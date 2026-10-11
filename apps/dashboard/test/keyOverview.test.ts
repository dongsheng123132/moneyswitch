import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MoneyKeyRow } from "../src/api";
import { keyOverview, visibleKeys } from "../src/keyOverview";

const key = (id: string, patch: Partial<MoneyKeyRow> = {}): MoneyKeyRow => ({
  id, name: `Agent ${id}`, key_prefix: `mk_${id}`, enabled: true,
  total_budget: "5", daily_budget: "0.5", per_request_limit: "0.2", approval_threshold: "0.1",
  allowed_hosts: [], max_payments_per_minute: 10, expires_at: null,
  created_at: "2026-10-11T05:00:00.000Z", last_used_at: null,
  used_today: "0", used_total: "0", own_used_today: "0", own_used_total: "0",
  parent_id: null, depth: 0, can_delegate: false, created_by: "admin", children_count: 0,
  status: "active", network_mode: "testnet", networks: [], ...patch,
});

describe("Key overview from existing list data", () => {
  it("uses authoritative status and keeps unclassified legacy keys out of mainnet/testnet counts", () => {
    const keys = [key("main", { network_mode: "mainnet" }), key("test"), key("legacy", { network_mode: null }),
      key("expired", { status: "expired" }), key("parent-disabled", { status: "ancestor_revoked", enabled: true })];
    assert.deepEqual(keyOverview(keys), { total: 5, active: 3, inactive: 2, legacy: 1, mainnet: 1, testnet: 1 });
    assert.deepEqual(visibleKeys(keys, "", "active", "all").map(k => k.id).sort(), ["legacy", "main", "test"]);
    assert.deepEqual(visibleKeys(keys, "", "inactive", "all").map(k => k.id).sort(), ["expired", "parent-disabled"]);
  });

  it("combines search, state and explicit network filters and orders new keys first without changing input", () => {
    const keys = [key("older", { name: "研究 Agent", created_at: "2026-10-10T05:00:00.000Z" }),
      key("latest", { name: "研究 Agent · Sol" }), key("main", { name: "研究 Agent", network_mode: "mainnet" }),
      key("revoked", { name: "研究 Agent", status: "revoked" })];
    assert.deepEqual(visibleKeys(keys, " 研究 ", "active", "testnet").map(k => k.id), ["latest", "older"]);
    assert.deepEqual(visibleKeys(keys, "MK_LATEST", "all", "all").map(k => k.id), ["latest"]);
    assert.deepEqual(visibleKeys(keys, "no match", "all", "all"), []);
    assert.deepEqual(keys.map(k => k.id), ["older", "latest", "main", "revoked"]);
  });
});
