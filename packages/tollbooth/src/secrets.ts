import { getAddress } from "viem";

/**
 * SPEC-v0.5 §1 — "three things" guard rails, shared by the server, the
 * Dashboard (browser) and `moneyswitch sell`. Browser-safe: no node imports.
 *
 *   private key  — never shown, never typed anywhere
 *   MoneyKey     — mk_live_…, secret, only for YOUR OWN AI
 *   pay-to       — 0x… address, public, give it to anyone
 *
 * The two helpers below catch the dangerous mix-ups: pasting a secret where a
 * public address is expected (it would end up printed on every 402 response),
 * and pasting an address where a key is expected.
 */

export type SecretShape = "money_key" | "admin_token" | "setup_token" | "private_key" | "mnemonic";

const MONEY_KEY_RE = /mk_live_/i;
const ADMIN_TOKEN_RE = /ms_admin_/i;
const SETUP_TOKEN_RE = /ms_setup_/i;
// 32 bytes of hex, with or without 0x — the shape of an EVM private key.
const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Returns what kind of secret `input` looks like, or null if it doesn't look secret. */
export function detectSecretShape(input: string): SecretShape | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  if (MONEY_KEY_RE.test(s)) return "money_key";
  if (ADMIN_TOKEN_RE.test(s)) return "admin_token";
  if (SETUP_TOKEN_RE.test(s)) return "setup_token";
  if (PRIVATE_KEY_RE.test(s)) return "private_key";
  // A BIP-39 recovery phrase: 12/15/18/21/24 lowercase words.
  const words = s.split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    return "mnemonic";
  }
  return null;
}

export type PayToErrorCode =
  | "LOOKS_LIKE_MONEYKEY"
  | "LOOKS_LIKE_ADMIN_TOKEN"
  | "LOOKS_LIKE_PRIVATE_KEY"
  | "LOOKS_LIKE_MNEMONIC"
  | "EMPTY"
  | "NOT_AN_ADDRESS"
  | "BAD_CHECKSUM"
  | "ZERO_ADDRESS";

export type PayToCheck =
  | { ok: true; address: `0x${string}` }
  | { ok: false; code: PayToErrorCode; message: string };

const PAY_TO_MESSAGES: Record<PayToErrorCode, string> = {
  LOOKS_LIKE_MONEYKEY:
    "That is a MoneyKey (mk_live_…), not a receiving address. A MoneyKey is a secret that lets anyone holding it spend your money — never give it to sellers or put it here. Use a public 0x… address.",
  LOOKS_LIKE_ADMIN_TOKEN:
    "That is the MoneySwitch admin token (ms_admin_…), a secret. Never paste it here — the receiving address is shown publicly to every buyer.",
  LOOKS_LIKE_PRIVATE_KEY:
    "That looks like a private key (64 hex characters). Never paste a private key anywhere — whoever sees it owns the wallet. The receiving address is the shorter public 0x… address (40 hex characters).",
  LOOKS_LIKE_MNEMONIC:
    "That looks like a wallet recovery phrase. Never paste it anywhere — whoever sees it owns the wallet. Use the public 0x… address instead.",
  EMPTY: "Enter a receiving address (0x followed by 40 hex characters).",
  NOT_AN_ADDRESS: "Not a valid EVM address. It must be 0x followed by 40 hex characters.",
  BAD_CHECKSUM:
    "The upper/lower-case letters of this address don't match its checksum — it was probably mistyped. Copy it again from your wallet.",
  ZERO_ADDRESS: "The zero address burns funds. Use a real receiving address.",
};

/**
 * Validates a receiving ("pay-to") address. Accepts an EIP-55 checksummed
 * address, or an all-lower/all-upper-case one (no checksum information); a
 * mixed-case address must match its checksum. Returns the checksummed form.
 */
export function checkPayTo(input: string): PayToCheck {
  const s = (input ?? "").trim();
  const fail = (code: PayToErrorCode): PayToCheck => ({ ok: false, code, message: PAY_TO_MESSAGES[code] });
  if (!s) return fail("EMPTY");
  const secret = detectSecretShape(s);
  if (secret === "money_key") return fail("LOOKS_LIKE_MONEYKEY");
  if (secret === "admin_token" || secret === "setup_token") return fail("LOOKS_LIKE_ADMIN_TOKEN");
  if (secret === "private_key") return fail("LOOKS_LIKE_PRIVATE_KEY");
  if (secret === "mnemonic") return fail("LOOKS_LIKE_MNEMONIC");
  if (!ADDRESS_RE.test(s)) return fail("NOT_AN_ADDRESS");
  const hex = s.slice(2);
  const checksummed = getAddress(`0x${hex.toLowerCase()}`);
  const isUniformCase = hex === hex.toLowerCase() || hex === hex.toUpperCase();
  if (!isUniformCase && checksummed !== s) return fail("BAD_CHECKSUM");
  if (/^0x0{40}$/.test(checksummed)) return fail("ZERO_ADDRESS");
  return { ok: true, address: checksummed };
}

export function payToErrorMessage(code: PayToErrorCode): string {
  return PAY_TO_MESSAGES[code];
}

/** True when `input` looks like a public 0x address (what a key field must NOT receive). */
export function looksLikeAddress(input: string): boolean {
  return ADDRESS_RE.test((input ?? "").trim());
}

export type KeyInputProblem = "LOOKS_LIKE_ADDRESS" | "LOOKS_LIKE_PRIVATE_KEY" | "LOOKS_LIKE_MNEMONIC";

/**
 * Guard for MoneyKey / admin-token input fields: a pasted 0x address (the
 * public thing) or a raw private key / recovery phrase (a far worse secret
 * that MoneySwitch never asks for) is rejected with an explanation.
 */
export function checkKeyInput(input: string): KeyInputProblem | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  if (looksLikeAddress(s)) return "LOOKS_LIKE_ADDRESS";
  const shape = detectSecretShape(s);
  if (shape === "private_key") return "LOOKS_LIKE_PRIVATE_KEY";
  if (shape === "mnemonic") return "LOOKS_LIKE_MNEMONIC";
  return null;
}
