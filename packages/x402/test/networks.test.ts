import { describe, it, expect, afterEach, vi } from "vitest";

const ENV_KEYS = [
  "MONEYSWITCH_NETWORKS", "MONEYSWITCH_DEFAULT_NETWORK",
  "MONEYSWITCH_MAINNET_ENABLED",
  "MONEYSWITCH_TESTNET_LABEL",
  "MONEYSWITCH_TESTNET_EXPLORER_BASE",
  "MONEYSWITCH_MAINNET_LABEL",
  "MONEYSWITCH_MAINNET_EXPLORER_BASE",
  "MONEYSWITCH_MAINNET_RPC_URL",
  "MONEYSWITCH_SOLANA_MAINNET_RPC_URL",
  "MONEYSWITCH_SOLANA_MAINNET_FACILITATOR_URL",
  "MONEYSWITCH_SOLANA_DEVNET_RPC_URL",
];
const original: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) original[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

/** Re-imports networks.ts fresh so module-level env reads pick up per-test overrides. */
async function freshNetworks() {
  vi.resetModules();
  return import("../src/networks.js");
}

describe("networks", () => {
  it("Solana mainnet is explicit opt-in with canonical USDC, isolated key modes and mainnet explorer links", async () => {
    delete process.env.MONEYSWITCH_NETWORKS;
    delete process.env.MONEYSWITCH_MAINNET_ENABLED;
    delete process.env.MONEYSWITCH_SOLANA_MAINNET_RPC_URL;
    delete process.env.MONEYSWITCH_SOLANA_MAINNET_FACILITATOR_URL;
    const n = await freshNetworks();
    expect(n.SOLANA_MAINNET).toMatchObject({ family: "svm", caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", kind: "mainnet", rpcUrl: "https://api.mainnet-beta.solana.com", usdcAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", usdcDecimals: 6 });
    expect(n.getEnabledNetworks()).toEqual([n.TESTNET]);
    process.env.MONEYSWITCH_NETWORKS = `${n.SOLANA_DEVNET.caip2},${n.SOLANA_MAINNET.caip2}`;
    expect(n.getEnabledNetworksFor("mainnet")).toEqual([n.SOLANA_MAINNET]);
    expect(n.getEnabledNetworksFor("testnet")).toEqual([n.SOLANA_DEVNET]);
    expect(n.getEnabledNetworksFor(null)).toEqual([n.SOLANA_DEVNET]);
    expect(n.explorerUrl(n.SOLANA_MAINNET, "tx", "signature")).toBe("https://explorer.solana.com/tx/signature");
    expect(n.explorerUrl(n.SOLANA_DEVNET, "address", "owner")).toBe("https://explorer.solana.com/address/owner?cluster=devnet");
  });
  it("only enables explicitly configured chains and rejects unknown/default mismatches", async () => {
    const n = await freshNetworks();
    process.env.MONEYSWITCH_NETWORKS = "eip155:10143,eip155:84532";
    expect(n.getEnabledNetworks().map((x) => x.caip2)).toEqual(["eip155:10143", "eip155:84532"]);
    process.env.MONEYSWITCH_DEFAULT_NETWORK = "eip155:84532";
    expect(n.getActiveNetwork()).toBe(n.BASE_SEPOLIA);
    process.env.MONEYSWITCH_DEFAULT_NETWORK = "eip155:8453";
    expect(() => n.getActiveNetwork()).toThrow(/must be enabled/);
    process.env.MONEYSWITCH_NETWORKS = "eip155:56";
    expect(() => n.getEnabledNetworks()).toThrow(/Unsupported/);
  });
  it("TESTNET has the expected default label + explorer base", async () => {
    delete process.env.MONEYSWITCH_TESTNET_LABEL;
    delete process.env.MONEYSWITCH_TESTNET_EXPLORER_BASE;
    const { TESTNET } = await freshNetworks();
    expect(TESTNET.label).toBe("Monad testnet");
    expect(TESTNET.explorerBase).toBe("https://testnet.monadvision.com");
  });

  it("MAINNET has the expected default label, explorer base, and rpcUrl", async () => {
    delete process.env.MONEYSWITCH_MAINNET_LABEL;
    delete process.env.MONEYSWITCH_MAINNET_EXPLORER_BASE;
    delete process.env.MONEYSWITCH_MAINNET_RPC_URL;
    const { MAINNET } = await freshNetworks();
    expect(MAINNET.label).toBe("Monad mainnet");
    expect(MAINNET.explorerBase).toBe("https://monadvision.com");
    expect(MAINNET.rpcUrl).toBe("https://rpc.monad.xyz");
  });

  it("label/explorerBase are env-overridable", async () => {
    process.env.MONEYSWITCH_TESTNET_LABEL = "Custom testnet";
    process.env.MONEYSWITCH_TESTNET_EXPLORER_BASE = "https://example.com";
    process.env.MONEYSWITCH_MAINNET_LABEL = "Custom mainnet";
    process.env.MONEYSWITCH_MAINNET_EXPLORER_BASE = "https://example.org";
    const { TESTNET, MAINNET } = await freshNetworks();
    expect(TESTNET.label).toBe("Custom testnet");
    expect(TESTNET.explorerBase).toBe("https://example.com");
    expect(MAINNET.label).toBe("Custom mainnet");
    expect(MAINNET.explorerBase).toBe("https://example.org");
  });

  it("SOLANA_MAINNET carries the x402 mainnet id and Circle's mainnet USDC, and its explorer links have no devnet cluster", async () => {
    delete process.env.MONEYSWITCH_SOLANA_MAINNET_RPC_URL;
    const n = await freshNetworks();
    expect(n.SOLANA_MAINNET).toMatchObject({
      family: "svm",
      caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      usdcAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      usdcDecimals: 6,
      kind: "mainnet",
      label: "Solana mainnet",
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });
    expect(n.NETWORKS[n.SOLANA_MAINNET.caip2]).toBe(n.SOLANA_MAINNET);
    // Solana's explorer defaults to mainnet; only the Devnet link says which cluster.
    expect(n.explorerUrl(n.SOLANA_MAINNET, "address", "Addr")).toBe("https://explorer.solana.com/address/Addr");
    expect(n.explorerUrl(n.SOLANA_MAINNET, "tx", "Sig")).toBe("https://explorer.solana.com/tx/Sig");
    expect(n.explorerUrl(n.SOLANA_DEVNET, "address", "Addr")).toBe("https://explorer.solana.com/address/Addr?cluster=devnet");
    expect(n.explorerUrl(n.TESTNET, "tx", "0x1")).toBe(`${n.TESTNET.explorerBase}/tx/0x1`);
    process.env.MONEYSWITCH_SOLANA_MAINNET_RPC_URL = "https://rpc.example";
    expect((await freshNetworks()).SOLANA_MAINNET.rpcUrl).toBe("https://rpc.example");
  });

  it("Solana mainnet and Devnet can be enabled together; a key's type still keeps them apart", async () => {
    process.env.MONEYSWITCH_NETWORKS = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    const n = await freshNetworks();
    expect(n.getEnabledNetworks().map((x) => x.caip2)).toEqual([n.SOLANA_DEVNET.caip2, n.SOLANA_MAINNET.caip2]);
    expect(n.getEnabledNetworksFor("testnet").map((x) => x.caip2)).toEqual([n.SOLANA_DEVNET.caip2]);
    expect(n.getEnabledNetworksFor("mainnet").map((x) => x.caip2)).toEqual([n.SOLANA_MAINNET.caip2]);
    expect(n.isMainnetNetwork(n.getNetwork(n.SOLANA_MAINNET.caip2))).toBe(true);
    expect(n.isMainnetNetwork(n.getNetwork(n.SOLANA_DEVNET.caip2))).toBe(false);
  });

  it("isMainnet() reflects MAINNET_ENABLED; getActiveNetwork() defaults to TESTNET", async () => {
    delete process.env.MONEYSWITCH_MAINNET_ENABLED;
    const off = await freshNetworks();
    expect(off.isMainnet()).toBe(false);
    expect(off.getActiveNetwork()).toBe(off.TESTNET);

    process.env.MONEYSWITCH_MAINNET_ENABLED = "true";
    const on = await freshNetworks();
    expect(on.isMainnet()).toBe(true);
    expect(on.getActiveNetwork()).toBe(on.MAINNET);
  });
});
