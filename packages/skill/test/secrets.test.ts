import { describe, it, expect } from "vitest";
import { checkPayTo, checkKeyInput, detectSecretShape } from "../src/secrets.js";

const CHECKSUMMED = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

describe("pay_to validation (SPEC-v0.5 §1 防呆)", () => {
  it("accepts a checksummed address", () => {
    expect(checkPayTo(CHECKSUMMED)).toEqual({ ok: true, address: CHECKSUMMED });
  });
  it("accepts all-lower-case and returns the checksummed form", () => {
    expect(checkPayTo(CHECKSUMMED.toLowerCase())).toEqual({ ok: true, address: CHECKSUMMED });
    expect(checkPayTo("  " + CHECKSUMMED.toLowerCase() + " ")).toMatchObject({ ok: true });
  });
  it("rejects a mixed-case address with a wrong checksum", () => {
    const bad = CHECKSUMMED.replace("A3", "a3").replace("b2f", "B2f");
    expect(checkPayTo(bad)).toMatchObject({ ok: false, code: "BAD_CHECKSUM" });
  });
  it("rejects a MoneyKey, admin token, private key, mnemonic", () => {
    expect(checkPayTo("mk_live_abcDEF1234567890")).toMatchObject({ ok: false, code: "LOOKS_LIKE_MONEYKEY" });
    expect(checkPayTo("Bearer mk_live_abc")).toMatchObject({ ok: false, code: "LOOKS_LIKE_MONEYKEY" });
    expect(checkPayTo("ms_admin_abc")).toMatchObject({ ok: false, code: "LOOKS_LIKE_ADMIN_TOKEN" });
    expect(checkPayTo("0x" + "ab".repeat(32))).toMatchObject({ ok: false, code: "LOOKS_LIKE_PRIVATE_KEY" });
    expect(checkPayTo("ab".repeat(32))).toMatchObject({ ok: false, code: "LOOKS_LIKE_PRIVATE_KEY" });
    const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    expect(checkPayTo(phrase)).toMatchObject({ ok: false, code: "LOOKS_LIKE_MNEMONIC" });
  });
  it("rejects garbage and the zero address", () => {
    expect(checkPayTo("")).toMatchObject({ ok: false, code: "EMPTY" });
    expect(checkPayTo("0x1234")).toMatchObject({ ok: false, code: "NOT_AN_ADDRESS" });
    expect(checkPayTo("0x" + "0".repeat(40))).toMatchObject({ ok: false, code: "ZERO_ADDRESS" });
  });
  it("key inputs reject a pasted address / private key", () => {
    expect(checkKeyInput(CHECKSUMMED)).toBe("LOOKS_LIKE_ADDRESS");
    expect(checkKeyInput("0x" + "cd".repeat(32))).toBe("LOOKS_LIKE_PRIVATE_KEY");
    expect(checkKeyInput("mk_live_abc")).toBeNull();
    expect(detectSecretShape(CHECKSUMMED)).toBeNull();
  });
});
