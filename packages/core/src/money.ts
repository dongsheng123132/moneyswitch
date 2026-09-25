/**
 * All money values in MoneySwitch are integer micro-USDC (6 decimals) and are
 * represented as `bigint` in application code. Floating point is never used
 * for money arithmetic. Conversion to/from the SQLite INTEGER column happens
 * only at the packages/db boundary (see dbNumberToMicros / microsToDbNumber).
 */

export const MICROS_PER_USDC = 1_000_000n;

/** Parses a decimal USDC string like "0.01" or "5" into integer micro-USDC bigint. Throws on invalid input. */
export function parseUsdcToMicros(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new Error(`INVALID_AMOUNT: "${input}" is not a valid decimal USDC amount`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return BigInt(whole) * MICROS_PER_USDC + BigInt(fracPadded || "0");
}

/** Formats integer micro-USDC bigint into a decimal string like "0.01". */
export function formatMicrosToUsdc(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICROS_PER_USDC;
  const frac = (abs % MICROS_PER_USDC).toString().padStart(6, "0");
  const fracTrimmed = frac.replace(/0+$/, "");
  const s = fracTrimmed.length > 0 ? `${whole}.${fracTrimmed}` : `${whole}`;
  return negative ? `-${s}` : s;
}

/** Converts a DB-stored INTEGER (JS number, safe up to 2^53) to bigint micro-USDC. */
export function dbNumberToMicros(n: number): bigint {
  return BigInt(n);
}

/** Converts an application bigint micro-USDC value to a DB-storable JS number. */
export function microsToDbNumber(micros: bigint): number {
  if (micros > BigInt(Number.MAX_SAFE_INTEGER) || micros < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error("Amount exceeds safe integer range for SQLite storage");
  }
  return Number(micros);
}
