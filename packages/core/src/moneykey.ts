import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(byteLength: number): string {
  const bytes = randomBytes(byteLength);
  let out = "";
  for (const b of bytes) {
    out += BASE62[b % BASE62.length];
  }
  return out;
}

export const MONEY_KEY_PREFIX = "mk_live_";
export const ADMIN_TOKEN_PREFIX = "ms_admin_";

/** Generates a new MoneyKey: `mk_live_` + 32 bytes of base62 randomness. */
export function generateMoneyKey(): string {
  return MONEY_KEY_PREFIX + randomBase62(32);
}

/** Generates a new admin token: `ms_admin_` + 32 bytes of base62 randomness. */
export function generateAdminToken(): string {
  return ADMIN_TOKEN_PREFIX + randomBase62(32);
}

/** SHA-256 hash of a secret, hex-encoded, for at-rest storage. */
export function sha256Hex(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** First 12 characters of a secret, safe to store/display for lookup. */
export function keyPrefix12(secret: string): string {
  return secret.slice(0, 12);
}

/** Constant-time comparison of a candidate secret against a stored sha256 hex hash. */
export function verifySecretAgainstHash(candidate: string, storedHashHex: string): boolean {
  const candidateHash = Buffer.from(sha256Hex(candidate), "hex");
  const storedHash = Buffer.from(storedHashHex, "hex");
  if (candidateHash.length !== storedHash.length) return false;
  return timingSafeEqual(candidateHash, storedHash);
}
