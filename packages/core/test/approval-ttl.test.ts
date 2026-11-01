import { describe, it, expect, vi, afterEach } from "vitest";
import { schema } from "@moneyswitch/db";
import { eq } from "drizzle-orm";
import { freshDb } from "./helpers.js";
import { createMoneyKey } from "../src/keys.js";
import { APPROVAL_TTL_MS, createApproval, decideApproval, expireStaleApprovals, getApproval, validateApprovalForUse } from "../src/approval.js";

const start = new Date("2026-10-13T00:00:00Z");
afterEach(() => vi.useRealTimers());
function setup(kind: "payment" | "host" = "payment") {
  vi.useFakeTimers(); vi.setSystemTime(start);
  const { db } = freshDb();
  const key = createMoneyKey(db, { name: "ttl", totalBudget: 1_000_000n, dailyBudget: 100_000n, perRequestLimit: 20_000n, allowedHosts: ["seller.example:443"] }).row;
  const ctx = { keyId: key.id, url: "https://seller.example/data", method: "GET", body: undefined, network: "eip155:8453", asset: "0xasset", payTo: "0xrecipient", amount: 10_000n };
  const approval = createApproval(db, { ...ctx, kind });
  return { db, ctx, approval };
}
describe("30 minute approval lifetime", () => {
  it("new host and payment approvals both receive 30 minutes", () => {
    expect(APPROVAL_TTL_MS).toBe(30 * 60_000);
    for (const kind of ["payment", "host"] as const) {
      const { approval } = setup(kind);
      expect(new Date(approval.expiresAt).getTime() - start.getTime()).toBe(30 * 60_000);
    }
  });
  it("approval at 15 minutes does not reset the deadline; use expires after 30 minutes", () => {
    const { db, ctx, approval } = setup();
    vi.setSystemTime(start.getTime() + 15 * 60_000);
    expireStaleApprovals(db); expect(getApproval(db, approval.id)?.status).toBe("pending");
    expect(decideApproval(db, approval.id, "approved").expiresAt).toBe(approval.expiresAt);
    vi.setSystemTime(start.getTime() + 29 * 60_000);
    expect(validateApprovalForUse(db, approval.id, ctx).id).toBe(approval.id);
    vi.setSystemTime(start.getTime() + 30 * 60_000 + 1);
    expect(() => validateApprovalForUse(db, approval.id, ctx)).toThrow("APPROVAL_INVALID");
  });
  it("existing 10 minute deadlines stay expired", () => {
    const { db, approval } = setup();
    const oldDeadline = new Date(start.getTime() + 10 * 60_000).toISOString();
    db.update(schema.approvals).set({ expiresAt: oldDeadline }).where(eq(schema.approvals.id, approval.id)).run();
    vi.setSystemTime(start.getTime() + 10 * 60_000 + 1); expireStaleApprovals(db);
    expect(getApproval(db, approval.id)).toMatchObject({ status: "expired", expiresAt: oldDeadline });
  });
});
