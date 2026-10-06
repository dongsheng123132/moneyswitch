// The shape of an approval PIN (SPEC.md §3), as the Dashboard checks it before it asks the server. The server decides (packages/core
// src/approval-pin.ts); this is the same rule so a form can say "too easy to guess" without a round trip. test/approvalPin.test.ts runs this
// function and the server's own (packages/core/src/weak-pin.ts) over every 4-, 5- and 6-digit PIN and fails when they differ.

/** 4 to 6 digits. */
export const PIN_RE = /^[0-9]{4,6}$/;

/** Wrong tries that lock a key's PIN (the server's APPROVAL_PIN_MAX_FAILURES): shown as "N wrong tries (5 lock it)". */
export const PIN_MAX_FAILURES = 5;

const COMMON_PINS = new Set([
  "1212", "1004", "2000", "6969", "1122", "2580", "1313", "1010", "0101", "5683", "0852", "2468", "1357", "1478", "7410", "8520", "2001", "2112",
]);

/** Every digit the same, a straight +1 / -1 run with no wrap, or one of the most common 4-digit PINs. `pin` is 4-6 digits. */
export function isWeakApprovalPin(pin: string): boolean {
  const digits = [...pin].map(Number);
  if (digits.every((d) => d === digits[0])) return true;
  const step = digits[1] - digits[0];
  if ((step === 1 || step === -1) && digits.every((d, i) => i === 0 || d - digits[i - 1] === step)) return true;
  return COMMON_PINS.has(pin);
}

/** What is wrong with a typed PIN: "format" (not 4-6 digits), "weak" (too easy to guess), or null. An empty field is fine: the server then makes one. */
export function pinProblem(pin: string): "format" | "weak" | null {
  if (!pin) return null;
  if (!PIN_RE.test(pin)) return "format";
  return isWeakApprovalPin(pin) ? "weak" : null;
}
