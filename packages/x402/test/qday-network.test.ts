import { describe, it, expect, afterEach, vi } from "vitest";
import { domainSeparator } from "viem";

const ENV_KEYS = [
  "MONEYSWITCH_NETWORKS",
  "MONEYSWITCH_DEFAULT_NETWORK",
  "MONEYSWITCH_MAINNET_ENABLED",
  "MONEYSWITCH_QDAY_TESTNET_CAIP2",
  "MONEYSWITCH_QDAY_TESTNET_RPC_URL",
  "MONEYSWITCH_QDAY_TESTNET_TUSD8_ADDRESS",
  "MONEYSWITCH_QDAY_TESTNET_TUSD8_NAME",
  "MONEYSWITCH_QDAY_TESTNET_TUSD8_VERSION",
  "MONEYSWITCH_QDAY_TESTNET_TUSD8_DECIMALS",
  "MONEYSWITCH_QDAY_FACILITATOR_URL",
  "MONEYSWITCH_QDAY_TESTNET_LABEL",
  "MONEYSWITCH_QDAY_TESTNET_EXPLORER_BASE",
];
const original: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) original[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

async function freshNetworks() {
  vi.resetModules();
  return import("../src/networks.js");
}

/**
 * These assertions are the chain facts, not doc quotes. They were read from QDay Aevum (chain 44005) on 2026-11-10:
 * `eth_chainId` = 0xabe5, tUSD8 answers name()/version()/decimals() and its implementation carries EIP-3009
 * transferWithAuthorization + authorizationState. If a future edit changes the address or the domain, the
 * DOMAIN_SEPARATOR assertion below fails before any payment can be mis-signed.
 */
const ONCHAIN_DOMAIN_SEPARATOR = "0x7838e6c46f8f9874236c9747d9896552a03d22c7c3e701b198879de2cb658022";

describe("QDay Aevum testnet network config", () => {
  it("pins the testnet facts (chain 44005, tUSD8, 6 decimals, Aevum explorer)", async () => {
    delete process.env.MONEYSWITCH_QDAY_TESTNET_CAIP2;
    delete process.env.MONEYSWITCH_QDAY_TESTNET_TUSD8_ADDRESS;
    delete process.env.MONEYSWITCH_QDAY_TESTNET_TUSD8_DECIMALS;
    const n = await freshNetworks();
    expect(n.QDAY_TESTNET).toMatchObject({
      caip2: "eip155:44005",
      rpcUrl: "https://rpc-test.qday.info",
      usdcAddress: "0x456569838f1d43009A91ebA4263147Afd7233483",
      usdcDomainName: "tUSD8",
      usdcDomainVersion: "2",
      usdcDecimals: 6,
      kind: "testnet",
      label: "QDay Aevum testnet",
      explorerBase: "https://explorer-test.qday.info",
    });
    expect(n.QDAY_TESTNET.family).toBeUndefined(); // an EVM chain: no family field, exactly like TESTNET/BASE
    expect(n.getNetwork("eip155:44005")).toBe(n.QDAY_TESTNET);
    expect(n.explorerUrl(n.QDAY_TESTNET, "tx", "0xabc")).toBe("https://explorer-test.qday.info/tx/0xabc");
    expect(n.explorerUrl(n.QDAY_TESTNET, "address", "0xdef")).toBe("https://explorer-test.qday.info/address/0xdef");
  });

  it("its EIP-712 domain hashes to tUSD8's on-chain DOMAIN_SEPARATOR", async () => {
    const n = await freshNetworks();
    const domain = {
      name: n.QDAY_TESTNET.usdcDomainName,
      version: n.QDAY_TESTNET.usdcDomainVersion,
      chainId: 44005,
      verifyingContract: n.QDAY_TESTNET.usdcAddress as `0x${string}`,
    };
    // viem builds the domain separator the same way the token does; a mismatch would make every signature invalid.
    expect(domainSeparator({ domain })).toBe(ONCHAIN_DOMAIN_SEPARATOR);
  });

  it("is not enabled by default and needs an explicit MONEYSWITCH_NETWORKS opt-in", async () => {
    delete process.env.MONEYSWITCH_NETWORKS;
    delete process.env.MONEYSWITCH_MAINNET_ENABLED;
    let n = await freshNetworks();
    expect(n.getEnabledNetworks().map((x) => x.caip2)).toEqual(["eip155:10143"]);

    process.env.MONEYSWITCH_NETWORKS = "eip155:44005";
    n = await freshNetworks();
    expect(n.getEnabledNetworks()).toEqual([n.QDAY_TESTNET]);
    expect(n.getActiveNetwork()).toEqual(n.QDAY_TESTNET);
    expect(n.getEnabledNetworksFor("testnet")).toEqual([n.QDAY_TESTNET]);
    // tUSD8 has no value: a mainnet key must never be able to pay on QDay, and a QDay-only instance has no mainnet at all.
    expect(n.getEnabledNetworksFor("mainnet")).toEqual([]);
  });

  it("keeps the self-hosted facilitator address overridable, defaulting to the local one", async () => {
    delete process.env.MONEYSWITCH_QDAY_FACILITATOR_URL;
    let n = await freshNetworks();
    expect(n.QDAY_TESTNET.facilitatorUrl).toBe("http://127.0.0.1:4098");
    process.env.MONEYSWITCH_QDAY_FACILITATOR_URL = "https://facilitator.example/qday";
    n = await freshNetworks();
    expect(n.QDAY_TESTNET.facilitatorUrl).toBe("https://facilitator.example/qday");
  });
});
