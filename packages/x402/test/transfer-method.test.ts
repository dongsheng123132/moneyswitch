import { describe, it, expect } from "vitest";
import { usesEip3009 } from "../src/client.js";

/**
 * The startup sweep reads a reservation without auth_* as "never signed". @x402/evm signs a Permit2 authorization (no
 * `authorization` in the payload) for extra.assetTransferMethod = "permit2", so only EIP-3009 requirements may be paid.
 */
describe("usesEip3009: the only transfer method MoneySwitch signs", () => {
  it("accepts a requirement that does not name a method (EIP-3009 is the x402 default) or names \"eip3009\"", () => {
    expect(usesEip3009({})).toBe(true);
    expect(usesEip3009({ extra: undefined })).toBe(true);
    expect(usesEip3009({ extra: null })).toBe(true);
    expect(usesEip3009({ extra: {} })).toBe(true);
    expect(usesEip3009({ extra: { name: "USDC", version: "2" } })).toBe(true);
    expect(usesEip3009({ extra: { assetTransferMethod: undefined } })).toBe(true);
    expect(usesEip3009({ extra: { assetTransferMethod: null } })).toBe(true); // the SDK reads null as the default too
    expect(usesEip3009({ extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } })).toBe(true);
  });

  it("refuses permit2 and anything it does not know", () => {
    expect(usesEip3009({ extra: { assetTransferMethod: "permit2" } })).toBe(false);
    expect(usesEip3009({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } })).toBe(false);
    for (const odd of ["PERMIT2", "Permit2", "eip2612", "permit3", "", " eip3009", "eip3009 ", 3009, true, {}, []]) {
      expect(usesEip3009({ extra: { assetTransferMethod: odd } }), `assetTransferMethod ${JSON.stringify(odd)}`).toBe(false);
    }
  });
});
