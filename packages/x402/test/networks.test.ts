import { describe, it, expect, afterEach, vi } from "vitest";

const ENV_KEYS = [
  "MONEYSWITCH_MAINNET_ENABLED",
  "MONEYSWITCH_TESTNET_LABEL",
  "MONEYSWITCH_TESTNET_EXPLORER_BASE",
  "MONEYSWITCH_MAINNET_LABEL",
  "MONEYSWITCH_MAINNET_EXPLORER_BASE",
  "MONEYSWITCH_MAINNET_RPC_URL",
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
