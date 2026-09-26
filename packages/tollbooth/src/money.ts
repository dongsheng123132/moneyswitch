/**
 * Integer micro-USDC helpers (6 decimals). Same semantics as
 * @moneyswitch/core's money.ts, kept here so this Apache-2.0 package (used by
 * the `moneyswitch sell` CLI) has no dependency on the AGPL server packages.
 */
export const MICROS = 1_000_000n;

export function parseUsdc(input: string): bigint {
  const trimmed = String(input ?? "").trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new Error(`INVALID_AMOUNT: "${input}" is not a valid USDC amount (e.g. 0.01)`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  return BigInt(whole) * MICROS + BigInt((frac + "000000").slice(0, 6) || "0");
}

export function formatUsdc(micros: bigint): string {
  const neg = micros < 0n;
  const abs = neg ? -micros : micros;
  const frac = (abs % MICROS).toString().padStart(6, "0").replace(/0+$/, "");
  const s = frac ? `${abs / MICROS}.${frac}` : `${abs / MICROS}`;
  return neg ? `-${s}` : s;
}
