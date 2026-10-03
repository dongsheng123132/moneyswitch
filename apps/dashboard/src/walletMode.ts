import type { WalletInfo } from "./api";

/**
 * True for a wallet recorded as auto-unlock: its keystore is encrypted with a random secret the server keeps, so NO PASSWORD
 * EXISTS for it. An older server that does not send the recorded mode is judged by what it calls the unlock mode.
 */
export function isAutoWallet(wallet: WalletInfo): boolean {
  const health = wallet.health;
  if (!health) return false;
  return health.protection === "auto" || (health.protection === undefined && health.unlock_mode === "auto");
}

/**
 * How a CLOSED wallet can be opened again: "password" (a human types it) or "auto" (only the server's own unlock secret
 * file, no password exists). false when the wallet is open.
 */
export function lockedKind(wallet: WalletInfo): false | "password" | "auto" {
  if (wallet.unlocked) return false;
  return isAutoWallet(wallet) ? "auto" : "password";
}
