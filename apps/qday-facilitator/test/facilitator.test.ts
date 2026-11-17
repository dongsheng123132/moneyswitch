import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { parseUnits, type Address, type Hex } from "viem";
import {
  authorizationTypes,
  createQDayFacilitator,
  type ChainReader,
  type PaymentPayload,
  type PaymentRequirements,
} from "../src/server.js";

/**
 * These are offline tests: the chain reads are injected, so every refusal path can be exercised without a node, an anvil
 * fork, a faucet or tQDAY. The real settlement is covered by `scripts/e2e-anvil-fork.mjs` (anvil fork of QDay Aevum) and
 * by the live testnet run described in README.md.
 */

const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483" as Address;
const PAY_TO = "0x1111111111111111111111111111111111111111" as Address;
const DOMAIN = {
  name: "tUSD8",
  version: "2",
  chainId: 44005,
  verifyingContract: TUSD8,
} as const;

const NOW = 1_800_000_000; // pinned: validFrom/validBefore windows below are relative to this
const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const impostor = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

function reader(overrides: Partial<{ used: boolean | null; balance: bigint | null; now: number }> = {}): ChainReader {
  return {
    authorizationState: async () => overrides.used ?? false,
    balanceOf: async () => overrides.balance ?? parseUnits("1000", 6),
    timestamp: async () => overrides.now ?? NOW,
  };
}

async function authorization(
  overrides: Partial<{ value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex; to: Address }> = {},
  signer = payer
) {
  const message = {
    from: payer.address,
    to: overrides.to ?? PAY_TO,
    value: overrides.value ?? parseUnits("12.5", 6),
    validAfter: overrides.validAfter ?? 0n,
    validBefore: overrides.validBefore ?? BigInt(NOW + 3600),
    nonce: overrides.nonce ?? (`0x${"11".repeat(32)}` as Hex),
  };
  const signature = await signer.signTypedData({
    domain: DOMAIN,
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message,
  } as never);
  return { message, signature };
}

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:44005",
    asset: TUSD8,
    amount: parseUnits("12.5", 6).toString(),
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "tUSD8", version: "2" },
    ...overrides,
  };
}

async function payload(
  auth: Awaited<ReturnType<typeof authorization>>,
  reqs = requirements()
): Promise<PaymentPayload> {
  return {
    x402Version: 2,
    accepted: reqs,
    payload: {
      signature: auth.signature as Hex,
      authorization: {
        from: auth.message.from as Address,
        to: auth.message.to as Address,
        value: auth.message.value.toString(),
        validAfter: auth.message.validAfter.toString(),
        validBefore: auth.message.validBefore.toString(),
        nonce: auth.message.nonce,
      },
    },
  };
}

describe("QDay facilitator /verify", () => {
  it("accepts a correctly signed tUSD8 EIP-3009 authorization", async () => {
    const f = createQDayFacilitator({ reader: reader(), now: () => NOW });
    const p = await payload(await authorization());
    await expect(f.verify(p, requirements())).resolves.toEqual({ isValid: true, payer: payer.address });
    await f.close();
  });

  it("rejects a signature made by anyone other than the payer", async () => {
    const f = createQDayFacilitator({ reader: reader(), now: () => NOW });
    const p = await payload(await authorization({}, impostor));
    expect(await f.verify(p, requirements())).toMatchObject({ isValid: false, invalidReason: "invalid_signature" });
    await f.close();
  });

  it("refuses a foreign network, a foreign asset and a malformed request", async () => {
    const f = createQDayFacilitator({ reader: reader(), now: () => NOW });
    const p = await payload(await authorization());
    expect(await f.verify(p, requirements({ network: "eip155:10143" }))).toMatchObject({
      invalidReason: "unsupported_network: eip155:10143",
    });
    expect(await f.verify(p, requirements({ asset: PAY_TO }))).toMatchObject({ invalidReason: "unsupported_asset" });
    expect(await f.verify(p, requirements({ scheme: "upto" }))).toMatchObject({ invalidReason: "unsupported_scheme" });
    await f.close();
  });

  it("rejects an amount that does not match the quote, and a zero amount", async () => {
    const f = createQDayFacilitator({ reader: reader(), now: () => NOW });
    const p = await payload(await authorization({ value: parseUnits("1", 6) }));
    expect(await f.verify(p, requirements())).toMatchObject({ invalidReason: "amount_mismatch" });
    const zero = await payload(await authorization({ value: 0n }), requirements({ amount: "0" }));
    expect(await f.verify(zero, requirements({ amount: "0" }))).toMatchObject({ invalidReason: "zero_amount" });
    await f.close();
  });

  it("rejects an authorization paid to somebody else, and one signed by the payee", async () => {
    const f = createQDayFacilitator({ reader: reader(), now: () => NOW });
    const elsewhere = "0x2222222222222222222222222222222222222222" as Address;
    const p = await payload(await authorization({ to: elsewhere }));
    expect(await f.verify(p, requirements())).toMatchObject({ invalidReason: "payTo_mismatch" });
    await f.close();
  });

  it("uses the chain clock, not this machine's, for the validity window", async () => {
    const fresh = createQDayFacilitator({ reader: reader({ now: NOW }), now: () => NOW });
    const p = await payload(await authorization());
    expect(await fresh.verify(p, requirements())).toMatchObject({ isValid: true });
    await fresh.close();

    // A skewed local clock must not change the answer: only the node's timestamp counts.
    const skewed = createQDayFacilitator({ reader: reader({ now: NOW + 7200 }), now: () => NOW });
    expect(await skewed.verify(p, requirements())).toMatchObject({ invalidReason: "authorization_expired" });
    await skewed.close();
  });

  it("rejects not-yet-valid and already-used authorizations", async () => {
    const f = createQDayFacilitator({ reader: reader(), now: () => NOW });
    const future = await payload(await authorization({ validAfter: BigInt(NOW + 600) }));
    expect(await f.verify(future, requirements())).toMatchObject({ invalidReason: "authorization_not_yet_valid" });
    const p = await payload(await authorization());
    const usedReader = reader({ used: true });
    const g = createQDayFacilitator({ reader: usedReader, now: () => NOW });
    expect(await g.verify(p, requirements())).toMatchObject({ invalidReason: "authorization_already_used" });
    await f.close();
    await g.close();
  });

  it("rejects a payer that cannot cover the amount, but tolerates an unknown balance", async () => {
    const p = await payload(await authorization());
    const poor = createQDayFacilitator({ reader: reader({ balance: 1n }), now: () => NOW });
    expect(await poor.verify(p, requirements())).toMatchObject({ invalidReason: "insufficient_funds" });
    const unknown = createQDayFacilitator({ reader: reader({ balance: null }), now: () => NOW });
    expect(await unknown.verify(p, requirements())).toMatchObject({ isValid: true });
    await poor.close();
    await unknown.close();
  });

  it("rejects a seller that quotes the wrong EIP-712 domain for tUSD8", async () => {
    const f = createQDayFacilitator({ reader: reader(), now: () => NOW });
    const p = await payload(await authorization());
    expect(
      await f.verify(p, requirements({ extra: { name: "USDC", version: "2" } }))
    ).toMatchObject({ invalidReason: "token_name_mismatch" });
    expect(
      await f.verify(p, requirements({ extra: { name: "tUSD8", version: "1" } }))
    ).toMatchObject({ invalidReason: "token_version_mismatch" });
    await f.close();
  });
});

describe("QDay facilitator HTTP surface", () => {
  it("answers /supported with the QDay kind and /health without leaking the relayer key", async () => {
    const f = createQDayFacilitator({ reader: reader(), now: () => NOW });
    const supported = await f.app.inject({ method: "GET", url: "/supported" });
    expect(supported.statusCode).toBe(200);
    expect(supported.json()).toMatchObject({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:44005", extra: { name: "tUSD8", version: "2" } }],
    });

    const health = await f.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const body = health.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, network: "eip155:44005", chainId: 44005, settling: false, relayer: null });
    expect(JSON.stringify(body)).not.toMatch(/private|key/i);
    await f.close();
  });

  it("POST /verify speaks the @x402/core wire shape", async () => {
    const f = createQDayFacilitator({ reader: reader(), now: () => NOW });
    const p = await payload(await authorization());
    const ok = await f.app.inject({
      method: "POST",
      url: "/verify",
      payload: { paymentPayload: p, paymentRequirements: requirements() },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ isValid: true, payer: payer.address });

    const bad = await f.app.inject({ method: "POST", url: "/verify", payload: {} });
    expect(bad.statusCode).toBe(400);
    await f.close();
  });

  it("POST /settle refuses cleanly in read-only mode instead of pretending to settle", async () => {
    const f = createQDayFacilitator({ reader: reader(), now: () => NOW });
    const p = await payload(await authorization());
    const res = await f.app.inject({
      method: "POST",
      url: "/settle",
      payload: { paymentPayload: p, paymentRequirements: requirements() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: false, errorReason: "relayer_not_configured", network: "eip155:44005" });
    await f.close();
  });
});
