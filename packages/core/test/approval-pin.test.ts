import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openDb } from "@moneyswitch/db";
import { schema } from "@moneyswitch/db";
import { freshDb } from "./helpers.js";
import { createMoneyKey, revokeMoneyKey } from "../src/keys.js";
import { createChildKey } from "../src/delegation.js";
import { rotateMoneyKeySecret } from "../src/rotate.js";
import { parseUsdcToMicros } from "../src/money.js";
import {
  APPROVAL_PIN_MAX_FAILURES,
  ApprovalPinError,
  approvalPinState,
  approvalPinStateOfKey,
  approvalPinStatusOfKey,
  checkApprovalPin,
  hashApprovalPin,
  isValidApprovalPin,
  isWeakApprovalPin,
  resolveApprovalPin,
  setApprovalPin,
  verifyApprovalPin,
} from "../src/approval-pin.js";

type Db = ReturnType<typeof freshDb>["db"];

function mk(db: Db, over: Partial<Parameters<typeof createMoneyKey>[1]> = {}) {
  return createMoneyKey(db, {
    name: "codex",
    totalBudget: parseUsdcToMicros("10"),
    dailyBudget: parseUsdcToMicros("2"),
    perRequestLimit: parseUsdcToMicros("1"),
    allowedHosts: ["example.com:443"],
    canDelegate: true,
    ...over,
  });
}

const kid = (db: Db, parentId: string, name = "kid") =>
  createChildKey(db, parentId, { name, dailyBudget: parseUsdcToMicros("1"), totalBudget: parseUsdcToMicros("2"), perRequestLimit: parseUsdcToMicros("0.5"), canDelegate: true }, { maxDepth: 3 });

const stored = (db: Db, id: string) => db.select().from(schema.moneyKeys).where(eq(schema.moneyKeys.id, id)).get()!;

describe("the approval PIN: format", () => {
  it("is 4 to 6 ASCII digits, as a string", () => {
    for (const ok of ["0000", "8426", "12345", "123456", "0012"]) expect(isValidApprovalPin(ok), ok).toBe(true);
    for (const bad of ["", "123", "1234567", "12a4", "12 34", "１２３４", "-1234", "1234.5", 1234, null, undefined, {}, ["8426"]]) {
      expect(isValidApprovalPin(bad), String(bad)).toBe(false);
    }
  });

  it("resolveApprovalPin: a valid one is kept, none given is a random 4-digit one, anything else throws", () => {
    expect(resolveApprovalPin("567890")).toBe("567890");
    for (const none of [undefined, null]) expect(resolveApprovalPin(none)).toMatch(/^[0-9]{4}$/);
    const seen = new Set(Array.from({ length: 40 }, () => resolveApprovalPin(undefined)));
    expect(seen.size).toBeGreaterThan(1); // random, not a constant
    for (const bad of ["12", "abcd", "", 1234]) {
      expect(() => resolveApprovalPin(bad)).toThrowError(ApprovalPinError);
    }
  });

  it("is stored as scrypt$<salt>$<hash> with a fresh salt each time, never as the PIN, and verifies only the right one", () => {
    const a = hashApprovalPin("8426");
    const b = hashApprovalPin("8426");
    expect(a).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("8426");
    expect(verifyApprovalPin("8426", a)).toBe(true);
    expect(verifyApprovalPin("1235", a)).toBe(false);
    expect(verifyApprovalPin("8426", "garbage")).toBe(false);
    expect(verifyApprovalPin("8426", "scrypt$zz$00")).toBe(false);
  });
});

describe("PINs that are too easy to guess (SPEC.md §3)", () => {
  it("repeated digits, straight runs without wrap, and the common 4-digit PINs are weak", () => {
    const repeated = ["0000", "1111", "2222", "9999", "00000", "111111", "000000"];
    const runs = ["1234", "2345", "3456", "6789", "0123", "4321", "9876", "3210", "12345", "54321", "123456", "654321", "234567", "012345", "543210", "345678", "456789", "987654"];
    const common = ["1212", "1004", "2000", "6969", "1122", "2580", "1313", "1010", "0101", "5683", "0852", "2468", "1357"];
    for (const pin of [...repeated, ...runs, ...common]) expect(isWeakApprovalPin(pin), pin).toBe(true);
  });

  it("ordinary PINs are not weak, nor is a run that wraps or skips (not in the classes the spec names)", () => {
    for (const pin of ["4821", "7396", "9035", "0042", "5093", "8426", "1235", "1243", "2341", "13579", "246801", "739155", "620417", "123457", "112233", "1000", "9012", "7890"]) {
      expect(isWeakApprovalPin(pin), pin).toBe(false);
    }
  });

  it("every explicit weak PIN is refused with APPROVAL_PIN_WEAK, in resolveApprovalPin, createMoneyKey and setApprovalPin; nothing is created or changed", () => {
    const { db } = freshDb();
    for (const weak of ["1111", "000000", "1234", "4321", "654321", "2580", "1357"]) {
      expect(() => resolveApprovalPin(weak), weak).toThrowError(expect.objectContaining({ code: "APPROVAL_PIN_WEAK" }));
      expect(() => mk(db, { approvalPin: weak }), weak).toThrowError(expect.objectContaining({ code: "APPROVAL_PIN_WEAK" }));
    }
    expect(db.select().from(schema.moneyKeys).all()).toHaveLength(0);
    const { row, approvalPin } = mk(db);
    const before = stored(db, row.id).approvalPin;
    expect(() => setApprovalPin(db, row.id, "1234")).toThrowError(expect.objectContaining({ code: "APPROVAL_PIN_WEAK" }));
    expect(stored(db, row.id).approvalPin).toBe(before);
    expect(checkApprovalPin(db, row.id, approvalPin).ok).toBe(true);
    // a malformed PIN is still INVALID (the shape is judged first)
    expect(() => resolveApprovalPin("12")).toThrowError(expect.objectContaining({ code: "APPROVAL_PIN_INVALID" }));
  });

  it("the random 4-digit default is never weak (a weak draw is drawn again)", () => {
    for (let i = 0; i < 3000; i++) {
      const pin = resolveApprovalPin(undefined);
      expect(pin).toMatch(/^[0-9]{4}$/);
      expect(isWeakApprovalPin(pin), pin).toBe(false);
    }
  });

  it("of the 10 000 four-digit PINs only a few dozen are weak", () => {
    const weak = Array.from({ length: 10_000 }, (_, n) => String(n).padStart(4, "0")).filter(isWeakApprovalPin);
    expect(weak.length).toBeGreaterThan(30);
    expect(weak.length).toBeLessThan(60);
  });
});

describe("createMoneyKey and the PIN", () => {
  it("a root key gets a random 4-digit PIN when none is given, and the one asked for when it is valid; only the hash is stored", () => {
    const { db } = freshDb();
    const auto = mk(db);
    expect(auto.approvalPin).toMatch(/^[0-9]{4}$/);
    const picked = mk(db, { name: "picked", approvalPin: "246810" });
    expect(picked.approvalPin).toBe("246810");
    for (const created of [auto, picked]) {
      const row = stored(db, created.row.id);
      expect(row.approvalPin).toMatch(/^scrypt\$/);
      expect(row.approvalPin).not.toContain(created.approvalPin);
      expect(row.approvalPinFailures).toBe(0);
      expect(verifyApprovalPin(created.approvalPin, row.approvalPin!)).toBe(true);
    }
  });

  it("an invalid PIN refuses the key: nothing is created", () => {
    const { db } = freshDb();
    expect(() => mk(db, { approvalPin: "12" })).toThrowError(/4 to 6 digits/);
    expect(db.select().from(schema.moneyKeys).all()).toHaveLength(0);
  });

  it("a child key has no PIN, and createChildKey takes none", () => {
    const { db } = freshDb();
    const { row: root } = mk(db);
    const child = kid(db, root.id);
    expect(stored(db, child.row.id).approvalPin).toBeNull();
    expect(stored(db, child.row.id).approvalPinFailures).toBe(0);
    expect(approvalPinState(child.row)).toBe("none");
  });
});

describe("setApprovalPin", () => {
  it("replaces the PIN (the old one stops working), and a random one is made when none is given", () => {
    const { db } = freshDb();
    const { row, approvalPin: first } = mk(db, { approvalPin: "4821" });
    const set = setApprovalPin(db, row.id, "7396")!;
    expect(set.approvalPin).toBe("7396");
    expect(checkApprovalPin(db, row.id, first)).toMatchObject({ ok: false, reason: "WRONG" });
    expect(checkApprovalPin(db, row.id, "7396")).toEqual({ ok: true, rootKeyId: row.id });
    expect(setApprovalPin(db, row.id)!.approvalPin).toMatch(/^[0-9]{4}$/);
  });

  it("gives a key that had none (issued before v0.7.4) its first", () => {
    const { db } = freshDb();
    const { row } = mk(db);
    db.update(schema.moneyKeys).set({ approvalPin: null }).where(eq(schema.moneyKeys.id, row.id)).run(); // as the migration leaves an old key
    expect(approvalPinStateOfKey(db, row.id)).toBe("none");
    expect(checkApprovalPin(db, row.id, "8426")).toMatchObject({ ok: false, reason: "NOT_SET" });
    setApprovalPin(db, row.id, "8426");
    expect(approvalPinStateOfKey(db, row.id)).toBe("set");
    expect(checkApprovalPin(db, row.id, "8426").ok).toBe(true);
  });

  it("refuses an invalid PIN (nothing changes), an unknown key (undefined) and a child key", () => {
    const { db } = freshDb();
    const { row, approvalPin } = mk(db);
    expect(() => setApprovalPin(db, row.id, "abc")).toThrowError(ApprovalPinError);
    expect(checkApprovalPin(db, row.id, approvalPin).ok).toBe(true);
    expect(setApprovalPin(db, "no-such-key", "8426")).toBeUndefined();
    const child = kid(db, row.id);
    expect(() => setApprovalPin(db, child.row.id, "8426")).toThrowError(expect.objectContaining({ code: "APPROVAL_PIN_CHILD_KEY" }));
    expect(stored(db, child.row.id).approvalPin).toBeNull();
  });

  it("resetting the key's secret does not change the PIN", () => {
    const { db } = freshDb();
    const { row, approvalPin } = mk(db);
    const before = stored(db, row.id).approvalPin;
    rotateMoneyKeySecret(db, row.id);
    expect(stored(db, row.id).approvalPin).toBe(before);
    expect(checkApprovalPin(db, row.id, approvalPin).ok).toBe(true);
  });
});

describe("checkApprovalPin", () => {
  it("a wrong PIN counts, the fifth in a row locks (even the right PIN is then refused), and only setting a new PIN unlocks", () => {
    const { db } = freshDb();
    const { row, approvalPin } = mk(db, { approvalPin: "5093" });
    const left: number[] = [];
    for (let i = 1; i < APPROVAL_PIN_MAX_FAILURES; i++) {
      const res = checkApprovalPin(db, row.id, "0000");
      expect(res).toMatchObject({ ok: false, reason: "WRONG", counted: true });
      left.push((res as { attemptsLeft: number }).attemptsLeft);
    }
    expect(left).toEqual([4, 3, 2, 1]);
    expect(approvalPinStateOfKey(db, row.id)).toBe("set");
    expect(checkApprovalPin(db, row.id, "0000")).toMatchObject({ ok: false, reason: "LOCKED", counted: true, attemptsLeft: 0 });
    expect(stored(db, row.id).approvalPinFailures).toBe(APPROVAL_PIN_MAX_FAILURES);
    expect(approvalPinStateOfKey(db, row.id)).toBe("locked");

    // locked: the right PIN is refused too, and nothing is counted any more
    expect(checkApprovalPin(db, row.id, approvalPin)).toMatchObject({ ok: false, reason: "LOCKED", counted: false });
    expect(stored(db, row.id).approvalPinFailures).toBe(APPROVAL_PIN_MAX_FAILURES);

    setApprovalPin(db, row.id, approvalPin); // even the same PIN again: the administrator's act unlocks
    expect(stored(db, row.id).approvalPinFailures).toBe(0);
    expect(checkApprovalPin(db, row.id, approvalPin).ok).toBe(true);
  });

  it("the count is cumulative since the PIN was set: a right PIN does NOT reset it, so four wrong, one right, one wrong locks", () => {
    const { db } = freshDb();
    const { row } = mk(db, { approvalPin: "5093" });
    for (let i = 0; i < APPROVAL_PIN_MAX_FAILURES - 1; i++) expect(checkApprovalPin(db, row.id, "9999")).toMatchObject({ ok: false, reason: "WRONG" });
    expect(checkApprovalPin(db, row.id, "5093")).toEqual({ ok: true, rootKeyId: row.id });
    expect(stored(db, row.id).approvalPinFailures).toBe(APPROVAL_PIN_MAX_FAILURES - 1); // a success leaves the count as it was
    expect(approvalPinStatusOfKey(db, row.id)).toEqual({ state: "set", failures: APPROVAL_PIN_MAX_FAILURES - 1 });
    expect(checkApprovalPin(db, row.id, "9999")).toMatchObject({ ok: false, reason: "LOCKED", counted: true, attemptsLeft: 0 });
    expect(approvalPinStatusOfKey(db, row.id)).toEqual({ state: "locked", failures: APPROVAL_PIN_MAX_FAILURES });
    expect(checkApprovalPin(db, row.id, "5093")).toMatchObject({ ok: false, reason: "LOCKED", counted: false });
  });

  it("many right PINs between wrong ones change nothing: five wrong tries over any number of approvals lock, however they are interleaved", () => {
    const { db } = freshDb();
    const { row } = mk(db, { approvalPin: "5093" });
    for (let i = 0; i < APPROVAL_PIN_MAX_FAILURES - 1; i++) {
      expect(checkApprovalPin(db, row.id, "5093").ok).toBe(true);
      expect(checkApprovalPin(db, row.id, "9999")).toMatchObject({ ok: false, reason: "WRONG", attemptsLeft: APPROVAL_PIN_MAX_FAILURES - 1 - i });
      expect(checkApprovalPin(db, row.id, "5093").ok).toBe(true);
    }
    expect(stored(db, row.id).approvalPinFailures).toBe(APPROVAL_PIN_MAX_FAILURES - 1);
    expect(checkApprovalPin(db, row.id, "9999")).toMatchObject({ ok: false, reason: "LOCKED" });
    expect(checkApprovalPin(db, row.id, "5093")).toMatchObject({ ok: false, reason: "LOCKED" });
  });

  it("only the administrator setting a PIN resets the count (the same PIN again included)", () => {
    const { db } = freshDb();
    const { row } = mk(db, { approvalPin: "5093" });
    for (let i = 0; i < 3; i++) checkApprovalPin(db, row.id, "9999");
    expect(checkApprovalPin(db, row.id, "5093").ok).toBe(true);
    expect(stored(db, row.id).approvalPinFailures).toBe(3);
    setApprovalPin(db, row.id, "5093");
    expect(stored(db, row.id).approvalPinFailures).toBe(0);
    expect(approvalPinStatusOfKey(db, row.id)).toEqual({ state: "set", failures: 0 });
  });

  it("the increment is one relative SQL update inside one BEGIN IMMEDIATE transaction: two connections to the same database share one count", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-pin-conn-"));
    const file = path.join(dir, "pin.sqlite");
    const a = openDb({ filePath: file });
    const b = openDb({ filePath: file });
    try {
      const { row } = mk(a.db, { approvalPin: "5093" });
      expect(checkApprovalPin(a.db, row.id, "9999")).toMatchObject({ reason: "WRONG", attemptsLeft: 4 });
      expect(checkApprovalPin(b.db, row.id, "9999")).toMatchObject({ reason: "WRONG", attemptsLeft: 3 });
      expect(checkApprovalPin(a.db, row.id, "5093").ok).toBe(true);
      expect(checkApprovalPin(b.db, row.id, "5093").ok).toBe(true);
      expect(checkApprovalPin(a.db, row.id, "9999")).toMatchObject({ reason: "WRONG", attemptsLeft: 2 });
      expect(checkApprovalPin(b.db, row.id, "9999")).toMatchObject({ reason: "WRONG", attemptsLeft: 1 });
      expect(checkApprovalPin(a.db, row.id, "9999")).toMatchObject({ reason: "LOCKED", counted: true });
      expect(checkApprovalPin(b.db, row.id, "5093")).toMatchObject({ ok: false, reason: "LOCKED", counted: false });
      expect(a.sqlite.prepare("SELECT approval_pin_failures AS n FROM money_keys").get()).toEqual({ n: APPROVAL_PIN_MAX_FAILURES });
    } finally {
      a.sqlite.close();
      b.sqlite.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // WAL files may be briefly locked on Windows
      }
    }
  });

  it("the check holds the write lock while it counts: it is a BEGIN IMMEDIATE transaction (a second connection cannot write in between)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-pin-lock-"));
    const a = openDb({ filePath: path.join(dir, "pin.sqlite") });
    try {
      const { row } = mk(a.db, { approvalPin: "5093" });
      const seen: boolean[] = [];
      const real = a.sqlite.prepare.bind(a.sqlite);
      // every statement the check runs sees an open transaction on the connection
      (a.sqlite as unknown as { prepare: typeof a.sqlite.prepare }).prepare = ((sqlText: string) => {
        const stmt = real(sqlText);
        if (/approval_pin_failures/.test(sqlText)) seen.push(a.sqlite.inTransaction);
        return stmt;
      }) as typeof a.sqlite.prepare;
      checkApprovalPin(a.db, row.id, "9999");
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(Boolean)).toBe(true);
    } finally {
      a.sqlite.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // WAL files may be briefly locked on Windows
      }
    }
  });

  it("a child key's request is decided with its ROOT key's PIN (at any depth), and the failures count on the root", () => {
    const { db } = freshDb();
    const { row: root, approvalPin } = mk(db);
    const child = kid(db, root.id);
    const grand = kid(db, child.row.id, "grand");
    expect(checkApprovalPin(db, child.row.id, approvalPin)).toEqual({ ok: true, rootKeyId: root.id });
    expect(checkApprovalPin(db, grand.row.id, approvalPin)).toEqual({ ok: true, rootKeyId: root.id });
    expect(checkApprovalPin(db, grand.row.id, "0000")).toMatchObject({ ok: false, reason: "WRONG", rootKeyId: root.id });
    expect(stored(db, root.id).approvalPinFailures).toBe(1);
    expect(stored(db, child.row.id).approvalPinFailures).toBe(0);
    expect(approvalPinStateOfKey(db, grand.row.id)).toBe("set");
  });

  it("another root key's PIN does not work, even when it is the same digits it would be in the other's own", () => {
    const { db } = freshDb();
    const a = mk(db, { name: "a", approvalPin: "4821" });
    const b = mk(db, { name: "b", approvalPin: "7396" });
    expect(checkApprovalPin(db, a.row.id, "7396")).toMatchObject({ ok: false, reason: "WRONG", rootKeyId: a.row.id });
    expect(checkApprovalPin(db, b.row.id, "4821")).toMatchObject({ ok: false, reason: "WRONG", rootKeyId: b.row.id });
    expect(stored(db, a.row.id).approvalPinFailures).toBe(1);
    expect(stored(db, b.row.id).approvalPinFailures).toBe(1);
  });

  it("a revoked or expired key (or a revoked parent) refuses the PIN, and the refusal costs no try", () => {
    const { db } = freshDb();
    const revoked = mk(db, { name: "revoked" });
    const child = kid(db, revoked.row.id);
    revokeMoneyKey(db, revoked.row.id);
    for (const id of [revoked.row.id, child.row.id]) {
      expect(checkApprovalPin(db, id, revoked.approvalPin)).toMatchObject({ ok: false, reason: "KEY_NOT_ACTIVE", counted: false });
    }
    const expired = mk(db, { name: "expired", expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(checkApprovalPin(db, expired.row.id, expired.approvalPin)).toMatchObject({ ok: false, reason: "KEY_NOT_ACTIVE" });
    expect(stored(db, revoked.row.id).approvalPinFailures).toBe(0);
  });

  it("an unknown key id is refused", () => {
    const { db } = freshDb();
    expect(checkApprovalPin(db, "nope", "8426")).toMatchObject({ ok: false, reason: "KEY_NOT_ACTIVE", rootKeyId: null });
  });
});
