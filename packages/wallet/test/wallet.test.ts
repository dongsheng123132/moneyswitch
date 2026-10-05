import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWalletDriver } from "../src/index.js";
import { Wallet as EthersWallet } from "ethers";
import { writeLegacyPasswordWallet } from "./legacy.js";

let tmpDir: string;

// No OS-level ACL work here (that is exercised for real in protect.win32.test.ts / protect.posix.test.ts).
const drv = (dir = tmpDir) => new LocalWalletDriver(dir, { protect: false });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-wallet-test-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("LocalWalletDriver", () => {
  it("reads balances through the shared fetch transport and rejects RPC errors as unknown", async () => {
    const driver = drv();
    const { address } = await driver.createWithPhrase();
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (520000n).toString(16).padStart(64, "0") })));
    vi.stubGlobal("fetch", request);
    expect(await driver.getUsdcBalance("https://rpc.example.test", address)).toBe(520000n);
    const sent = JSON.parse(request.mock.calls[0][1].body);
    expect(sent.method).toBe("eth_call");
    expect(sent.params[0].data.toLowerCase()).toBe("0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0"));
    expect(request.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    request.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: -1 } })));
    await expect(driver.getUsdcBalance("https://rpc.example.test", address)).rejects.toThrow("Invalid USDC balance");
  });

  it("a balance read stops its RPC request when the caller's signal is aborted (and is still bounded without one)", async () => {
    const driver = drv();
    const { address } = await driver.createWithPhrase();
    const seen: AbortSignal[] = [];
    // an RPC that never answers: the request ends only when its signal says so
    const hang = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      seen.push(init.signal);
      return new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    });
    vi.stubGlobal("fetch", hang);

    const caller = new AbortController();
    const read = driver.getUsdcBalanceOf(address, "https://rpc.example.test", address, caller.signal);
    const outcome = read.then(() => "answered", () => "rejected");
    await Promise.resolve();
    expect(seen[0].aborted, "still waiting").toBe(false);
    caller.abort(new Error("gave up"));
    expect(await outcome).toBe("rejected");
    expect(seen[0].aborted, "the request itself was cancelled, not just forgotten").toBe(true);

    void driver.getUsdcBalanceOf(address, "https://rpc.example.test", address).catch(() => undefined);
    await Promise.resolve();
    expect(seen[1], "without a caller signal the 15 s bound is still there").toBeInstanceOf(AbortSignal);
    expect(seen[1].aborted).toBe(false);
  });

  it("concurrent creates publish only one complete wallet: the keystore and its own unlock secret, nothing else", async () => {
    const a = drv();
    const b = drv();
    const results = await Promise.allSettled([a.createWithPhrase(), b.createWithPhrase()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ address: string }>;
    expect(fs.readdirSync(tmpDir).sort()).toEqual([`wallet-unlock-${winner.value.address.toLowerCase()}.secret`, "wallet.json"]);
    const restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(winner.value.address);
  });

  it("creates a wallet that a restarted process unlocks by itself, and that can sign", async () => {
    const driver = drv();
    expect(driver.hasKeystore()).toBe(false);
    const { address } = await driver.createWithPhrase();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(fs.existsSync(driver.keystorePath)).toBe(true);

    // Fresh driver instance simulating a process restart: locked until the startup unlock ran.
    const driver2 = drv();
    expect(driver2.isUnlocked()).toBe(false);
    expect(driver2.leaseSigner()).toBeNull();
    expect((await driver2.unlockOnStartup({})).unlocked).toBe(true);
    expect(driver2.isUnlocked()).toBe(true);
    const lease = driver2.leaseSigner();
    expect(lease?.signer.address).toBe(address);
    lease?.release();
  });

  it("a legacy password wallet stays locked without its password, and the startup password opens it", async () => {
    const legacy = await writeLegacyPasswordWallet(tmpDir, "right-password");
    const wrong = drv();
    expect(wrong.protection()).toBe("password");
    expect(await wrong.unlockOnStartup({ password: "wrong-password" })).toEqual({ unlocked: false, attempts: [{ source: "env_or_file", ok: false, reason: "env_wrong" }] });
    expect(wrong.isUnlocked()).toBe(false);
    expect(wrong.leaseSigner()).toBeNull();

    const right = drv();
    expect((await right.unlockOnStartup({ password: "right-password" })).unlocked).toBe(true);
    expect(right.getAddress()).toBe(legacy.address);
  });

  it("signTypedData produces a valid signature recoverable to the wallet address", async () => {
    const { verifyTypedData } = await import("ethers");
    const driver = drv();
    const { address } = await driver.createWithPhrase();
    const lease = driver.leaseSigner()!;
    const signer = lease.signer;
    const domain = { name: "USDC", version: "2", chainId: 10143, verifyingContract: "0x534b2f3A21130d7a60830c2Df862319e593943A3" };
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    };
    const message = {
      from: address,
      to: EthersWallet.createRandom().address,
      value: 10000n,
      validAfter: 0n,
      validBefore: 9999999999n,
      nonce: "0x" + "11".repeat(32),
    };
    const sig = await signer.signTypedData({ domain, types, primaryType: "TransferWithAuthorization", message });
    lease.release();
    const recovered = verifyTypedData(domain, types, message, sig);
    expect(recovered.toLowerCase()).toBe(address.toLowerCase());
  });
});
