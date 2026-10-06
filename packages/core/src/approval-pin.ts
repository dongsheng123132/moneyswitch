import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import { assertChainUsable, getKeyChain } from "./chain.js";
import { rowToMoneyKey } from "./keyrow.js";
import type { MoneyKeyRow } from "./types.js";
import { isWeakApprovalPin } from "./weak-pin.js";

export { isWeakApprovalPin };

/**
 * v0.7.4 (SPEC.md §3): the approval PIN. Every root key can have a 4-6 digit PIN for the person who holds the key (the AI holds the
 * same key, so the key itself can never approve). The administrator sets it (issuing the key, or later: it is never changed by a reset of
 * the key's secret); the person types it on the approval link to approve or deny a request of that key or of any child key (a child key
 * has no PIN of its own). It is stored as a salted scrypt hash. A PIN that is too easy to guess is refused when it is set (isWeakApprovalPin).
 * Wrong PINs are counted CUMULATIVELY since the PIN was last set: a right PIN does not reset the count, only the administrator setting a PIN
 * does (otherwise the AI could keep guessing right after each approval). APPROVAL_PIN_MAX_FAILURES wrong ones lock it: from then on every
 * PIN is refused, the right one too, until the administrator sets a new one.
 */

export const APPROVAL_PIN_MAX_FAILURES = 5;

const PIN_RE = /^[0-9]{4,6}$/;
const SCRYPT_KEYLEN = 32;

export type ApprovalPinErrorCode = "APPROVAL_PIN_INVALID" | "APPROVAL_PIN_WEAK" | "APPROVAL_PIN_CHILD_KEY";

/** Why a PIN could not be set. Nothing was changed. */
export class ApprovalPinError extends Error {
  code: ApprovalPinErrorCode;
  constructor(code: ApprovalPinErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ApprovalPinError";
  }
}

/** 4 to 6 ASCII digits, as a string (a number would lose a leading zero). */
export function isValidApprovalPin(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_RE.test(pin);
}

/**
 * The PIN to store: `requested` when it is a valid one that is not too easy to guess, a random 4-digit one (never a weak one: drawn again)
 * when it was left out (undefined / null), else ApprovalPinError (APPROVAL_PIN_INVALID, or APPROVAL_PIN_WEAK).
 */
export function resolveApprovalPin(requested: unknown): string {
  if (requested === undefined || requested === null) {
    for (;;) {
      const pin = randomInt(0, 10_000).toString().padStart(4, "0");
      if (!isWeakApprovalPin(pin)) return pin;
    }
  }
  if (!isValidApprovalPin(requested)) throw new ApprovalPinError("APPROVAL_PIN_INVALID", "approval_pin must be 4 to 6 digits");
  if (isWeakApprovalPin(requested)) {
    throw new ApprovalPinError("APPROVAL_PIN_WEAK", "That PIN is too easy to guess: pick another (not all the same digit, not a run like 1234 or 4321, not a common one like 2580)");
  }
  return requested;
}

/** `scrypt$<salt hex>$<hash hex>` with a fresh random salt. */
export function hashApprovalPin(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(pin, salt, SCRYPT_KEYLEN).toString("hex")}`;
}

/** Constant-time check of a candidate PIN against a stored hashApprovalPin value (false for anything that is not one). */
export function verifyApprovalPin(candidate: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== SCRYPT_KEYLEN) return false;
  return timingSafeEqual(scryptSync(candidate, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN), expected);
}

/**
 * Sets (or replaces) the PIN of ROOT key `id`: `requested` when valid, a random 4-digit one when it is undefined / null. The failure
 * counter goes back to 0, so this also unlocks. Returns the plaintext PIN (the caller shows it once) and the row, or undefined when
 * the id does not exist. A child key cannot have one (ApprovalPinError): it uses its root key's.
 */
export function setApprovalPin(db: MoneySwitchDb, id: string, requested?: unknown): { approvalPin: string; row: MoneyKeyRow } | undefined {
  const current = db.select().from(schema.moneyKeys).where(eq(schema.moneyKeys.id, id)).get();
  if (!current) return undefined;
  if (current.parentId != null) throw new ApprovalPinError("APPROVAL_PIN_CHILD_KEY", "a child key has no PIN of its own: it uses its root key's");
  const approvalPin = resolveApprovalPin(requested);
  db.update(schema.moneyKeys).set({ approvalPin: hashApprovalPin(approvalPin), approvalPinFailures: 0 }).where(eq(schema.moneyKeys.id, id)).run();
  const row = db.select().from(schema.moneyKeys).where(eq(schema.moneyKeys.id, id)).get();
  if (!row) throw new Error("failed to read back the key");
  return { approvalPin, row: rowToMoneyKey(row) };
}

/** none = no PIN (administrator only); set = usable; locked = APPROVAL_PIN_MAX_FAILURES wrong ones since it was last set. */
export type ApprovalPinState = "none" | "set" | "locked";

export function approvalPinState(row: Pick<MoneyKeyRow, "approvalPin" | "approvalPinFailures">): ApprovalPinState {
  if (row.approvalPin == null) return "none";
  return row.approvalPinFailures >= APPROVAL_PIN_MAX_FAILURES ? "locked" : "set";
}

/** The state of the PIN that governs `keyId` (its root key's) and how many wrong PINs it has had since it was last set. "none" and 0 when the chain cannot be read. */
export function approvalPinStatusOfKey(db: MoneySwitchDb, keyId: string): { state: ApprovalPinState; failures: number } {
  try {
    const chain = getKeyChain(db, keyId);
    const root = chain[chain.length - 1];
    return { state: approvalPinState(root), failures: root.approvalPinFailures };
  } catch {
    return { state: "none", failures: 0 };
  }
}

/** The state of the PIN that governs `keyId`: its root key's. "none" when the chain cannot be read. */
export function approvalPinStateOfKey(db: MoneySwitchDb, keyId: string): ApprovalPinState {
  return approvalPinStatusOfKey(db, keyId).state;
}

export type ApprovalPinRefusal = "KEY_NOT_ACTIVE" | "NOT_SET" | "LOCKED" | "WRONG";

export type ApprovalPinCheck =
  | { ok: true; rootKeyId: string }
  | {
      ok: false;
      reason: ApprovalPinRefusal;
      /** The root key whose PIN it is; null when the key chain could not be read. */
      rootKeyId: string | null;
      /** Wrong PINs this root key may still be given before it locks. */
      attemptsLeft: number;
      /** This very attempt was a wrong PIN and was counted (the one that fills the counter answers LOCKED). */
      counted: boolean;
    };

/**
 * Is `pin` the PIN that governs `keyId` (the key's root key's)? Refused unless the key and every ancestor are usable (revoked or expired:
 * KEY_NOT_ACTIVE), the root key has a PIN (NOT_SET) and it is not locked (LOCKED, however right the PIN is). A wrong PIN is counted, and the
 * count is cumulative since the PIN was last set: a right PIN leaves it as it is (only setApprovalPin resets it), and the
 * APPROVAL_PIN_MAX_FAILURES-th wrong one locks and answers LOCKED. The check and the increment (`SET approval_pin_failures =
 * approval_pin_failures + 1`, guarded by `< APPROVAL_PIN_MAX_FAILURES`) run in one BEGIN IMMEDIATE transaction, so neither concurrent
 * requests nor a second connection to the same database can each be given a try the count has not caught up with.
 */
export function checkApprovalPin(db: MoneySwitchDb, keyId: string, pin: string): ApprovalPinCheck {
  const refused = (reason: ApprovalPinRefusal, rootKeyId: string | null, attemptsLeft = 0, counted = false): ApprovalPinCheck => ({
    ok: false,
    reason,
    rootKeyId,
    attemptsLeft,
    counted,
  });
  return db.transaction(
    (tx) => {
      let chain: MoneyKeyRow[];
      try {
        chain = getKeyChain(db, keyId);
        assertChainUsable(chain);
      } catch {
        return refused("KEY_NOT_ACTIVE", null);
      }
      const root = chain[chain.length - 1];
      if (root.approvalPin == null) return refused("NOT_SET", root.id);
      if (root.approvalPinFailures >= APPROVAL_PIN_MAX_FAILURES) return refused("LOCKED", root.id);
      if (verifyApprovalPin(pin, root.approvalPin)) return { ok: true, rootKeyId: root.id };
      const counted =
        tx
          .update(schema.moneyKeys)
          .set({ approvalPinFailures: sql`${schema.moneyKeys.approvalPinFailures} + 1` })
          .where(and(eq(schema.moneyKeys.id, root.id), lt(schema.moneyKeys.approvalPinFailures, APPROVAL_PIN_MAX_FAILURES)))
          .run().changes > 0;
      const failures = tx.select({ n: schema.moneyKeys.approvalPinFailures }).from(schema.moneyKeys).where(eq(schema.moneyKeys.id, root.id)).get()?.n ?? APPROVAL_PIN_MAX_FAILURES;
      const attemptsLeft = Math.max(0, APPROVAL_PIN_MAX_FAILURES - failures);
      return refused(attemptsLeft > 0 ? "WRONG" : "LOCKED", root.id, attemptsLeft, counted);
    },
    { behavior: "immediate" }
  );
}
