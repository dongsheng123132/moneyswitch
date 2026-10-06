/**
 * Approval PINs that are too easy to guess (SPEC.md §3): refused wherever a PIN is set. Pure, no imports, so the Dashboard keeps an identical
 * copy (apps/dashboard/src/weakPin.ts) for its form check, and a test there runs both over every 4-digit PIN.
 *
 * Weak: every digit the same (1111, 000000); a straight run of +1 or -1 steps with no wrap (1234, 2345, 0123, 4321, 123456, 654321); one of
 * the most common 4-digit PINs.
 */
const COMMON_PINS = new Set([
  "1212", "1004", "2000", "6969", "1122", "2580", "1313", "1010", "0101", "5683", "0852", "2468", "1357", "1478", "7410", "8520", "2001", "2112",
]);

/** `pin` is already 4-6 digits (see isValidApprovalPin). */
export function isWeakApprovalPin(pin: string): boolean {
  const digits = [...pin].map(Number);
  if (digits.every((d) => d === digits[0])) return true;
  const step = digits[1] - digits[0];
  if ((step === 1 || step === -1) && digits.every((d, i) => i === 0 || d - digits[i - 1] === step)) return true;
  return COMMON_PINS.has(pin);
}
