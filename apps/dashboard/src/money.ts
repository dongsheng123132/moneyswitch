// Shared money / formatting helpers.
//
// All aggregation across decimal-string USDC amounts is done in BigInt
// micro-USDC (1e6 scale) to avoid floating point accumulation error —
// per task constraint "金额用 BigInt micro-USDC 计算，禁止浮点累加".

const MICRO = 1_000_000n;

/** Parse a decimal string amount (e.g. "1.234567") into micro-USDC BigInt. */
export function toMicros(value: string | null | undefined): bigint {
  if (!value) return 0n;
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholeRaw, fracRaw = ""] = unsigned.split(".");
  const whole = wholeRaw || "0";
  const frac = (fracRaw + "000000").slice(0, 6);
  let micros: bigint;
  try {
    micros = BigInt(whole || "0") * MICRO + BigInt(frac || "0");
  } catch {
    return 0n;
  }
  return negative ? -micros : micros;
}

/** Format micro-USDC BigInt back to a trimmed decimal string. */
export function fromMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICRO;
  const frac = (abs % MICRO).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** Sum an array of decimal-string amounts using integer micro-USDC math. */
export function sumMicros(values: Array<string | null | undefined>): bigint {
  let total = 0n;
  for (const v of values) total += toMicros(v);
  return total;
}

export function sumDecimalStrings(values: Array<string | null | undefined>): string {
  return fromMicros(sumMicros(values));
}

/** Ratio used/limit in [0,1], computed on BigInt to avoid float division surprises for display. */
export function ratioMicros(usedMicros: bigint, limitMicros: bigint): number {
  if (limitMicros <= 0n) return 0;
  if (usedMicros <= 0n) return 0;
  if (usedMicros >= limitMicros) return 1;
  // Scale to permille for a stable integer division, then to [0,1].
  const permille = (usedMicros * 1000n) / limitMicros;
  return Math.min(1, Math.max(0, Number(permille) / 1000));
}

/** Format a USDC decimal-string amount for display with fixed 2-6 decimals. */
export function formatUsdc(value: string | null | undefined, opts?: { maxDecimals?: number }): string {
  const micros = toMicros(value ?? "0");
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICRO;
  const maxDecimals = opts?.maxDecimals ?? 6;
  const fracFull = (abs % MICRO).toString().padStart(6, "0");
  const frac = fracFull.slice(0, maxDecimals).replace(/0+$/, "") || "";
  return `${negative ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}

export function formatUsd2(value: string | null | undefined): string {
  const micros = toMicros(value ?? "0");
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICRO;
  const cents = ((abs % MICRO) * 100n) / MICRO;
  return `${negative ? "-" : ""}$${whole.toString()}.${cents.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatCountdown(iso: string, now: Date = new Date()): string {
  const target = new Date(iso).getTime();
  const diffMs = target - now.getTime();
  if (diffMs <= 0) return "expired";
  const totalSec = Math.floor(diffMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min >= 60) {
    const hr = Math.floor(min / 60);
    return `${hr}h ${min % 60}m left`;
  }
  return `${min}m ${sec.toString().padStart(2, "0")}s left`;
}

// ---------------------------------------------------------------------------
// Agent identity (avatar initial + color) derived from the MoneyKey name.
// ---------------------------------------------------------------------------

interface AgentIdentity {
  initial: string;
  color: string;
}

const KNOWN_AGENTS: Array<{ match: RegExp; initial: string; color: string }> = [
  { match: /claude/i, initial: "C", color: "#d97757" },
  { match: /codex/i, initial: "X", color: "#10a37f" },
  { match: /u-?king/i, initial: "U", color: "#7c5cff" },
  { match: /openclaw/i, initial: "O", color: "#ef5b5b" },
  { match: /workbuddy/i, initial: "W", color: "#e0b13c" },
];

const FALLBACK_COLORS = ["#4f7cff", "#34c78e", "#e0b13c", "#ef5b5b", "#7c5cff", "#22b8cf"];

export function agentIdentity(name: string): AgentIdentity {
  for (const agent of KNOWN_AGENTS) {
    if (agent.match.test(name)) return { initial: agent.initial, color: agent.color };
  }
  const trimmed = name.trim();
  const initial = trimmed ? trimmed[0].toUpperCase() : "?";
  let hash = 0;
  for (let i = 0; i < trimmed.length; i++) hash = (hash * 31 + trimmed.charCodeAt(i)) | 0;
  const color = FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
  return { initial, color };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/**
 * Turns rows into CSV text. A value holding a comma, a quote, a line break or a carriage return is wrapped in double quotes.
 *
 * A spreadsheet runs a cell that starts with = + - @ (or a tab or carriage return) as a formula, and some of these values come from
 * outside (a paid URL, a key name). So such a value is written with a single quote in front: the spreadsheet then shows it as text.
 * A value that merely starts with one of those characters, like "-1", gets the quote as well.
 */
export function toCsv(headers: string[], rows: Array<Array<string | number>>): string {
  const escape = (v: string | number) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map(escape).join(","), ...rows.map((r) => r.map(escape).join(","))];
  return lines.join("\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    try {
      return new URL(url, "http://placeholder.local").pathname;
    } catch {
      return "";
    }
  }
}

export function shortAddr(addr: string | null | undefined, lead = 6, tail = 4): string {
  if (!addr) return "-";
  if (addr.length <= lead + tail + 2) return addr;
  return `${addr.slice(0, lead)}...${addr.slice(-tail)}`;
}

export function isTodayUtc(iso: string, now: Date = new Date()): boolean {
  const d = new Date(iso);
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

/** UTC day key (YYYY-MM-DD) used to bucket payments for the 7-day chart. */
export function utcDayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}
