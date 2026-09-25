import { MoneySwitchError } from "./types.js";
import type { MoneyKeyRow } from "./types.js";
import { paymentsInLastMinute } from "./ledger.js";
import type { MoneySwitchDb } from "@moneyswitch/db";

/** SPEC §6 step 1: rate limit check (max_payments_per_minute). */
export function checkRateLimit(db: MoneySwitchDb, key: MoneyKeyRow, now = new Date()): void {
  const count = paymentsInLastMinute(db, key.id, now);
  if (count >= key.maxPaymentsPerMinute) {
    throw new MoneySwitchError("RATE_LIMITED");
  }
}

/**
 * SPEC §6 step 1 + §2.6: URL must be http(s) and host:port must be in
 * allowed_hosts. Applies to ALL /v1/fetch requests including free ones.
 * An empty allowed_hosts list means "reject everything".
 */
export function checkHostAllowed(url: URL, key: MoneyKeyRow): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MoneySwitchError("HOST_NOT_ALLOWED", "URL must be http or https");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const hostPort = `${url.hostname}:${port}`;
  const allowed = key.allowedHosts.some(
    (h) => h.toLowerCase() === hostPort.toLowerCase() || h.toLowerCase() === url.hostname.toLowerCase()
  );
  if (!allowed) {
    throw new MoneySwitchError("HOST_NOT_ALLOWED");
  }
}
